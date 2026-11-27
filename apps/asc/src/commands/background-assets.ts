import { stat } from "node:fs/promises";
import { basename } from "node:path";
import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  related,
  type UploadOperation,
} from "../asc/client.ts";
import { appIdSchema, idSchema } from "../schemas/common.ts";
import {
  AscApiError,
  InvalidInputError,
  NotFoundError,
  UnexpectedResponseError,
  UploadIncompleteError,
  WaitTimeoutError,
} from "../utils/errors.ts";
import { md5, sendParts } from "./build-upload.ts";
import type { WaitDependencies } from "./builds.ts";

/**
 * Apple-hosted background assets: asset packs that download apart from the
 * app. Each pack (backgroundAssets) has numbered versions; a version is
 * created empty, its archive (and optionally a manifest) is reserved as a
 * backgroundAssetUploadFile, sent in the parts Apple lists and committed,
 * and Apple then processes it. Apple numbers versions itself and creates
 * their TestFlight and App Store releases.
 */

const packIdSchema = idSchema("background-assets");
const versionIdSchema = idSchema("background-assets");

/** Version states while Apple still waits for the file or processes it. */
const PENDING_STATES = new Set(["AWAITING_UPLOAD", "PROCESSING"]);

interface PackAttributes {
  assetPackIdentifier?: string;
  archived?: boolean;
  createdDate?: string;
  usedBytes?: number;
}

interface StateDetail {
  code?: string;
  description?: string;
}

interface VersionAttributes {
  version?: string;
  state?: string;
  platforms?: string[] | null;
  locale?: string | null;
  createdDate?: string;
  stateDetails?: {
    errors?: StateDetail[] | null;
    warnings?: StateDetail[] | null;
  } | null;
}

interface UploadFileAttributes {
  uploadOperations?: UploadOperation[] | null;
}

function shapePack({ id, attributes: a }: AscResource<PackAttributes>) {
  return {
    id,
    assetPackIdentifier: a?.assetPackIdentifier,
    archived: a?.archived ?? false,
    usedBytes: a?.usedBytes ?? null,
    createdDate: a?.createdDate ?? null,
  };
}

const VERSION_QUERY = {
  "fields[backgroundAssetVersions]": [
    "version",
    "state",
    "platforms",
    "locale",
    "createdDate",
    "stateDetails",
    "internalBetaRelease",
    "externalBetaRelease",
    "appStoreRelease",
  ],
  include: ["internalBetaRelease", "externalBetaRelease", "appStoreRelease"],
};

function shapeVersion(
  document: Pick<AscDocument<unknown>, "included">,
  version: AscResource<VersionAttributes>,
) {
  const a = version.attributes;
  const describe = (details?: StateDetail[] | null) =>
    (details ?? []).map(({ code, description }) => ({ code, description }));
  const release = (name: string) =>
    related<{ state?: string }>(document, version, name)?.state ?? null;
  return {
    id: version.id,
    version: a?.version,
    state: a?.state,
    platforms: a?.platforms ?? [],
    locale: a?.locale ?? null,
    createdDate: a?.createdDate ?? null,
    errors: describe(a?.stateDetails?.errors),
    warnings: describe(a?.stateDetails?.warnings),
    internalBeta: release("internalBetaRelease"),
    externalBeta: release("externalBetaRelease"),
    appStore: release("appStoreRelease"),
  };
}

async function listVersions(client: AscClient, packId: string, limit: number) {
  const response = await client.get<AscDocument<VersionAttributes>>(
    `/v1/backgroundAssets/${packId}/versions`,
    { sort: "-version", limit, ...VERSION_QUERY },
  );
  return response.data.map((version) => shapeVersion(response, version));
}

export const backgroundAssetsInput = z.object({
  appId: appIdSchema,
  archived: z.boolean().default(false),
  versions: z.coerce.number().int().min(1).max(50).default(5),
});

/** An app's asset packs, each with its newest versions and their release states. */
export async function listBackgroundAssets(
  client: AscClient,
  input: z.output<typeof backgroundAssetsInput>,
) {
  const response = await client.get<AscDocument<PackAttributes>>(
    `/v1/apps/${input.appId}/backgroundAssets`,
    {
      "fields[backgroundAssets]": [
        "assetPackIdentifier",
        "archived",
        "createdDate",
        "usedBytes",
      ],
      "filter[archived]": input.archived ? undefined : "false",
      sort: "assetPackIdentifier",
      limit: 200,
    },
  );
  const packs = [];
  for (const pack of response.data) {
    packs.push({
      ...shapePack(pack),
      versions: await listVersions(client, pack.id, input.versions),
    });
  }
  return { packs };
}

/** A file to upload: its name and size, checked before anything is sent. */
async function readFileInfo(path: string, what: string) {
  let fileSize: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    fileSize = info.size;
  } catch {
    throw new NotFoundError(`Could not read the ${what} ${path}.`);
  }
  if (fileSize === 0) {
    throw new InvalidInputError(`${basename(path)} is empty.`);
  }
  return { path, fileName: basename(path), fileSize };
}

export const uploadBackgroundAssetInput = z.object({
  packId: packIdSchema,
  file: z
    .string({ error: "Give the asset pack archive with --file." })
    .trim()
    .min(1, "Give the asset pack archive with --file."),
  manifest: z.string().trim().min(1).optional(),
  yes: z.boolean().default(false),
});

/**
 * Uploads a new version of an asset pack. Without `yes`, checks the files
 * and the pack and shows what would be uploaded.
 */
export async function uploadBackgroundAsset(
  client: AscClient,
  input: z.output<typeof uploadBackgroundAssetInput>,
) {
  const files = [
    { assetType: "ASSET", ...(await readFileInfo(input.file, "archive")) },
    ...(input.manifest
      ? [
          {
            assetType: "MANIFEST",
            ...(await readFileInfo(input.manifest, "manifest")),
          },
        ]
      : []),
  ];
  const { data: pack } = await client.get<{
    data: AscResource<PackAttributes>;
  }>(`/v1/backgroundAssets/${input.packId}`, {
    "fields[backgroundAssets]": [
      "assetPackIdentifier",
      "archived",
      "createdDate",
      "usedBytes",
    ],
  });
  if (pack.attributes?.archived) {
    throw new InvalidInputError(
      `Asset pack ${pack.attributes.assetPackIdentifier ?? input.packId} is archived; unarchive it in App Store Connect before uploading.`,
    );
  }
  const [latest] = await listVersions(client, input.packId, 1);
  const planned = {
    pack: shapePack(pack),
    latestVersion: latest ?? null,
    files: files.map(({ assetType, fileName, fileSize }) => ({
      assetType,
      fileName,
      fileSize,
    })),
  };
  if (!input.yes) return { dryRun: true, action: "upload", ...planned };

  const { data: version } = await client.post<{
    data: AscResource<VersionAttributes>;
  }>("/v1/backgroundAssetVersions", {
    data: {
      type: "backgroundAssetVersions",
      relationships: {
        backgroundAsset: {
          data: { type: "backgroundAssets", id: input.packId },
        },
      },
    },
  });

  try {
    for (const file of files) {
      const checksum = await md5(file.path);
      const { data: reserved } = await client.post<{
        data: AscResource<UploadFileAttributes>;
      }>("/v1/backgroundAssetUploadFiles", {
        data: {
          type: "backgroundAssetUploadFiles",
          attributes: {
            assetType: file.assetType,
            fileName: file.fileName,
            fileSize: file.fileSize,
          },
          relationships: {
            backgroundAssetVersion: {
              data: { type: "backgroundAssetVersions", id: version.id },
            },
          },
        },
      });
      const operations = reserved.attributes?.uploadOperations ?? [];
      if (operations.length === 0) {
        throw new UnexpectedResponseError(
          "App Store Connect reserved the file but gave no upload operations.",
        );
      }
      await sendParts(client, file.path, file.fileSize, operations);
      await client.patch(`/v1/backgroundAssetUploadFiles/${reserved.id}`, {
        data: {
          type: "backgroundAssetUploadFiles",
          id: reserved.id,
          attributes: {
            uploaded: true,
            sourceFileChecksums: { file: { hash: checksum, algorithm: "MD5" } },
          },
        },
      });
    }
  } catch (error) {
    throw new UploadIncompleteError(
      `Version ${version.attributes?.version ?? version.id} of the asset pack was created but its files were not all committed; run the command again to upload a new version.`,
      { cause: error },
    );
  }
  return {
    dryRun: false,
    action: "upload",
    ...planned,
    version: {
      id: version.id,
      version: version.attributes?.version,
      state: version.attributes?.state,
    },
  };
}

export const waitBackgroundAssetInput = z.object({
  versionId: versionIdSchema,
  timeout: z.coerce.number().int().min(1).max(180).default(30),
  interval: z.coerce.number().int().min(10).max(300).default(30),
});

const MAX_BACKOFF_MS = 600_000;

/** Waits until Apple finishes processing a version, then returns it. */
export async function waitForBackgroundAsset(
  client: AscClient,
  input: z.output<typeof waitBackgroundAssetInput>,
  { sleep, now, progress }: WaitDependencies,
) {
  const deadline = now() + input.timeout * 60_000;
  const intervalMs = input.interval * 1000;
  let backoffMs = 0;
  let lastSeen = "unknown";
  for (;;) {
    let delayMs = intervalMs;
    try {
      const response = await client.get<{
        data: AscResource<VersionAttributes>;
        included?: AscResource[];
      }>(`/v1/backgroundAssetVersions/${input.versionId}`, VERSION_QUERY);
      backoffMs = 0;
      const version = shapeVersion(response, response.data);
      if (!PENDING_STATES.has(version.state ?? "")) return version;
      lastSeen = version.state ?? lastSeen;
      progress(`Asset pack version ${version.version}: ${lastSeen}`);
    } catch (error) {
      if (!(error instanceof AscApiError && error.status === 429)) throw error;
      backoffMs = Math.min(Math.max(backoffMs * 2, 60_000), MAX_BACKOFF_MS);
      delayMs = Math.max(intervalMs, backoffMs);
      progress(
        `Rate limited by App Store Connect; retrying in ${Math.round(delayMs / 1000)}s`,
      );
    }
    if (now() + delayMs > deadline) {
      throw new WaitTimeoutError(
        `The asset pack version was still ${lastSeen} after ${input.timeout} minute${input.timeout === 1 ? "" : "s"}; ${lastSeen === "AWAITING_UPLOAD" ? "its files may not have been committed, so upload a new version" : "run the command again to keep waiting"}.`,
      );
    }
    await sleep(delayMs);
  }
}
