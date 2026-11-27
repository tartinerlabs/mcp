import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  pageInfo,
} from "../asc/client.ts";
import {
  appIdSchema,
  cursorSchema,
  idSchema,
  limitSchema,
} from "../schemas/common.ts";
import {
  AscApiError,
  InvalidInputError,
  NotFoundError,
  PermissionError,
  UnexpectedResponseError,
} from "../utils/errors.ts";

// EU alternative distribution: alternative distribution keys, the packages
// Apple builds for a version, and an alternative marketplace's search details
// and webhooks. Public keys, signed download URLs, key blobs and webhook
// secrets never go to stdout, errors or logs: keys, packages and blobs only to
// new files the user names, and secrets are read from a file.

const keyIdSchema = idSchema("alt-distribution keys");
const versionIdSchema = idSchema("versions");
const packageIdSchema = idSchema("alt-distribution package");
const packageVersionIdSchema = idSchema("alt-distribution package-versions");
const webhookIdSchema = idSchema("alt-distribution webhooks");
const yesSchema = z.boolean().default(false);

/** A file to create; an existing file is never overwritten. */
const outputPath = (option: string) =>
  z
    .string({ error: `Give the file to write with ${option}.` })
    .trim()
    .min(1, `Give the file to write with ${option}.`);

/** A file to read, such as the public key or the webhook secret. */
const inputPath = (option: string) =>
  z
    .string({ error: `Give the file to read with ${option}.` })
    .trim()
    .min(1, `Give the file to read with ${option}.`);

const httpsUrl = (option: string) =>
  z
    .url({
      protocol: /^https$/,
      error: `${option} must be an https:// URL.`,
    })
    .trim();

const ENTITLEMENT_HINT =
  "Alternative distribution needs the account's EU alternative distribution entitlement (an alternative app marketplace, or web distribution) accepted in App Store Connect, and an API key with the Admin or Account Holder role. If the account has not been approved for alternative distribution, Apple refuses every request here.";

/** Runs a request, turning Apple's 403 into a `[permission]` error about the EU entitlement. */
async function entitled<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof AscApiError && error.status === 403) {
      throw new PermissionError(
        `App Store Connect refused this alternative distribution request. ${ENTITLEMENT_HINT}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** A to-one read that answers 404 when nothing is set up: `undefined` then. */
async function optional<T>(request: () => Promise<T>): Promise<T | undefined> {
  try {
    return await entitled(request);
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) return undefined;
    throw error;
  }
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

/** The trimmed text of a file the user named; its contents never appear in errors. */
async function readText(path: string, option: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new InvalidInputError(`Could not read the ${option} file ${path}.`);
  }
  const trimmed = text.trim();
  if (!trimmed)
    throw new InvalidInputError(`The ${option} file ${path} is empty.`);
  return trimmed;
}

/** A short SHA-256 fingerprint so a key can be told apart without printing it. */
async function fingerprint(value: string | undefined) {
  if (!value) return undefined;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(":");
}

interface KeyAttributes {
  publicKey?: string;
}

interface Checksums {
  file?: { hash?: string; algorithm?: string };
  composite?: { hash?: string; algorithm?: string };
}

interface PackageAttributes {
  sourceFileChecksum?: Checksums | null;
}

interface PackageVersionAttributes {
  url?: string;
  urlExpirationDate?: string;
  version?: string;
  fileChecksum?: string;
  state?: string;
}

interface FileAttributes {
  url?: string;
  urlExpirationDate?: string;
  alternativeDistributionKeyBlob?: string;
  fileChecksum?: string;
}

/** A key as the commands print it: its id and a fingerprint, never the key. */
async function shapeKey(key: AscResource<KeyAttributes>) {
  return {
    id: key.id,
    publicKeyFingerprint: await fingerprint(key.attributes?.publicKey),
  };
}

/** A package version without its signed URL. */
function shapePackageVersion(version: AscResource<PackageVersionAttributes>) {
  const attributes = version.attributes ?? {};
  return {
    id: version.id,
    version: attributes.version,
    state: attributes.state,
    fileChecksum: attributes.fileChecksum,
    downloadable: Boolean(attributes.url),
    urlExpirationDate: attributes.urlExpirationDate,
  };
}

/** A variant or delta without its signed URL or key blob. */
function shapeFile(file: AscResource<FileAttributes>) {
  const attributes = file.attributes ?? {};
  return {
    id: file.id,
    fileChecksum: attributes.fileChecksum,
    downloadable: Boolean(attributes.url),
    urlExpirationDate: attributes.urlExpirationDate,
    hasKeyBlob: Boolean(attributes.alternativeDistributionKeyBlob),
  };
}

const KEY_FIELDS = { "fields[alternativeDistributionKeys]": ["publicKey"] };

// ---- Read commands ----

export const keysInput = z.object({
  appId: appIdSchema.optional(),
  scope: z.enum(["app", "account"]).optional(),
  limit: limitSchema,
});

/**
 * Alternative distribution keys: the account's, or with an app id that app's
 * key. Only ids and a fingerprint are printed, never the public key.
 */
export async function listKeys(
  client: AscClient,
  input: z.output<typeof keysInput>,
) {
  if (input.appId) {
    const response = await optional(() =>
      client.get<{ data: AscResource<KeyAttributes> | null }>(
        `/v1/apps/${input.appId}/alternativeDistributionKey`,
        KEY_FIELDS,
      ),
    );
    return {
      appId: input.appId,
      key: response?.data ? await shapeKey(response.data) : null,
    };
  }
  const response = await entitled(() =>
    client.get<AscDocument<KeyAttributes>>("/v1/alternativeDistributionKeys", {
      ...KEY_FIELDS,
      "exists[app]":
        input.scope === undefined ? undefined : input.scope === "app",
      limit: input.limit,
    }),
  );
  return {
    keys: await Promise.all(response.data.map(shapeKey)),
    ...pageInfo(response),
  };
}

export const exportKeyInput = z.object({
  keyId: keyIdSchema,
  out: outputPath("--out"),
});

/** Writes a key's public key to a new file; the key itself is never printed. */
export async function exportKey(
  client: AscClient,
  input: z.output<typeof exportKeyInput>,
) {
  const out = await ensureAbsent(input.out, "--out");
  const response = await entitled(() =>
    client.get<{ data: AscResource<KeyAttributes> }>(
      `/v1/alternativeDistributionKeys/${input.keyId}`,
      KEY_FIELDS,
    ),
  );
  const publicKey = response.data.attributes?.publicKey;
  if (!publicKey) {
    throw new UnexpectedResponseError(
      "App Store Connect did not return the public key.",
    );
  }
  await writeNew(out, `${publicKey}\n`);
  return { ...(await shapeKey(response.data)), publicKeyFile: out };
}

export const packageInput = z.object({ versionId: versionIdSchema });

/** The alternative distribution package of an App Store version and its versions, without download URLs. */
export async function getPackage(
  client: AscClient,
  input: z.output<typeof packageInput>,
) {
  const response = await optional(() =>
    client.get<{
      data: AscResource<PackageAttributes> | null;
      included?: AscResource<PackageVersionAttributes>[];
    }>(
      `/v1/appStoreVersions/${input.versionId}/alternativeDistributionPackage`,
      {
        include: "versions",
        "limit[versions]": 50,
      },
    ),
  );
  if (!response?.data) {
    return {
      versionId: input.versionId,
      package: null,
      note: "No alternative distribution package has been requested for this version; use alt-distribution package request.",
    };
  }
  const versions = (response.included ?? []).filter(
    (item) => item.type === "alternativeDistributionPackageVersions",
  );
  return {
    versionId: input.versionId,
    package: {
      id: response.data.id,
      sourceFileChecksum: response.data.attributes?.sourceFileChecksum ?? null,
      versions: versions.map(shapePackageVersion),
    },
  };
}

export const packageVersionsInput = z.object({
  packageId: packageIdSchema,
  state: z.enum(["COMPLETED", "REPLACED"]).optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** A package's versions with their variants and deltas: state, checksums and URL expiry, never the URLs. */
export async function listPackageVersions(
  client: AscClient,
  input: z.output<typeof packageVersionsInput>,
) {
  const response = await entitled(() =>
    client.get<AscDocument<PackageVersionAttributes>>(
      `/v1/alternativeDistributionPackages/${input.packageId}/versions`,
      {
        "filter[state]": input.state,
        include: ["variants", "deltas"],
        "limit[variants]": 50,
        "limit[deltas]": 50,
        limit: input.limit,
        cursor: input.cursor,
      },
    ),
  );
  const included = (response.included ?? []) as AscResource<FileAttributes>[];
  const related = (
    version: AscResource<PackageVersionAttributes>,
    name: string,
  ) => {
    const data = (
      version.relationships?.[name] as
        | { data?: { type: string; id: string }[] | null }
        | undefined
    )?.data;
    return (Array.isArray(data) ? data : [])
      .map((link) =>
        included.find((item) => item.type === link.type && item.id === link.id),
      )
      .filter((item) => item !== undefined)
      .map(shapeFile);
  };
  return {
    packageId: input.packageId,
    versions: response.data.map((version) => ({
      ...shapePackageVersion(version),
      variants: related(version, "variants"),
      deltas: related(version, "deltas"),
    })),
    ...pageInfo(response),
  };
}

export const downloadInput = z
  .object({
    packageVersionId: packageVersionIdSchema,
    variant: idSchema("alt-distribution package-versions").optional(),
    delta: idSchema("alt-distribution package-versions").optional(),
    out: outputPath("--out"),
    keyBlobOut: z.string().trim().min(1).optional(),
  })
  .refine((input) => !(input.variant && input.delta), {
    message: "Give --variant or --delta, not both.",
  })
  .refine((input) => !input.keyBlobOut || input.variant || input.delta, {
    message:
      "--key-blob-out needs --variant or --delta: only those carry a key blob.",
  });

/**
 * Downloads a package version, or one of its variants or deltas, to a new
 * file through the signed URL Apple returns. The URL is never printed.
 */
export async function downloadPackage(
  client: AscClient,
  input: z.output<typeof downloadInput>,
) {
  const out = await ensureAbsent(input.out, "--out");
  const keyBlobOut = input.keyBlobOut
    ? await ensureAbsent(input.keyBlobOut, "--key-blob-out")
    : undefined;
  if (keyBlobOut === out) {
    throw new InvalidInputError("--out and --key-blob-out must differ.");
  }
  const kind = input.variant ? "variant" : input.delta ? "delta" : "version";
  let file: AscResource<FileAttributes & PackageVersionAttributes> | undefined;
  if (input.variant || input.delta) {
    // Read through the package version, so the variant or delta must belong to it.
    const wanted = input.variant ?? input.delta;
    const response = await entitled(() =>
      client.get<AscDocument<FileAttributes>>(
        `/v1/alternativeDistributionPackageVersions/${input.packageVersionId}/${kind}s`,
        { limit: 200 },
      ),
    );
    file = response.data.find((item) => item.id === wanted);
    if (!file) {
      throw new NotFoundError(
        `Package version ${input.packageVersionId} has no ${kind} ${wanted}; list them with alt-distribution package-versions.`,
      );
    }
  } else {
    const response = await entitled(() =>
      client.get<{ data: AscResource<PackageVersionAttributes> }>(
        `/v1/alternativeDistributionPackageVersions/${input.packageVersionId}`,
      ),
    );
    file = response.data;
  }
  const attributes = file.attributes ?? {};
  if (!attributes.url) {
    throw new UnexpectedResponseError(
      `App Store Connect returned no download for this ${kind}; it may not be ready yet.`,
    );
  }
  const keyBlob = attributes.alternativeDistributionKeyBlob;
  if (keyBlobOut && !keyBlob) {
    throw new UnexpectedResponseError(
      `App Store Connect returned no key blob for this ${kind}. Nothing was written.`,
    );
  }
  const bytes = await client.downloadSigned(attributes.url);
  await writeNew(out, bytes);
  if (keyBlobOut && keyBlob) await writeNew(keyBlobOut, `${keyBlob}\n`);
  return {
    kind,
    id: file.id,
    fileChecksum: attributes.fileChecksum,
    bytes: bytes.byteLength,
    file: out,
    keyBlobFile: keyBlobOut,
  };
}

export const marketplaceInput = z.object({ appId: appIdSchema });

/** An app's alternative marketplace search details: its catalog URL. */
export async function getMarketplace(
  client: AscClient,
  input: z.output<typeof marketplaceInput>,
) {
  const response = await readSearchDetail(client, input.appId);
  return {
    appId: input.appId,
    searchDetail: response
      ? { id: response.id, catalogUrl: response.attributes?.catalogUrl }
      : null,
  };
}

async function readSearchDetail(client: AscClient, appId: string) {
  const response = await optional(() =>
    client.get<{ data: AscResource<{ catalogUrl?: string }> | null }>(
      `/v1/apps/${appId}/marketplaceSearchDetail`,
    ),
  );
  return response?.data ?? undefined;
}

export const marketplaceWebhooksInput = z.object({ limit: limitSchema });

/** The marketplace's webhooks: id and endpoint URL. Secrets are never returned by Apple. */
export async function listMarketplaceWebhooks(
  client: AscClient,
  input: z.output<typeof marketplaceWebhooksInput>,
) {
  const response = await entitled(() =>
    client.get<AscDocument<{ endpointUrl?: string }>>(
      "/v1/marketplaceWebhooks",
      { limit: input.limit },
    ),
  );
  return {
    webhooks: response.data.map((hook) => ({
      id: hook.id,
      endpointUrl: hook.attributes?.endpointUrl,
    })),
    ...pageInfo(response),
  };
}

// ---- Write commands ----

export const createKeyInput = z.object({
  publicKeyFile: inputPath("--public-key-file"),
  appId: appIdSchema.optional(),
  yes: yesSchema,
});

/** Adds an alternative distribution key from a public key file, for the account or for one app. */
export async function createKey(
  client: AscClient,
  input: z.output<typeof createKeyInput>,
) {
  const publicKey = await readText(input.publicKeyFile, "--public-key-file");
  const existing = await listKeys(client, { appId: input.appId, limit: 50 });
  const plan = {
    appId: input.appId ?? null,
    publicKeyFingerprint: await fingerprint(publicKey),
    existing,
  };
  if (input.appId && "key" in existing && existing.key) {
    throw new InvalidInputError(
      `App ${input.appId} already has alternative distribution key ${existing.key.id}; delete it with alt-distribution keys delete first.`,
    );
  }
  if (!input.yes) return { dryRun: true, create: plan };
  const response = await entitled(() =>
    client.post<{ data: AscResource<KeyAttributes> }>(
      "/v1/alternativeDistributionKeys",
      {
        data: {
          type: "alternativeDistributionKeys",
          attributes: { publicKey },
          ...(input.appId
            ? {
                relationships: {
                  app: { data: { type: "apps", id: input.appId } },
                },
              }
            : {}),
        },
      },
    ),
  );
  return {
    dryRun: false,
    created: { ...(await shapeKey(response.data)), appId: input.appId ?? null },
  };
}

export const deleteKeyInput = z.object({ keyId: keyIdSchema, yes: yesSchema });

/** Deletes an alternative distribution key. */
export async function deleteKey(
  client: AscClient,
  input: z.output<typeof deleteKeyInput>,
) {
  const response = await entitled(() =>
    client.get<{ data: AscResource<KeyAttributes> }>(
      `/v1/alternativeDistributionKeys/${input.keyId}`,
      KEY_FIELDS,
    ),
  );
  const key = await shapeKey(response.data);
  if (!input.yes) return { dryRun: true, delete: key };
  await entitled(() =>
    client.delete(`/v1/alternativeDistributionKeys/${input.keyId}`),
  );
  return { dryRun: false, deleted: key };
}

export const requestPackageInput = z.object({
  versionId: versionIdSchema,
  yes: yesSchema,
});

/** Asks Apple to build the alternative distribution package for an App Store version. */
export async function requestPackage(
  client: AscClient,
  input: z.output<typeof requestPackageInput>,
) {
  const current = await getPackage(client, { versionId: input.versionId });
  if (current.package) {
    throw new InvalidInputError(
      `Version ${input.versionId} already has alternative distribution package ${current.package.id}; read it with alt-distribution package-versions.`,
    );
  }
  if (!input.yes)
    return { dryRun: true, request: { versionId: input.versionId } };
  const response = await entitled(() =>
    client.post<{ data: AscResource<PackageAttributes> }>(
      "/v1/alternativeDistributionPackages",
      {
        data: {
          type: "alternativeDistributionPackages",
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: input.versionId },
            },
          },
        },
      },
    ),
  );
  return {
    dryRun: false,
    requested: { versionId: input.versionId, packageId: response.data.id },
  };
}

export const setMarketplaceInput = z.object({
  appId: appIdSchema,
  catalogUrl: httpsUrl("--catalog-url"),
  yes: yesSchema,
});

/** Sets an app's marketplace catalog URL, creating its search details if there are none. */
export async function setMarketplace(
  client: AscClient,
  input: z.output<typeof setMarketplaceInput>,
) {
  const current = await readSearchDetail(client, input.appId);
  const before = current?.attributes?.catalogUrl ?? null;
  const plan = {
    appId: input.appId,
    catalogUrl: { from: before, to: input.catalogUrl },
  };
  if (before === input.catalogUrl) {
    return { dryRun: !input.yes, unchanged: plan };
  }
  if (!input.yes) return { dryRun: true, set: plan };
  if (current) {
    await entitled(() =>
      client.patch(`/v1/marketplaceSearchDetails/${current.id}`, {
        data: {
          type: "marketplaceSearchDetails",
          id: current.id,
          attributes: { catalogUrl: input.catalogUrl },
        },
      }),
    );
  } else {
    await entitled(() =>
      client.post("/v1/marketplaceSearchDetails", {
        data: {
          type: "marketplaceSearchDetails",
          attributes: { catalogUrl: input.catalogUrl },
          relationships: { app: { data: { type: "apps", id: input.appId } } },
        },
      }),
    );
  }
  return { dryRun: false, set: plan };
}

export const deleteMarketplaceInput = z.object({
  appId: appIdSchema,
  yes: yesSchema,
});

/** Removes an app's marketplace search details. */
export async function deleteMarketplace(
  client: AscClient,
  input: z.output<typeof deleteMarketplaceInput>,
) {
  const current = await readSearchDetail(client, input.appId);
  if (!current) {
    throw new NotFoundError(
      `App ${input.appId} has no marketplace search details to delete.`,
    );
  }
  const shaped = {
    appId: input.appId,
    id: current.id,
    catalogUrl: current.attributes?.catalogUrl,
  };
  if (!input.yes) return { dryRun: true, delete: shaped };
  await entitled(() =>
    client.delete(`/v1/marketplaceSearchDetails/${current.id}`),
  );
  return { dryRun: false, deleted: shaped };
}

export const createMarketplaceWebhookInput = z.object({
  endpointUrl: httpsUrl("--endpoint-url"),
  secretFile: inputPath("--secret-file"),
  yes: yesSchema,
});

/** Adds a marketplace webhook; the secret is read from a file and never printed. */
export async function createMarketplaceWebhook(
  client: AscClient,
  input: z.output<typeof createMarketplaceWebhookInput>,
) {
  const secret = await readText(input.secretFile, "--secret-file");
  const plan = {
    endpointUrl: input.endpointUrl,
    secret: "(from --secret-file)",
  };
  if (!input.yes) return { dryRun: true, create: plan };
  const response = await entitled(() =>
    client.post<{ data: AscResource<{ endpointUrl?: string }> }>(
      "/v1/marketplaceWebhooks",
      {
        data: {
          type: "marketplaceWebhooks",
          attributes: { endpointUrl: input.endpointUrl, secret },
        },
      },
    ),
  );
  return {
    dryRun: false,
    created: {
      id: response.data.id,
      endpointUrl: response.data.attributes?.endpointUrl ?? input.endpointUrl,
    },
  };
}

export const setMarketplaceWebhookInput = z
  .object({
    webhookId: webhookIdSchema,
    endpointUrl: httpsUrl("--endpoint-url").optional(),
    secretFile: inputPath("--secret-file").optional(),
    yes: yesSchema,
  })
  .refine((input) => input.endpointUrl || input.secretFile, {
    message: "Give --endpoint-url, --secret-file or both.",
  });

/** Finds one of the marketplace's webhooks; Apple has no single-webhook read. */
async function findWebhook(client: AscClient, webhookId: string) {
  const { webhooks } = await listMarketplaceWebhooks(client, { limit: 200 });
  const hook = webhooks.find((item) => item.id === webhookId);
  if (!hook) {
    throw new NotFoundError(
      `No marketplace webhook ${webhookId}; list them with alt-distribution webhooks.`,
    );
  }
  return hook;
}

/** Changes a marketplace webhook's endpoint URL or secret. */
export async function setMarketplaceWebhook(
  client: AscClient,
  input: z.output<typeof setMarketplaceWebhookInput>,
) {
  const secret = input.secretFile
    ? await readText(input.secretFile, "--secret-file")
    : undefined;
  const hook = await findWebhook(client, input.webhookId);
  const plan = {
    id: hook.id,
    ...(input.endpointUrl
      ? { endpointUrl: { from: hook.endpointUrl, to: input.endpointUrl } }
      : {}),
    ...(secret ? { secret: "(replaced from --secret-file)" } : {}),
  };
  if (!input.yes) return { dryRun: true, set: plan };
  await entitled(() =>
    client.patch(`/v1/marketplaceWebhooks/${hook.id}`, {
      data: {
        type: "marketplaceWebhooks",
        id: hook.id,
        attributes: {
          ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : {}),
          ...(secret ? { secret } : {}),
        },
      },
    }),
  );
  return { dryRun: false, set: plan };
}

export const deleteMarketplaceWebhookInput = z.object({
  webhookId: webhookIdSchema,
  yes: yesSchema,
});

/** Deletes a marketplace webhook. */
export async function deleteMarketplaceWebhook(
  client: AscClient,
  input: z.output<typeof deleteMarketplaceWebhookInput>,
) {
  const hook = await findWebhook(client, input.webhookId);
  if (!input.yes) return { dryRun: true, delete: hook };
  await entitled(() => client.delete(`/v1/marketplaceWebhooks/${hook.id}`));
  return { dryRun: false, deleted: hook };
}
