import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscQuery,
  type AscResource,
  pageInfo,
  related,
} from "../asc/client.ts";
import {
  appIdSchema,
  commaList,
  cursorSchema,
  limitSchema,
} from "../schemas/common.ts";
import { AscApiError, WaitTimeoutError } from "../utils/errors.ts";

interface BuildAttributes {
  version?: string;
  uploadedDate?: string;
  expirationDate?: string;
  expired?: boolean;
  minOsVersion?: string;
  processingState?: string;
  buildAudienceType?: string | null;
}

interface PreReleaseVersionAttributes {
  version?: string;
  platform?: string;
}

type BuildsDocument = AscDocument<BuildAttributes>;

const buildNumberSchema = z.string().trim().min(1).max(100);

export const buildsInput = z.object({
  appId: appIdSchema,
  processingState: commaList(
    z.enum(["PROCESSING", "FAILED", "INVALID", "VALID"]),
  ),
  expired: z.boolean().optional(),
  buildNumber: buildNumberSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** Newest upload first, with the marketing version and platform from the pre-release version. */
function buildsQuery(appId: string, buildNumber?: string): AscQuery {
  return {
    "filter[app]": appId,
    "filter[version]": buildNumber,
    sort: "-uploadedDate",
    include: "preReleaseVersion",
    "fields[builds]": [
      "version",
      "uploadedDate",
      "expirationDate",
      "expired",
      "minOsVersion",
      "processingState",
      "buildAudienceType",
      "preReleaseVersion",
    ],
    "fields[preReleaseVersions]": ["version", "platform"],
  };
}

function shapeBuild(
  response: BuildsDocument,
  build: AscResource<BuildAttributes>,
) {
  const preRelease = related<PreReleaseVersionAttributes>(
    response,
    build,
    "preReleaseVersion",
  );
  return {
    id: build.id,
    version: build.attributes?.version,
    marketingVersion: preRelease?.version,
    platform: preRelease?.platform,
    processingState: build.attributes?.processingState,
    uploadedDate: build.attributes?.uploadedDate,
    expirationDate: build.attributes?.expirationDate,
    expired: build.attributes?.expired,
    buildAudienceType: build.attributes?.buildAudienceType,
    minOsVersion: build.attributes?.minOsVersion,
  };
}

export type Build = ReturnType<typeof shapeBuild>;

export async function listBuilds(
  client: AscClient,
  input: z.output<typeof buildsInput>,
) {
  const response = await client.get<BuildsDocument>("/v1/builds", {
    ...buildsQuery(input.appId, input.buildNumber),
    "filter[processingState]": input.processingState,
    "filter[expired]": input.expired,
    limit: input.limit,
    cursor: input.cursor,
  });
  return {
    builds: response.data.map((build) => shapeBuild(response, build)),
    ...pageInfo(response),
  };
}

export const waitInput = z.object({
  appId: appIdSchema,
  buildNumber: buildNumberSchema,
  timeout: z.coerce.number().int().min(1).max(180).default(30),
  interval: z.coerce.number().int().min(10).max(300).default(30),
});

export interface WaitDependencies {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** One line of progress, written to stderr so stdout stays a single JSON result. */
  progress: (line: string) => void;
}

// After a 429, wait at least this long, doubling up to the cap.
const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 600_000;

/**
 * Polls until the newest build with this build number leaves `PROCESSING`.
 * A build not visible yet (just uploaded) counts as still processing.
 */
export async function waitForBuild(
  client: AscClient,
  input: z.output<typeof waitInput>,
  { sleep, now, progress }: WaitDependencies,
): Promise<Build> {
  const deadline = now() + input.timeout * 60_000;
  const intervalMs = input.interval * 1000;
  let backoffMs = 0;
  let lastSeen = "not visible yet";

  for (;;) {
    let delayMs = intervalMs;
    try {
      const response = await client.get<BuildsDocument>("/v1/builds", {
        ...buildsQuery(input.appId, input.buildNumber),
        limit: 1,
      });
      backoffMs = 0;
      const resource = response.data[0];
      const build = resource && shapeBuild(response, resource);
      if (build?.processingState && build.processingState !== "PROCESSING") {
        return build;
      }
      lastSeen = build ? (build.processingState ?? "PROCESSING") : lastSeen;
      progress(`Build ${input.buildNumber}: ${lastSeen}`);
    } catch (error) {
      if (!(error instanceof AscApiError && error.status === 429)) throw error;
      backoffMs = Math.min(
        Math.max(backoffMs * 2, MIN_BACKOFF_MS),
        MAX_BACKOFF_MS,
      );
      delayMs = Math.max(intervalMs, backoffMs);
      progress(
        `Rate limited by App Store Connect; retrying in ${Math.round(delayMs / 1000)}s`,
      );
    }
    if (now() + delayMs > deadline) {
      const minutes = `${input.timeout} minute${input.timeout === 1 ? "" : "s"}`;
      throw new WaitTimeoutError(
        lastSeen === "not visible yet"
          ? `Build ${input.buildNumber} did not appear within ${minutes}; check the build number with the builds command, or run this again if the upload is recent.`
          : `Build ${input.buildNumber} was still ${lastSeen === "PROCESSING" ? "processing" : lastSeen} after ${minutes}; run the command again to keep waiting.`,
      );
    }
    await sleep(delayMs);
  }
}
