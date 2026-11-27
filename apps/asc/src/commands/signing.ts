import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod";
import type { AscClient } from "../asc/client.ts";
import {
  decryptFile,
  encryptFile,
  openGitStore,
  type SigningStore,
} from "../asc/store.ts";
import {
  AscApiError,
  InvalidInputError,
  NotFoundError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import {
  CERTIFICATE_TYPES,
  needsDevices,
  PROFILE_TYPES,
  provisioning,
  requestCertificate,
  requestProfile,
} from "./provisioning.ts";

// A signing store keeps one team's certificates, private keys and profiles,
// each encrypted (see src/asc/store.ts), as:
//
//   certs/<CERTIFICATE_TYPE>/<certificate-id>.cer.enc   certificate (DER)
//   certs/<CERTIFICATE_TYPE>/<certificate-id>.key.enc   private key (PKCS#8 PEM)
//   profiles/<PROFILE_TYPE>/<bundle-identifier>/<profile-id>.mobileprovision.enc
//
// The passphrase comes from an environment variable and is never stored,
// printed or logged; decrypted files go only to the --out-dir the user names.

const PASSPHRASE_ENV = "ASC_SIGNING_PASSPHRASE";
const MIN_PASSPHRASE = 12;

interface Linkage {
  type: string;
  id: string;
}

interface Single<Attributes> {
  data: {
    id: string;
    attributes?: Attributes;
    relationships?: Record<
      string,
      { data?: Linkage | Linkage[] | null } | undefined
    >;
  };
}

interface Collection<Attributes> {
  data: Single<Attributes>["data"][];
}

const storeOptions = {
  gitUrl: z
    .string({ error: "Give the store's repository with --git-url." })
    .trim()
    .min(1, "Give the store's repository with --git-url."),
  branch: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._/-]{1,100}$/, "Must be a branch name.")
    .optional(),
};

/** A bundle identifier such as com.example.app; it is also a store directory. */
const identifierSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
    "Must be a bundle identifier such as com.example.app.",
  );

export const syncSigningInput = z.object({
  ...storeOptions,
  type: z.enum(CERTIFICATE_TYPES, {
    error: `Give --type, one of ${CERTIFICATE_TYPES.join(", ")}.`,
  }),
  profileType: z.enum(PROFILE_TYPES).optional(),
  bundleId: z.array(identifierSchema).optional(),
  outDir: z.string().trim().min(1).optional(),
  readonly: z.boolean().default(false),
  renewWithinDays: z.coerce.number().int().min(0).max(365).default(30),
  passphraseEnv: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Must be an environment variable name.")
    .default(PASSPHRASE_ENV),
  commonName: z.string().trim().min(1).max(64).default("App Store Connect CLI"),
  yes: z.boolean().default(false),
});

function readPassphrase(name: string): string {
  const passphrase = process.env[name];
  if (!passphrase) {
    throw new InvalidInputError(
      `Set the signing store passphrase in the ${name} environment variable.`,
    );
  }
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new InvalidInputError(
      `The passphrase in ${name} must be at least ${MIN_PASSPHRASE} characters.`,
    );
  }
  return passphrase;
}

/** Reads a resource, or undefined when Apple no longer has it. */
async function readOrGone<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) return undefined;
    throw error;
  }
}

function linkages(value: { data?: Linkage | Linkage[] | null } | undefined) {
  const data = value?.data;
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

interface CertificateState {
  id: string;
  type: string;
  expirationDate?: string;
  status: "current" | "create" | "created";
}

interface ProfileState {
  identifier: string;
  type: string;
  id?: string;
  name: string;
  uuid?: string;
  expirationDate?: string;
  status: "current" | "create" | "created";
}

/**
 * Makes the store hold a usable certificate of --type and, for each
 * --bundle-id, a usable --profile-type profile signed by it, creating or
 * renewing what is missing, expired, expiring within --renew-within-days or
 * no longer on Apple's side; then writes the decrypted files to --out-dir.
 * With --readonly it never creates anything and fails if the store is not
 * usable. Without `yes` (and without --readonly) it only reports the plan.
 */
export async function syncSigning(
  client: AscClient,
  input: z.output<typeof syncSigningInput>,
) {
  if (input.bundleId?.length && !input.profileType) {
    throw new InvalidInputError("Give --profile-type with --bundle-id.");
  }
  const passphrase = readPassphrase(input.passphraseEnv);
  const write = input.yes && !input.readonly;
  const now = Date.now();
  const threshold = now + input.renewWithinDays * 86_400_000;
  const usable = (expiration: string | undefined) =>
    expiration !== undefined && Date.parse(expiration) > threshold;

  return provisioning(async () => {
    const store = await openGitStore({
      url: input.gitUrl,
      branch: input.branch,
    });
    try {
      const removed: string[] = [];
      const created: string[] = [];
      const certDir = `certs/${input.type}`;
      const stored = await store.list(certDir);

      // The stored certificate that expires last, if Apple still has it.
      let certificate: CertificateState | undefined;
      let privateKeyPem: Uint8Array | undefined;
      let certificateDer: Uint8Array | undefined;
      for (const path of stored.filter((item) => item.endsWith(".cer.enc"))) {
        const id = fileName(path).replace(/\.cer\.enc$/, "");
        const keyPath = `${certDir}/${id}.key.enc`;
        const found = await readOrGone(() =>
          client.get<Single<{ expirationDate?: string }>>(
            `/v1/certificates/${id}`,
          ),
        );
        const expiration = found?.data.attributes?.expirationDate;
        if (!found || (expiration && Date.parse(expiration) <= now)) {
          removed.push(path, keyPath);
          continue;
        }
        if (
          stored.includes(keyPath) &&
          usable(expiration) &&
          (!certificate?.expirationDate ||
            Date.parse(expiration ?? "") >
              Date.parse(certificate.expirationDate))
        ) {
          certificate = {
            id,
            type: input.type,
            expirationDate: expiration,
            status: "current",
          };
        }
      }
      if (certificate) {
        certificateDer = await decryptFile(
          passphrase,
          `${certDir}/${certificate.id}.cer.enc`,
          await store.read(`${certDir}/${certificate.id}.cer.enc`),
        );
        privateKeyPem = await decryptFile(
          passphrase,
          `${certDir}/${certificate.id}.key.enc`,
          await store.read(`${certDir}/${certificate.id}.key.enc`),
        );
      } else if (input.readonly) {
        throw new InvalidInputError(
          `The signing store has no ${input.type} certificate valid for more than ${input.renewWithinDays} days. Run signing sync without --readonly where creating one is allowed. Nothing was changed.`,
        );
      } else if (write) {
        const issued = await requestCertificate(
          client,
          input.type,
          input.commonName,
        );
        certificate = {
          id: issued.certificate.id,
          type: input.type,
          expirationDate: issued.certificate.expirationDate,
          status: "created",
        };
        created.push(`certificate ${certificate.id}`);
        certificateDer = issued.content();
        privateKeyPem = new TextEncoder().encode(issued.privateKeyPem);
        await store.write(
          `${certDir}/${certificate.id}.cer.enc`,
          await encryptFile(
            passphrase,
            `${certDir}/${certificate.id}.cer.enc`,
            certificateDer,
          ),
        );
        await store.write(
          `${certDir}/${certificate.id}.key.enc`,
          await encryptFile(
            passphrase,
            `${certDir}/${certificate.id}.key.enc`,
            privateKeyPem,
          ),
        );
        // Kept right away: without the store, the new private key is lost.
        await saveStore(store, `Add ${input.type} certificate`, created);
      }

      const profiles: ProfileState[] = [];
      const profileFiles: { identifier: string; content: Uint8Array }[] = [];
      for (const identifier of input.bundleId ?? []) {
        const type = input.profileType as string;
        const name = `asc ${type} ${identifier}`;
        const directory = `profiles/${type}/${identifier}`;
        const paths = await store.list(directory);
        let current: ProfileState | undefined;
        let currentPath: string | undefined;
        for (const path of paths) {
          const id = fileName(path).replace(/\.mobileprovision\.enc$/, "");
          const found = await readOrGone(() =>
            client.get<
              Single<{
                name?: string;
                profileState?: string;
                expirationDate?: string;
                uuid?: string;
              }>
            >(`/v1/profiles/${id}`, {
              include: ["certificates"],
              "fields[profiles]": [
                "name",
                "profileState",
                "expirationDate",
                "uuid",
                "certificates",
              ],
              "limit[certificates]": 50,
            }),
          );
          const attributes = found?.data.attributes;
          const signedBy = linkages(found?.data.relationships?.certificates);
          if (
            !current &&
            certificate?.status === "current" &&
            attributes?.profileState === "ACTIVE" &&
            usable(attributes.expirationDate) &&
            signedBy.some((link) => link.id === certificate?.id)
          ) {
            current = {
              identifier,
              type,
              id,
              name: attributes.name ?? name,
              uuid: attributes.uuid,
              expirationDate: attributes.expirationDate,
              status: "current",
            };
            currentPath = path;
          } else {
            removed.push(path);
          }
        }
        if (current && currentPath) {
          profiles.push(current);
          profileFiles.push({
            identifier,
            content: await decryptFile(
              passphrase,
              currentPath,
              await store.read(currentPath),
            ),
          });
          continue;
        }
        if (input.readonly) {
          throw new InvalidInputError(
            `The signing store has no usable ${type} profile for ${identifier}. Run signing sync without --readonly where creating one is allowed. Nothing was changed.`,
          );
        }
        if (!write || !certificate) {
          profiles.push({ identifier, type, name, status: "create" });
          continue;
        }
        const bundle = await client.get<Collection<{ identifier?: string }>>(
          "/v1/bundleIds",
          { "filter[identifier]": identifier, limit: 200 },
        );
        const bundleId = bundle.data.find(
          (item) => item.attributes?.identifier === identifier,
        );
        if (!bundleId) {
          throw new NotFoundError(
            `${identifier} is not a registered bundle ID; register it with bundle-ids create.`,
          );
        }
        let devices: string[] = [];
        if (needsDevices(type)) {
          const enabled = await client.get<Collection<unknown>>("/v1/devices", {
            "filter[status]": "ENABLED",
            "filter[platform]": type.startsWith("MAC_") ? "MAC_OS" : "IOS",
            limit: 200,
          });
          devices = enabled.data.map((device) => device.id);
        }
        // Apple refuses a second profile with the same name: replace ours.
        const named = await client.get<Collection<unknown>>("/v1/profiles", {
          "filter[name]": name,
          limit: 200,
        });
        for (const old of named.data) {
          await client.delete(`/v1/profiles/${old.id}`);
        }
        const issued = await requestProfile(client, {
          name,
          type,
          bundleId: bundleId.id,
          certificates: [certificate.id],
          devices,
        });
        const content = issued.content();
        const path = `${directory}/${issued.profile.id}.mobileprovision.enc`;
        await store.write(path, await encryptFile(passphrase, path, content));
        created.push(`profile ${issued.profile.id}`);
        profiles.push({
          identifier,
          type,
          id: issued.profile.id,
          name,
          uuid: issued.profile.uuid,
          expirationDate: issued.profile.expirationDate,
          status: "created",
        });
        profileFiles.push({ identifier, content });
      }

      const result = {
        action: "signing-sync",
        readonly: input.readonly,
        certificate: certificate ?? {
          type: input.type,
          status: "create" as const,
        },
        profiles,
        removedFromStore: [...new Set(removed)],
      };
      if (!input.yes && !input.readonly) {
        return { dryRun: true, ...result };
      }

      let committed = false;
      if (write) {
        for (const path of removed) await store.remove(path);
        committed =
          (await saveStore(
            store,
            `Sync ${input.type} signing${input.profileType ? ` and ${input.profileType} profiles` : ""}`,
            created,
          )) || created.length > 0;
      }

      const files = await writeOutputs(input.outDir, {
        certificate,
        certificateDer,
        privateKeyPem,
        profileType: input.profileType,
        profileFiles,
      });
      return { dryRun: false, ...result, committed, files };
    } finally {
      await store.close();
    }
  });
}

/** Saves the store; if that fails after creating something, says what was made. */
async function saveStore(
  store: SigningStore,
  message: string,
  created: string[],
): Promise<boolean> {
  try {
    return await store.save(message);
  } catch (error) {
    if (created.length === 0) throw error;
    throw new UploadIncompleteError(
      `Created ${created.join(", ")} on App Store Connect, but the signing store was not updated. A new certificate's private key is then lost: revoke it with certificates revoke and run signing sync again.`,
      { cause: error },
    );
  }
}

/** Writes the decrypted files to the directory the user named, readable only by them. */
async function writeOutputs(
  outDir: string | undefined,
  outputs: {
    certificate: CertificateState | undefined;
    certificateDer: Uint8Array | undefined;
    privateKeyPem: Uint8Array | undefined;
    profileType: string | undefined;
    profileFiles: { identifier: string; content: Uint8Array }[];
  },
) {
  if (!outDir) return undefined;
  const directory = resolve(outDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const save = async (name: string, data: Uint8Array) => {
    const path = join(directory, name);
    await writeFile(path, data, { mode: 0o600 });
    await chmod(path, 0o600);
    return path;
  };
  const { certificate, certificateDer, privateKeyPem } = outputs;
  return {
    certificate:
      certificate && certificateDer
        ? await save(`${certificate.id}.cer`, certificateDer)
        : undefined,
    privateKey:
      certificate && privateKeyPem
        ? await save(`${certificate.id}.key`, privateKeyPem)
        : undefined,
    profiles: await Promise.all(
      outputs.profileFiles.map((file) =>
        save(
          `${file.identifier}.${outputs.profileType}.mobileprovision`,
          file.content,
        ),
      ),
    ),
  };
}

export const nukeSigningInput = z.object({
  ...storeOptions,
  type: z.enum(CERTIFICATE_TYPES, {
    error: `Give --type, one of ${CERTIFICATE_TYPES.join(", ")}.`,
  }),
  profileType: z.array(z.enum(PROFILE_TYPES)).optional(),
  yes: z.boolean().default(false),
});

async function removeAll(store: SigningStore, directories: string[]) {
  const paths: string[] = [];
  for (const directory of directories)
    paths.push(...(await store.list(directory)));
  return paths;
}

/**
 * Revokes every certificate of --type on App Store Connect, deletes every
 * profile of each --profile-type, and removes them from the store. Without
 * `yes`, lists what it would remove.
 */
export async function nukeSigning(
  client: AscClient,
  input: z.output<typeof nukeSigningInput>,
) {
  return provisioning(async () => {
    const store = await openGitStore({
      url: input.gitUrl,
      branch: input.branch,
    });
    try {
      const certificates = await client.get<
        Collection<{
          name?: string;
          serialNumber?: string;
          expirationDate?: string;
        }>
      >("/v1/certificates", {
        "filter[certificateType]": input.type,
        limit: 200,
      });
      const profiles = input.profileType?.length
        ? await client.get<Collection<{ name?: string; profileType?: string }>>(
            "/v1/profiles",
            { "filter[profileType]": input.profileType, limit: 200 },
          )
        : { data: [] };
      const storeFiles = await removeAll(store, [
        `certs/${input.type}`,
        ...(input.profileType ?? []).map((type) => `profiles/${type}`),
      ]);
      const plan = {
        action: "signing-nuke",
        certificates: certificates.data.map(({ id, attributes }) => ({
          id,
          name: attributes?.name,
          serialNumber: attributes?.serialNumber,
          expirationDate: attributes?.expirationDate,
        })),
        profiles: profiles.data.map(({ id, attributes }) => ({
          id,
          name: attributes?.name,
          type: attributes?.profileType,
        })),
        storeFiles,
      };
      if (!input.yes) {
        return {
          dryRun: true,
          ...plan,
          warning: `This revokes every ${input.type} certificate of the team, including ones made outside this store, and deletes the profiles listed. It cannot be undone: builds signed with these certificates can no longer be installed from these profiles, and every machine needs signing sync again.`,
        };
      }
      const done: string[] = [];
      try {
        for (const profile of plan.profiles) {
          await readOrGone(() => client.delete(`/v1/profiles/${profile.id}`));
          done.push(`profile ${profile.id}`);
        }
        for (const certificate of plan.certificates) {
          await readOrGone(() =>
            client.delete(`/v1/certificates/${certificate.id}`),
          );
          done.push(`certificate ${certificate.id}`);
        }
        for (const path of storeFiles) await store.remove(path);
        await store.save(`Remove ${input.type} signing`);
      } catch (error) {
        if (done.length === 0) throw error;
        throw new UploadIncompleteError(
          `Removed ${done.join(", ")} before stopping; run signing nuke again to finish.`,
          { cause: error },
        );
      }
      return { dryRun: false, ...plan };
    } finally {
      await store.close();
    }
  });
}
