import { access, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as z from "zod";
import { type AscClient, type AscQuery, pageInfo } from "../asc/client.ts";
import { createSigningRequest } from "../asc/csr.ts";
import {
  commaList,
  cursorSchema,
  idSchema,
  limitSchema,
} from "../schemas/common.ts";
import {
  AscApiError,
  InvalidInputError,
  NotFoundError,
  TeamKeyRequiredError,
  UnexpectedResponseError,
  UploadIncompleteError,
} from "../utils/errors.ts";

// Certificates, profiles, bundle IDs and devices are Apple's Provisioning
// endpoints. Private keys and profile contents only ever go to files the user
// names: never to stdout, errors or logs.

const certificateIdSchema = idSchema("certificates");
const profileIdSchema = idSchema("profiles");
const bundleIdIdSchema = idSchema("bundle-ids");
const deviceIdSchema = idSchema("devices");
/** An Apple enum value such as IOS_DISTRIBUTION; Apple checks the value itself. */
const enumValue = z
  .string()
  .trim()
  .regex(
    /^[A-Z0-9_]{1,60}$/,
    "Must be an uppercase value such as IOS_APP_STORE.",
  );
/** A file to create; an existing file is never overwritten. */
const outputPath = (option: string) =>
  z
    .string({ error: `Give the file to write with ${option}.` })
    .trim()
    .min(1, `Give the file to write with ${option}.`);

/** Certificate types `certificates create` makes: ones that need only a CSR. */
export const CERTIFICATE_TYPES = [
  "DEVELOPMENT",
  "DISTRIBUTION",
  "IOS_DEVELOPMENT",
  "IOS_DISTRIBUTION",
  "MAC_APP_DEVELOPMENT",
  "MAC_APP_DISTRIBUTION",
  "MAC_INSTALLER_DISTRIBUTION",
  "DEVELOPER_ID_APPLICATION",
  "DEVELOPER_ID_APPLICATION_G2",
] as const;

export const PROFILE_TYPES = [
  "IOS_APP_DEVELOPMENT",
  "IOS_APP_STORE",
  "IOS_APP_ADHOC",
  "IOS_APP_INHOUSE",
  "MAC_APP_DEVELOPMENT",
  "MAC_APP_STORE",
  "MAC_APP_DIRECT",
  "TVOS_APP_DEVELOPMENT",
  "TVOS_APP_STORE",
  "TVOS_APP_ADHOC",
  "TVOS_APP_INHOUSE",
  "MAC_CATALYST_APP_DEVELOPMENT",
  "MAC_CATALYST_APP_STORE",
  "MAC_CATALYST_APP_DIRECT",
] as const;

/** Development and ad hoc profiles name the devices they install on. */
export function needsDevices(profileType: string): boolean {
  return /_(DEVELOPMENT|ADHOC)$/.test(profileType);
}

interface Linkage {
  type: string;
  id: string;
}

interface Relationship {
  data?: Linkage | Linkage[] | null;
  meta?: { paging?: { total?: number } };
}

interface Resource<Attributes> {
  type: string;
  id: string;
  attributes?: Attributes;
  relationships?: Record<string, Relationship | undefined>;
}

interface Collection<Attributes> {
  data: Resource<Attributes>[];
  included?: Resource<Record<string, unknown>>[];
  links?: { self?: string; next?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

interface Single<Attributes> {
  data: Resource<Attributes>;
  included?: Resource<Record<string, unknown>>[];
}

interface CertificateAttributes {
  name?: string;
  displayName?: string;
  certificateType?: string;
  platform?: string | null;
  serialNumber?: string;
  expirationDate?: string;
  activationState?: string;
  certificateContent?: string;
}

interface ProfileAttributes {
  name?: string;
  platform?: string;
  profileType?: string;
  profileState?: string;
  uuid?: string;
  createdDate?: string;
  expirationDate?: string;
  profileContent?: string;
}

/**
 * Runs a Provisioning request; a 403 becomes a `[permission]` error saying
 * these endpoints need a team key, because individual keys cannot use them.
 */
export async function provisioning<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AscApiError && error.status === 403) {
      throw new TeamKeyRequiredError(error);
    }
    if (
      error instanceof UploadIncompleteError &&
      error.cause instanceof AscApiError &&
      error.cause.status === 403
    ) {
      throw new UploadIncompleteError(error.message, {
        cause: new TeamKeyRequiredError(error.cause),
      });
    }
    throw error;
  }
}

function linkages(relationship: Relationship | undefined): Linkage[] {
  const data = relationship?.data;
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function findIncluded(
  included: Resource<Record<string, unknown>>[] | undefined,
  link: Linkage,
): Record<string, unknown> | undefined {
  return included?.find(
    (item) => item.type === link.type && item.id === link.id,
  )?.attributes;
}

/** A certificate as the commands print it; its content is left out. */
function shapeCertificate(id: string, cert: CertificateAttributes | undefined) {
  return {
    id,
    name: cert?.name,
    displayName: cert?.displayName,
    type: cert?.certificateType,
    platform: cert?.platform,
    serialNumber: cert?.serialNumber,
    expirationDate: cert?.expirationDate,
    activationState: cert?.activationState,
  };
}

/** Fails, changing nothing, when the file exists: written files are never overwritten. */
async function ensureAbsent(path: string, option: string): Promise<string> {
  const absolute = resolve(path);
  const exists = await access(absolute).then(
    () => true,
    () => false,
  );
  if (exists) {
    throw new InvalidInputError(
      `${option} ${path} already exists; name a new file. Nothing was changed.`,
    );
  }
  return absolute;
}

/** Writes a new file readable only by the user; fails if it exists. */
async function writeNew(path: string, contents: string | Uint8Array) {
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
}

function decodeBase64(value: string | undefined, what: string): Uint8Array {
  if (!value) {
    throw new UnexpectedResponseError(
      `App Store Connect did not return the ${what}.`,
    );
  }
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/** Paging summary; only the links and meta matter. */
function paging(response: Pick<Collection<unknown>, "links" | "meta">) {
  return pageInfo({ data: [], links: response.links, meta: response.meta });
}

/** Every linkage of a to-many relationship, following pages. */
async function allLinkages(
  client: AscClient,
  path: string,
): Promise<Linkage[]> {
  const result: Linkage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const response = await client.get<{
      data: Linkage[];
      links?: { next?: string };
    }>(path, { limit: 200, cursor });
    result.push(...response.data);
    cursor = paging(response).nextCursor;
    if (!cursor) break;
  }
  return result;
}

// ---- Read commands (#62) ----

export const certificatesInput = z.object({
  type: commaList(enumValue),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** Signing certificates: type, serial number and expiry. */
export async function listCertificates(
  client: AscClient,
  input: z.output<typeof certificatesInput>,
) {
  return provisioning(async () => {
    const response = await client.get<Collection<CertificateAttributes>>(
      "/v1/certificates",
      {
        "filter[certificateType]": input.type,
        sort: "displayName",
        limit: input.limit,
        cursor: input.cursor,
      },
    );
    return {
      certificates: response.data.map(({ id, attributes }) =>
        shapeCertificate(id, attributes),
      ),
      ...paging(response),
    };
  });
}

export const profilesInput = z.object({
  type: commaList(enumValue),
  state: commaList(z.enum(["ACTIVE", "INVALID"])),
  name: z.string().trim().min(1).optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

const PROFILE_QUERY = {
  include: ["bundleId", "certificates", "devices"],
  "fields[profiles]": [
    "name",
    "platform",
    "profileType",
    "profileState",
    "uuid",
    "createdDate",
    "expirationDate",
    "bundleId",
    "certificates",
    "devices",
  ],
  "fields[bundleIds]": ["identifier", "name"],
  "fields[certificates]": [
    "name",
    "displayName",
    "certificateType",
    "serialNumber",
    "expirationDate",
  ],
  "fields[devices]": ["name", "udid", "platform", "status"],
  "limit[certificates]": 50,
  "limit[devices]": 50,
} satisfies AscQuery;

function shapeProfile(
  profile: Resource<ProfileAttributes>,
  included: Resource<Record<string, unknown>>[] | undefined,
) {
  const attributes = profile.attributes;
  const bundle = linkages(profile.relationships?.bundleId)[0];
  const bundleAttributes = bundle ? findIncluded(included, bundle) : undefined;
  const devices = linkages(profile.relationships?.devices);
  return {
    id: profile.id,
    name: attributes?.name,
    type: attributes?.profileType,
    state: attributes?.profileState,
    platform: attributes?.platform,
    uuid: attributes?.uuid,
    createdDate: attributes?.createdDate,
    expirationDate: attributes?.expirationDate,
    bundleId: bundle
      ? {
          id: bundle.id,
          identifier: bundleAttributes?.identifier,
          name: bundleAttributes?.name,
        }
      : undefined,
    certificates: linkages(profile.relationships?.certificates).map((link) =>
      shapeCertificate(
        link.id,
        findIncluded(included, link) as CertificateAttributes | undefined,
      ),
    ),
    deviceCount:
      profile.relationships?.devices?.meta?.paging?.total ?? devices.length,
    devices: devices.map((link) => {
      const device = findIncluded(included, link);
      return {
        id: link.id,
        name: device?.name,
        udid: device?.udid,
        platform: device?.platform,
        status: device?.status,
      };
    }),
  };
}

/** Provisioning profiles with their bundle ID, certificates and devices; never the profile contents. */
export async function listProfiles(
  client: AscClient,
  input: z.output<typeof profilesInput>,
) {
  return provisioning(async () => {
    const response = await client.get<Collection<ProfileAttributes>>(
      "/v1/profiles",
      {
        ...PROFILE_QUERY,
        "filter[profileType]": input.type,
        "filter[profileState]": input.state,
        "filter[name]": input.name,
        sort: "name",
        limit: input.limit,
        cursor: input.cursor,
      },
    );
    return {
      profiles: response.data.map((profile) =>
        shapeProfile(profile, response.included),
      ),
      ...paging(response),
    };
  });
}

export const bundleIdsInput = z.object({
  identifier: z.string().trim().min(1).optional(),
  platform: commaList(enumValue),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** Bundle IDs (identifiers) with their enabled capabilities. */
export async function listBundleIds(
  client: AscClient,
  input: z.output<typeof bundleIdsInput>,
) {
  return provisioning(async () => {
    const response = await client.get<
      Collection<{
        name?: string;
        identifier?: string;
        platform?: string;
        seedId?: string;
      }>
    >("/v1/bundleIds", {
      include: ["bundleIdCapabilities"],
      "fields[bundleIds]": [
        "name",
        "identifier",
        "platform",
        "seedId",
        "bundleIdCapabilities",
      ],
      "fields[bundleIdCapabilities]": ["capabilityType", "settings"],
      "limit[bundleIdCapabilities]": 50,
      "filter[identifier]": input.identifier,
      "filter[platform]": input.platform,
      sort: "identifier",
      limit: input.limit,
      cursor: input.cursor,
    });
    return {
      bundleIds: response.data.map(({ id, attributes, relationships }) => ({
        id,
        identifier: attributes?.identifier,
        name: attributes?.name,
        platform: attributes?.platform,
        teamId: attributes?.seedId,
        capabilities: linkages(relationships?.bundleIdCapabilities).map(
          (link) => {
            const capability = findIncluded(response.included, link);
            return {
              type: capability?.capabilityType,
              settings: capability?.settings ?? undefined,
            };
          },
        ),
      })),
      ...paging(response),
    };
  });
}

export const devicesInput = z.object({
  platform: commaList(enumValue),
  status: commaList(z.enum(["ENABLED", "DISABLED"])),
  name: z.string().trim().min(1).optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** Registered devices: name, UDID, platform, model and status. */
export async function listDevices(
  client: AscClient,
  input: z.output<typeof devicesInput>,
) {
  return provisioning(async () => {
    const response = await client.get<
      Collection<{
        name?: string;
        udid?: string;
        platform?: string;
        deviceClass?: string;
        model?: string | null;
        status?: string;
        addedDate?: string;
      }>
    >("/v1/devices", {
      "filter[platform]": input.platform,
      "filter[status]": input.status,
      "filter[name]": input.name,
      sort: "name",
      limit: input.limit,
      cursor: input.cursor,
    });
    return {
      devices: response.data.map(({ id, attributes: device }) => ({
        id,
        name: device?.name,
        udid: device?.udid,
        platform: device?.platform,
        deviceClass: device?.deviceClass,
        model: device?.model,
        status: device?.status,
        addedDate: device?.addedDate,
      })),
      ...paging(response),
    };
  });
}

// ---- Write commands (#99) ----

const certificateFiles = {
  keyOut: outputPath("--key-out"),
  certOut: outputPath("--cert-out"),
  commonName: z.string().trim().min(1).max(64).default("App Store Connect CLI"),
  yes: z.boolean().default(false),
};

export const createCertificateInput = z.object({
  type: z.enum(CERTIFICATE_TYPES, {
    error: `Give --type, one of ${CERTIFICATE_TYPES.join(", ")}.`,
  }),
  ...certificateFiles,
});

export const renewCertificateInput = z.object({
  certificateId: certificateIdSchema,
  ...certificateFiles,
});

async function readCertificate(client: AscClient, certificateId: string) {
  const response = await client.get<Single<CertificateAttributes>>(
    `/v1/certificates/${certificateId}`,
  );
  return shapeCertificate(response.data.id, response.data.attributes);
}

/**
 * Makes a key and CSR and asks Apple for the certificate, returning the key
 * (PKCS#8 PEM) and certificate (DER) for the caller to keep. Nothing is
 * written, so a caller that cannot keep them should revoke the certificate.
 */
export async function requestCertificate(
  client: AscClient,
  type: string,
  commonName: string,
) {
  const { privateKeyPem, csrPem } = await createSigningRequest(commonName);
  const created = await client.post<Single<CertificateAttributes>>(
    "/v1/certificates",
    {
      data: {
        type: "certificates",
        attributes: { certificateType: type, csrContent: csrPem },
      },
    },
  );
  return {
    certificate: shapeCertificate(created.data.id, created.data.attributes),
    privateKeyPem,
    content: () =>
      decodeBase64(created.data.attributes?.certificateContent, "certificate"),
  };
}

/**
 * Makes a key and CSR, writes the key file, then asks Apple for the
 * certificate and writes it. If Apple refuses, the key file is removed.
 */
async function issueCertificate(
  client: AscClient,
  type: string,
  input: { keyOut: string; certOut: string; commonName: string },
) {
  const { privateKeyPem, csrPem } = await createSigningRequest(
    input.commonName,
  );
  await writeNew(input.keyOut, privateKeyPem);
  let created: Single<CertificateAttributes>;
  try {
    created = await client.post<Single<CertificateAttributes>>(
      "/v1/certificates",
      {
        data: {
          type: "certificates",
          attributes: { certificateType: type, csrContent: csrPem },
        },
      },
    );
  } catch (error) {
    await rm(input.keyOut, { force: true });
    throw error;
  }
  const certificate = shapeCertificate(
    created.data.id,
    created.data.attributes,
  );
  try {
    await writeNew(
      input.certOut,
      decodeBase64(created.data.attributes?.certificateContent, "certificate"),
    );
  } catch (error) {
    throw new UploadIncompleteError(
      `Certificate ${certificate.id} was created and its private key written to ${input.keyOut}, but the certificate file was not written; download it from the Apple Developer website.`,
      { cause: error },
    );
  }
  return certificate;
}

/** Paths checked before anything is made: both new and different. */
async function checkCertificateFiles(input: {
  keyOut: string;
  certOut: string;
}) {
  const keyOut = await ensureAbsent(input.keyOut, "--key-out");
  const certOut = await ensureAbsent(input.certOut, "--cert-out");
  if (keyOut === certOut) {
    throw new InvalidInputError(
      "--key-out and --cert-out must be different files.",
    );
  }
  return { keyOut, certOut };
}

/**
 * Creates a signing certificate from a new RSA 2048 key: the key goes to
 * --key-out (PKCS#8 PEM, mode 600), the certificate to --cert-out (DER, as
 * Apple's .cer). Without `yes`, lists the certificates of that type instead.
 */
export async function createCertificate(
  client: AscClient,
  input: z.output<typeof createCertificateInput>,
) {
  return provisioning(async () => {
    const files = await checkCertificateFiles(input);
    if (!input.yes) {
      const existing = await client.get<Collection<CertificateAttributes>>(
        "/v1/certificates",
        { "filter[certificateType]": input.type, limit: 200 },
      );
      return {
        dryRun: true,
        action: "create-certificate",
        type: input.type,
        ...files,
        existing: existing.data.map(({ id, attributes }) =>
          shapeCertificate(id, attributes),
        ),
      };
    }
    const certificate = await issueCertificate(client, input.type, {
      ...input,
      ...files,
    });
    return {
      dryRun: false,
      action: "create-certificate",
      certificate,
      ...files,
    };
  });
}

/**
 * Creates a new certificate of the same type as an existing one, for one that
 * is expiring. The old one is left alone: revoke it once nothing uses it.
 */
export async function renewCertificate(
  client: AscClient,
  input: z.output<typeof renewCertificateInput>,
) {
  return provisioning(async () => {
    const files = await checkCertificateFiles(input);
    const replaces = await readCertificate(client, input.certificateId);
    if (!replaces.type) {
      throw new UnexpectedResponseError(
        "App Store Connect did not return the certificate's type.",
      );
    }
    if (!input.yes) {
      return {
        dryRun: true,
        action: "renew-certificate",
        replaces,
        type: replaces.type,
        ...files,
      };
    }
    const certificate = await issueCertificate(client, replaces.type, {
      ...input,
      ...files,
    });
    return {
      dryRun: false,
      action: "renew-certificate",
      replaces,
      certificate,
      ...files,
      note: "The old certificate still works until it expires or is revoked. Renew the profiles that should use the new one with profiles renew --certificate.",
    };
  });
}

export const revokeCertificateInput = z.object({
  certificateId: certificateIdSchema,
  yes: z.boolean().default(false),
});

/** Profiles that include a certificate, which revoking it makes invalid. */
async function profilesUsing(client: AscClient, certificateId: string) {
  const found: { id: string; name?: string; type?: string; state?: string }[] =
    [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const response = await client.get<Collection<ProfileAttributes>>(
      "/v1/profiles",
      {
        include: ["certificates"],
        "fields[profiles]": [
          "name",
          "profileType",
          "profileState",
          "certificates",
        ],
        "fields[certificates]": ["serialNumber"],
        "limit[certificates]": 50,
        limit: 200,
        cursor,
      },
    );
    for (const profile of response.data) {
      if (
        linkages(profile.relationships?.certificates).some(
          (link) => link.id === certificateId,
        )
      ) {
        found.push({
          id: profile.id,
          name: profile.attributes?.name,
          type: profile.attributes?.profileType,
          state: profile.attributes?.profileState,
        });
      }
    }
    cursor = paging(response).nextCursor;
    if (!cursor) break;
  }
  return found;
}

/**
 * Revokes a certificate. Every profile that includes it becomes invalid, so
 * the dry run (without `yes`) lists them.
 */
export async function revokeCertificate(
  client: AscClient,
  input: z.output<typeof revokeCertificateInput>,
) {
  return provisioning(async () => {
    const certificate = await readCertificate(client, input.certificateId);
    const affectedProfiles = await profilesUsing(client, input.certificateId);
    if (!input.yes) {
      return {
        dryRun: true,
        action: "revoke-certificate",
        certificate,
        affectedProfiles,
        warning:
          "Revoking cannot be undone. Every profile listed becomes invalid, and builds signed with this certificate can no longer be installed from those profiles.",
      };
    }
    await client.delete(`/v1/certificates/${input.certificateId}`);
    return {
      dryRun: false,
      action: "revoke-certificate",
      certificate,
      affectedProfiles,
    };
  });
}

const ids = (schema: z.ZodType<string>) => z.array(schema).optional();

export const createProfileInput = z.object({
  name: z
    .string({ error: "Give the profile's name with --name." })
    .trim()
    .min(1),
  type: z.enum(PROFILE_TYPES, {
    error: `Give --type, one of ${PROFILE_TYPES.join(", ")}.`,
  }),
  bundleId: bundleIdIdSchema,
  certificate: z
    .array(certificateIdSchema)
    .min(
      1,
      "Give at least one --certificate id from the certificates command.",
    ),
  device: ids(deviceIdSchema),
  out: outputPath("--out"),
  yes: z.boolean().default(false),
});

export const renewProfileInput = z.object({
  profileId: profileIdSchema,
  certificate: ids(certificateIdSchema),
  device: ids(deviceIdSchema),
  out: outputPath("--out"),
  yes: z.boolean().default(false),
});

export interface ProfilePlan {
  name: string;
  type: string;
  bundleId: string;
  certificates: string[];
  devices: string[];
}

function checkDevices(plan: ProfilePlan) {
  if (needsDevices(plan.type) && plan.devices.length === 0) {
    throw new InvalidInputError(
      `A ${plan.type} profile needs at least one --device id from the devices command.`,
    );
  }
  if (!needsDevices(plan.type) && plan.devices.length > 0) {
    throw new InvalidInputError(
      `A ${plan.type} profile does not take devices; leave out --device.`,
    );
  }
}

/** Creates the profile and returns it with its contents, which the caller keeps. */
export async function requestProfile(client: AscClient, plan: ProfilePlan) {
  const created = await client.post<Single<ProfileAttributes>>("/v1/profiles", {
    data: {
      type: "profiles",
      attributes: { name: plan.name, profileType: plan.type },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: plan.bundleId } },
        certificates: {
          data: plan.certificates.map((id) => ({ type: "certificates", id })),
        },
        ...(plan.devices.length > 0
          ? {
              devices: {
                data: plan.devices.map((id) => ({ type: "devices", id })),
              },
            }
          : {}),
      },
    },
  });
  const attributes = created.data.attributes;
  const profile = {
    id: created.data.id,
    name: attributes?.name,
    type: attributes?.profileType,
    state: attributes?.profileState,
    uuid: attributes?.uuid,
    expirationDate: attributes?.expirationDate,
  };
  return {
    profile,
    content: () => decodeBase64(attributes?.profileContent, "profile"),
  };
}

/** Creates the profile and writes its contents to `out`. */
async function issueProfile(client: AscClient, plan: ProfilePlan, out: string) {
  const { profile, content } = await requestProfile(client, plan);
  try {
    await writeNew(out, content());
  } catch (error) {
    throw new UploadIncompleteError(
      `Profile ${profile.id} was created, but its file was not written; download it from the Apple Developer website or Xcode.`,
      { cause: error },
    );
  }
  return profile;
}

/**
 * Creates a provisioning profile for a bundle ID, certificates and (for
 * development and ad hoc) devices, and writes it to --out. Without `yes`,
 * only shows what would be created.
 */
export async function createProfile(
  client: AscClient,
  input: z.output<typeof createProfileInput>,
) {
  return provisioning(async () => {
    const out = await ensureAbsent(input.out, "--out");
    const plan: ProfilePlan = {
      name: input.name,
      type: input.type,
      bundleId: input.bundleId,
      certificates: input.certificate,
      devices: input.device ?? [],
    };
    checkDevices(plan);
    if (!input.yes) {
      return { dryRun: true, action: "create-profile", profile: plan, out };
    }
    const profile = await issueProfile(client, plan, out);
    return { dryRun: false, action: "create-profile", profile, out };
  });
}

/**
 * Replaces a profile (an invalid or expiring one) with a new one of the same
 * name, type and bundle ID, keeping its certificates and devices unless
 * --certificate or --device name new ones. Apple has no regenerate call and,
 * as far as we know, refuses a duplicate profile name, so the old one is deleted first.
 */
export async function renewProfile(
  client: AscClient,
  input: z.output<typeof renewProfileInput>,
) {
  return provisioning(async () => {
    const out = await ensureAbsent(input.out, "--out");
    const existing = await client.get<Single<ProfileAttributes>>(
      `/v1/profiles/${input.profileId}`,
      {
        include: ["bundleId"],
        "fields[profiles]": [
          "name",
          "profileType",
          "profileState",
          "expirationDate",
          "bundleId",
        ],
        "fields[bundleIds]": ["identifier"],
      },
    );
    const old = existing.data.attributes;
    const bundle = linkages(existing.data.relationships?.bundleId)[0];
    if (!old?.name || !old.profileType || !bundle) {
      throw new UnexpectedResponseError(
        "App Store Connect did not return the profile's name, type and bundle ID.",
      );
    }
    const certificates =
      input.certificate ??
      (
        await allLinkages(
          client,
          `/v1/profiles/${input.profileId}/relationships/certificates`,
        )
      ).map((link) => link.id);
    const devices =
      input.device ??
      (needsDevices(old.profileType)
        ? (
            await allLinkages(
              client,
              `/v1/profiles/${input.profileId}/relationships/devices`,
            )
          ).map((link) => link.id)
        : []);
    if (certificates.length === 0) {
      throw new InvalidInputError(
        "The profile has no certificates left (they may have been revoked); name the new ones with --certificate.",
      );
    }
    const plan: ProfilePlan = {
      name: old.name,
      type: old.profileType,
      bundleId: bundle.id,
      certificates,
      devices,
    };
    checkDevices(plan);
    const replaces = {
      id: existing.data.id,
      name: old.name,
      type: old.profileType,
      state: old.profileState,
      expirationDate: old.expirationDate,
    };
    if (!input.yes) {
      return {
        dryRun: true,
        action: "renew-profile",
        replaces,
        profile: plan,
        out,
      };
    }
    await client.delete(`/v1/profiles/${input.profileId}`);
    let profile: Awaited<ReturnType<typeof issueProfile>>;
    try {
      profile = await issueProfile(client, plan, out);
    } catch (error) {
      if (error instanceof UploadIncompleteError) throw error;
      throw new UploadIncompleteError(
        `Profile ${input.profileId} was deleted but the new one was not created; create it with profiles create --name "${plan.name}" --type ${plan.type} --bundle-id ${plan.bundleId}.`,
        { cause: error },
      );
    }
    return { dryRun: false, action: "renew-profile", replaces, profile, out };
  });
}

export const deleteProfileInput = z.object({
  profileId: profileIdSchema,
  yes: z.boolean().default(false),
});

/** Deletes a provisioning profile. Without `yes`, only shows which one. */
export async function deleteProfile(
  client: AscClient,
  input: z.output<typeof deleteProfileInput>,
) {
  return provisioning(async () => {
    const response = await client.get<Single<ProfileAttributes>>(
      `/v1/profiles/${input.profileId}`,
      PROFILE_QUERY,
    );
    const profile = shapeProfile(response.data, response.included);
    if (!input.yes) {
      return {
        dryRun: true,
        action: "delete-profile",
        profile,
        warning: "Deleting cannot be undone.",
      };
    }
    await client.delete(`/v1/profiles/${input.profileId}`);
    return { dryRun: false, action: "delete-profile", profile };
  });
}

// ---- Bundle IDs, capabilities and devices (#132) ----

/** Platforms a bundle ID or device is registered for (Apple's BundleIdPlatform). */
export const BUNDLE_ID_PLATFORMS = ["IOS", "MAC_OS", "UNIVERSAL"] as const;

/** Apple's CapabilityType values. */
export const CAPABILITY_TYPES = [
  "ICLOUD",
  "IN_APP_PURCHASE",
  "GAME_CENTER",
  "PUSH_NOTIFICATIONS",
  "WALLET",
  "INTER_APP_AUDIO",
  "MAPS",
  "ASSOCIATED_DOMAINS",
  "PERSONAL_VPN",
  "APP_GROUPS",
  "HEALTHKIT",
  "HOMEKIT",
  "WIRELESS_ACCESSORY_CONFIGURATION",
  "APPLE_PAY",
  "DATA_PROTECTION",
  "SIRIKIT",
  "NETWORK_EXTENSIONS",
  "MULTIPATH",
  "HOT_SPOT",
  "NFC_TAG_READING",
  "CLASSKIT",
  "AUTOFILL_CREDENTIAL_PROVIDER",
  "ACCESS_WIFI_INFORMATION",
  "NETWORK_CUSTOM_PROTOCOL",
  "COREMEDIA_HLS_LOW_LATENCY",
  "SYSTEM_EXTENSION_INSTALL",
  "USER_MANAGEMENT",
  "APPLE_ID_AUTH",
] as const;

const PROFILES_NOTE =
  "Existing profiles do not pick this up on their own: renew the profiles that need it with profiles renew.";

interface BundleIdAttributes {
  name?: string;
  identifier?: string;
  platform?: string;
  seedId?: string;
}

interface CapabilityAttributes {
  capabilityType?: string;
  settings?: unknown;
}

interface DeviceAttributes {
  name?: string;
  udid?: string;
  platform?: string;
  status?: string;
}

function shapeBundleId(id: string, attributes: BundleIdAttributes | undefined) {
  return {
    id,
    identifier: attributes?.identifier,
    name: attributes?.name,
    platform: attributes?.platform,
    teamId: attributes?.seedId,
  };
}

export const createBundleIdInput = z.object({
  identifier: z
    .string({ error: "Give the identifier with --identifier." })
    .trim()
    .regex(
      /^[A-Za-z0-9.-]+(\.\*)?$/,
      "Must be a reverse-DNS identifier such as com.example.app, or a wildcard such as com.example.*.",
    ),
  name: z
    .string({ error: "Give a description with --name." })
    .trim()
    .min(1)
    .max(255),
  platform: z.enum(BUNDLE_ID_PLATFORMS, {
    error: `Give --platform, one of ${BUNDLE_ID_PLATFORMS.join(", ")}.`,
  }),
  yes: z.boolean().default(false),
});

/** Registers a bundle ID. Without `yes`, shows whether the identifier is taken. */
export async function createBundleId(
  client: AscClient,
  input: z.output<typeof createBundleIdInput>,
) {
  return provisioning(async () => {
    const existing = await client.get<Collection<BundleIdAttributes>>(
      "/v1/bundleIds",
      { "filter[identifier]": input.identifier, limit: 200 },
    );
    // Apple's filter matches prefixes too, so compare exactly.
    const taken = existing.data.find(
      (item) => item.attributes?.identifier === input.identifier,
    );
    if (taken) {
      throw new InvalidInputError(
        `${input.identifier} is already registered as bundle ID ${taken.id}. Nothing was changed.`,
      );
    }
    const bundleId = {
      identifier: input.identifier,
      name: input.name,
      platform: input.platform,
    };
    if (!input.yes) {
      return { dryRun: true, action: "create-bundle-id", bundleId };
    }
    const created = await client.post<Single<BundleIdAttributes>>(
      "/v1/bundleIds",
      { data: { type: "bundleIds", attributes: bundleId } },
    );
    return {
      dryRun: false,
      action: "create-bundle-id",
      bundleId: shapeBundleId(created.data.id, created.data.attributes),
    };
  });
}

export const bundleIdCapabilitiesInput = z.object({
  bundleIdId: bundleIdIdSchema,
});

async function readCapabilities(client: AscClient, bundleIdId: string) {
  const response = await client.get<Collection<CapabilityAttributes>>(
    `/v1/bundleIds/${bundleIdId}/bundleIdCapabilities`,
    { limit: 200 },
  );
  return response.data.map(({ id, attributes }) => ({
    id,
    type: attributes?.capabilityType,
    settings: attributes?.settings ?? undefined,
  }));
}

/** A bundle ID's enabled capabilities with their settings. */
export async function listBundleIdCapabilities(
  client: AscClient,
  input: z.output<typeof bundleIdCapabilitiesInput>,
) {
  return provisioning(async () => ({
    bundleIdId: input.bundleIdId,
    capabilities: await readCapabilities(client, input.bundleIdId),
  }));
}

const capabilitySchema = z.enum(CAPABILITY_TYPES, {
  error: `Give --capability, one of ${CAPABILITY_TYPES.join(", ")}.`,
});

export const enableCapabilityInput = z.object({
  bundleIdId: bundleIdIdSchema,
  capability: capabilitySchema,
  /** KEY=OPTION pairs such as ICLOUD_VERSION=XCODE_6. */
  setting: z
    .array(
      z
        .string()
        .trim()
        .regex(
          /^[A-Z0-9_]{1,60}=[A-Z0-9_]{1,60}$/,
          "Give each --setting as KEY=OPTION, such as DATA_PROTECTION_PERMISSION_LEVEL=COMPLETE_PROTECTION.",
        ),
    )
    .optional(),
  yes: z.boolean().default(false),
});

/** Groups KEY=OPTION pairs into Apple's CapabilitySetting list. */
function capabilitySettings(pairs: string[] | undefined) {
  if (!pairs?.length) return undefined;
  const byKey = new Map<string, string[]>();
  for (const pair of pairs) {
    const [key = "", option = ""] = pair.split("=");
    byKey.set(key, [...(byKey.get(key) ?? []), option]);
  }
  return [...byKey].map(([key, options]) => ({
    key,
    options: options.map((option) => ({ key: option, enabled: true })),
  }));
}

/** Turns on a capability for a bundle ID. Without `yes`, prints the current ones. */
export async function enableCapability(
  client: AscClient,
  input: z.output<typeof enableCapabilityInput>,
) {
  return provisioning(async () => {
    const current = await readCapabilities(client, input.bundleIdId);
    if (current.some((item) => item.type === input.capability)) {
      throw new InvalidInputError(
        `${input.capability} is already enabled for bundle ID ${input.bundleIdId}. To change its settings, disable it and enable it again. Nothing was changed.`,
      );
    }
    const settings = capabilitySettings(input.setting);
    if (!input.yes) {
      return {
        dryRun: true,
        action: "enable-capability",
        bundleIdId: input.bundleIdId,
        capability: input.capability,
        settings,
        current,
      };
    }
    const created = await client.post<Single<CapabilityAttributes>>(
      "/v1/bundleIdCapabilities",
      {
        data: {
          type: "bundleIdCapabilities",
          attributes: { capabilityType: input.capability, settings },
          relationships: {
            bundleId: { data: { type: "bundleIds", id: input.bundleIdId } },
          },
        },
      },
    );
    return {
      dryRun: false,
      action: "enable-capability",
      bundleIdId: input.bundleIdId,
      capability: {
        id: created.data.id,
        type: created.data.attributes?.capabilityType,
        settings: created.data.attributes?.settings ?? undefined,
      },
      note: PROFILES_NOTE,
    };
  });
}

export const disableCapabilityInput = z.object({
  bundleIdId: bundleIdIdSchema,
  capability: capabilitySchema,
  yes: z.boolean().default(false),
});

/** Turns off a capability. Without `yes`, prints the capability. */
export async function disableCapability(
  client: AscClient,
  input: z.output<typeof disableCapabilityInput>,
) {
  return provisioning(async () => {
    const current = await readCapabilities(client, input.bundleIdId);
    const capability = current.find((item) => item.type === input.capability);
    if (!capability) {
      throw new NotFoundError(
        `${input.capability} is not enabled for bundle ID ${input.bundleIdId}. Nothing was changed.`,
      );
    }
    if (!input.yes) {
      return {
        dryRun: true,
        action: "disable-capability",
        bundleIdId: input.bundleIdId,
        capability,
      };
    }
    await client.delete(`/v1/bundleIdCapabilities/${capability.id}`);
    return {
      dryRun: false,
      action: "disable-capability",
      bundleIdId: input.bundleIdId,
      capability,
      note: PROFILES_NOTE,
    };
  });
}

/** An iPhone, iPad or Mac UDID: hex digits, with hyphens in newer formats. */
const udidSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Fa-f-]{20,40}$/, "Must be a device UDID.");

const deviceSchema = z.object({
  name: z.string().trim().min(1).max(50),
  udid: udidSchema,
  platform: z.enum(BUNDLE_ID_PLATFORMS),
});

export const registerDevicesInput = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  udid: udidSchema.optional(),
  platform: z.enum(BUNDLE_ID_PLATFORMS).default("IOS"),
  file: z.string().trim().min(1).optional(),
  yes: z.boolean().default(false),
});

/** Apple's device upload file uses `ios` and `mac`; this also takes the API's names. */
function devicePlatform(value: string | undefined, fallback: string): string {
  const platform = (value ?? "").trim().toUpperCase();
  if (!platform) return fallback;
  if (platform === "MAC" || platform === "MACOS") return "MAC_OS";
  return platform;
}

/**
 * Reads a device list: one device per line as `UDID,name[,platform]` (comma
 * or tab separated, as in the file the Developer website takes). A header
 * line and lines starting with # are skipped.
 */
async function readDeviceFile(path: string, fallbackPlatform: string) {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new InvalidInputError(`Could not read the --file ${path}.`);
  }
  const devices: z.output<typeof deviceSchema>[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [udid, name, platform] = line
      .split(/\t|,/)
      .map((cell) => cell.trim());
    if (index === 0 && /^(device id|udid)$/i.test(udid ?? "")) continue;
    const parsed = deviceSchema.safeParse({
      udid,
      name,
      platform: devicePlatform(platform, fallbackPlatform),
    });
    if (!parsed.success) {
      throw new InvalidInputError(
        `Line ${index + 1} of ${path} is not UDID,name[,platform] with platform IOS or MAC_OS. Nothing was changed.`,
      );
    }
    devices.push(parsed.data);
  }
  if (devices.length === 0) {
    throw new InvalidInputError(`${path} lists no devices.`);
  }
  return devices;
}

/** Every registered device, following pages. */
async function allDevices(client: AscClient) {
  const result: Resource<DeviceAttributes>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const response = await client.get<Collection<DeviceAttributes>>(
      "/v1/devices",
      {
        "fields[devices]": ["name", "udid", "platform", "status"],
        limit: 200,
        cursor,
      },
    );
    result.push(...response.data);
    cursor = paging(response).nextCursor;
    if (!cursor) break;
  }
  return result;
}

/**
 * Registers one device (--name, --udid) or every device in --file, skipping
 * UDIDs already registered. Without `yes`, prints what it would register.
 */
export async function registerDevices(
  client: AscClient,
  input: z.output<typeof registerDevicesInput>,
) {
  let wanted: z.output<typeof deviceSchema>[];
  if (input.file !== undefined) {
    if (input.name !== undefined || input.udid !== undefined) {
      throw new InvalidInputError(
        "Give --file or --name and --udid, not both.",
      );
    }
    wanted = await readDeviceFile(input.file, input.platform);
  } else {
    if (input.name === undefined || input.udid === undefined) {
      throw new InvalidInputError(
        "Give the device with --name and --udid, or several with --file.",
      );
    }
    wanted = [{ name: input.name, udid: input.udid, platform: input.platform }];
  }
  const seen = new Set<string>();
  for (const device of wanted) {
    const key = device.udid.toLowerCase();
    if (seen.has(key)) {
      throw new InvalidInputError(
        `UDID ${device.udid} is listed twice. Nothing was changed.`,
      );
    }
    seen.add(key);
  }
  return provisioning(async () => {
    const registered = new Map(
      (await allDevices(client)).map((device) => [
        device.attributes?.udid?.toLowerCase(),
        device,
      ]),
    );
    const alreadyRegistered = wanted
      .filter((device) => registered.has(device.udid.toLowerCase()))
      .map((device) => {
        const found = registered.get(device.udid.toLowerCase());
        return {
          id: found?.id,
          name: found?.attributes?.name,
          udid: device.udid,
          status: found?.attributes?.status,
        };
      });
    const toRegister = wanted.filter(
      (device) => !registered.has(device.udid.toLowerCase()),
    );
    if (!input.yes) {
      return {
        dryRun: true,
        action: "register-devices",
        toRegister,
        alreadyRegistered,
        warning:
          "Each device registered counts against the membership year's device limit, even if it is disabled later; it cannot be removed until the membership year renews.",
      };
    }
    const created: {
      id: string;
      name?: string;
      udid?: string;
      platform?: string;
    }[] = [];
    for (const device of toRegister) {
      try {
        const response = await client.post<Single<DeviceAttributes>>(
          "/v1/devices",
          { data: { type: "devices", attributes: device } },
        );
        created.push({
          id: response.data.id,
          name: response.data.attributes?.name,
          udid: response.data.attributes?.udid,
          platform: response.data.attributes?.platform,
        });
      } catch (error) {
        if (created.length === 0) throw error;
        throw new UploadIncompleteError(
          `Registered ${created.length} of ${toRegister.length} devices (${created.map((item) => item.udid).join(", ")}) before ${device.udid} failed; run the command again to register the rest.`,
          { cause: error },
        );
      }
    }
    return {
      dryRun: false,
      action: "register-devices",
      registered: created,
      alreadyRegistered,
      note: "Existing development and ad hoc profiles do not include new devices: renew them with profiles renew --device.",
    };
  });
}
