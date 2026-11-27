import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import * as z from "zod";
import type { AscClient, AscResource, UploadOperation } from "../asc/client.ts";
import { appIdSchema } from "../schemas/common.ts";
import {
  InvalidInputError,
  NotFoundError,
  UnexpectedResponseError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import {
  type BuildsDocument,
  buildsQuery,
  shapeBuild,
  type WaitDependencies,
  waitForBuild,
} from "./builds.ts";

/**
 * Uploads an .ipa or .pkg through App Store Connect's build uploads: a build
 * upload names the app, version and build number, a build upload file is
 * reserved for the binary, its parts go to the URLs Apple's response lists,
 * and the file is committed with its MD5 checksum. Apple then processes it
 * into a build, which `builds wait` follows.
 */

const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;

/** Apple's uniform type identifier for each binary the API takes. */
const UTIS = {
  ".ipa": "com.apple.ipa",
  ".pkg": "com.apple.pkg",
} as const;

/** CFBundleShortVersionString and CFBundleVersion: up to three period-separated integers. */
const bundleVersion = (what: string) =>
  z
    .string({ error: `Give the ${what}.` })
    .trim()
    .regex(
      /^\d{1,18}(\.\d{1,18}){0,2}$/,
      `The ${what} must be up to three period-separated numbers, such as 1.2.3.`,
    );

export const buildUploadInput = z.object({
  appId: appIdSchema,
  file: z.string({ error: "Give the .ipa or .pkg with --file." }).min(1),
  version: bundleVersion(
    "version (CFBundleShortVersionString) with --app-version",
  ),
  buildNumber: bundleVersion(
    "build number (CFBundleVersion) with --build-number",
  ),
  platform: z.enum(PLATFORMS).optional(),
  wait: z.boolean().default(false),
  timeout: z.coerce.number().int().min(1).max(180).default(30),
  interval: z.coerce.number().int().min(10).max(300).default(30),
  yes: z.boolean().default(false),
});

interface UploadStateDetail {
  code?: string;
  description?: string;
}

interface BuildUploadAttributes {
  cfBundleShortVersionString?: string;
  cfBundleVersion?: string;
  platform?: string;
  createdDate?: string;
  uploadedDate?: string | null;
  state?: {
    state?: string;
    errors?: UploadStateDetail[] | null;
    warnings?: UploadStateDetail[] | null;
    infos?: UploadStateDetail[] | null;
  } | null;
}

interface BuildUploadFileAttributes {
  uploadOperations?: UploadOperation[] | null;
}

/** The file, its type and the platform it is for, checked before anything is sent. */
async function readBinary(path: string, platform?: (typeof PLATFORMS)[number]) {
  const extension = extname(path).toLowerCase();
  if (extension !== ".ipa" && extension !== ".pkg") {
    throw new InvalidInputError(
      `${basename(path)} is not an .ipa or .pkg: export the archive from Xcode first.`,
    );
  }
  let fileSize: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    fileSize = info.size;
  } catch {
    throw new NotFoundError(`Could not read the file ${path}.`);
  }
  if (fileSize === 0) {
    throw new InvalidInputError(`${basename(path)} is empty.`);
  }
  // A .pkg is a Mac app; the other platforms ship an .ipa.
  const resolved = platform ?? (extension === ".pkg" ? "MAC_OS" : "IOS");
  if ((extension === ".pkg") !== (resolved === "MAC_OS")) {
    throw new InvalidInputError(
      `A ${extension} is not a ${resolved} build: a Mac app is a .pkg and the other platforms are an .ipa.`,
    );
  }
  return {
    fileName: basename(path),
    fileSize,
    uti: UTIS[extension],
    platform: resolved,
  };
}

/** The file's MD5, read as a stream so a large binary is never held in memory. */
async function md5(path: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Sends each part Apple asked for, reading only that part of the file. */
async function sendParts(
  client: AscClient,
  path: string,
  fileSize: number,
  operations: UploadOperation[],
) {
  const file = await open(path, "r");
  try {
    for (const operation of operations) {
      const { offset = 0, length = 0 } = operation;
      if (offset < 0 || length <= 0 || offset + length > fileSize) {
        throw new UnexpectedResponseError(
          "App Store Connect asked for a part outside the file.",
        );
      }
      const part = new Uint8Array(length);
      const { bytesRead } = await file.read(part, 0, length, offset);
      if (bytesRead !== length) {
        throw new InvalidInputError(
          `${basename(path)} changed while it was being uploaded.`,
        );
      }
      await client.upload(operation, part);
    }
  } finally {
    await file.close();
  }
}

function shapeUpload(upload: AscResource<BuildUploadAttributes>) {
  const state = upload.attributes?.state;
  const describe = (details?: UploadStateDetail[] | null) =>
    (details ?? []).map(({ code, description }) => ({ code, description }));
  return {
    id: upload.id,
    version: upload.attributes?.cfBundleShortVersionString,
    buildNumber: upload.attributes?.cfBundleVersion,
    platform: upload.attributes?.platform,
    state: state?.state,
    errors: describe(state?.errors),
    warnings: describe(state?.warnings),
    buildId: upload.relationships?.build?.data?.id,
  };
}

/**
 * Uploads a build. Without `yes`, checks the file and the app and shows
 * what would be uploaded. With `wait`, follows the build until Apple
 * finishes processing it, as `builds wait` does.
 */
export async function uploadBuild(
  client: AscClient,
  input: z.output<typeof buildUploadInput>,
  wait: WaitDependencies,
) {
  const binary = await readBinary(input.file, input.platform);
  const { data: app } = await client.get<{
    data: AscResource<{ name?: string; bundleId?: string }>;
  }>(`/v1/apps/${input.appId}`, { "fields[apps]": ["name", "bundleId"] });

  // Apple refuses a second build with the same number for a version, so stop before sending the file.
  const existing = await client.get<BuildsDocument>("/v1/builds", {
    ...buildsQuery(input.appId, input.buildNumber),
    limit: 200,
  });
  const duplicate = existing.data
    .map((build) => shapeBuild(existing, build))
    .find(
      (build) =>
        build.marketingVersion === input.version &&
        build.platform === binary.platform,
    );
  if (duplicate) {
    throw new InvalidInputError(
      `${app.attributes?.name ?? input.appId} already has build ${input.buildNumber} of version ${input.version} (${duplicate.id}); raise CFBundleVersion and export again.`,
    );
  }

  const planned = {
    app: {
      id: app.id,
      name: app.attributes?.name,
      bundleId: app.attributes?.bundleId,
    },
    version: input.version,
    buildNumber: input.buildNumber,
    platform: binary.platform,
    file: {
      fileName: binary.fileName,
      fileSize: binary.fileSize,
      uti: binary.uti,
    },
  };
  if (!input.yes) return { dryRun: true, action: "upload", ...planned };

  const checksum = await md5(input.file);
  const { data: upload } = await client.post<{
    data: AscResource<BuildUploadAttributes>;
  }>("/v1/buildUploads", {
    data: {
      type: "buildUploads",
      attributes: {
        cfBundleShortVersionString: input.version,
        cfBundleVersion: input.buildNumber,
        platform: binary.platform,
      },
      relationships: { app: { data: { type: "apps", id: input.appId } } },
    },
  });

  try {
    const { data: reserved } = await client.post<{
      data: AscResource<BuildUploadFileAttributes>;
    }>("/v1/buildUploadFiles", {
      data: {
        type: "buildUploadFiles",
        attributes: {
          assetType: "ASSET",
          fileName: binary.fileName,
          fileSize: binary.fileSize,
          uti: binary.uti,
        },
        relationships: {
          buildUpload: { data: { type: "buildUploads", id: upload.id } },
        },
      },
    });
    const operations = reserved.attributes?.uploadOperations ?? [];
    if (operations.length === 0) {
      throw new UnexpectedResponseError(
        "App Store Connect reserved the file but gave no upload operations.",
      );
    }
    await sendParts(client, input.file, binary.fileSize, operations);
    await client.patch(`/v1/buildUploadFiles/${reserved.id}`, {
      data: {
        type: "buildUploadFiles",
        id: reserved.id,
        attributes: {
          uploaded: true,
          sourceFileChecksums: { file: { hash: checksum, algorithm: "MD5" } },
        },
      },
    });
  } catch (error) {
    throw new UploadIncompleteError(
      `The build upload ${upload.id} was created but its file was not committed; run the command again to start a new upload.`,
      { cause: error },
    );
  }

  const { data: committed } = await client.get<{
    data: AscResource<BuildUploadAttributes>;
  }>(`/v1/buildUploads/${upload.id}`, { include: "build" });
  const result = {
    dryRun: false,
    action: "upload",
    ...planned,
    upload: shapeUpload(committed),
  };
  if (!input.wait) return result;
  const build = await waitForBuild(
    client,
    {
      appId: input.appId,
      buildNumber: input.buildNumber,
      timeout: input.timeout,
      interval: input.interval,
    },
    wait,
  );
  return { ...result, build };
}
