import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  PLATFORMS,
} from "../schemas/common.ts";
import {
  AscApiError,
  InvalidInputError,
  NotFoundError,
  UploadIncompleteError,
  WaitTimeoutError,
} from "../utils/errors.ts";

interface BuildAttributes {
  version?: string;
  uploadedDate?: string;
  expirationDate?: string;
  expired?: boolean;
  minOsVersion?: string;
  processingState?: string;
  buildAudienceType?: string | null;
  /** The export compliance answer; null until someone answers it. */
  usesNonExemptEncryption?: boolean | null;
}

interface PreReleaseVersionAttributes {
  version?: string;
  platform?: string;
}

export type BuildsDocument = AscDocument<BuildAttributes>;

const buildNumberSchema = z.string().trim().min(1).max(100);

export const buildsInput = z.object({
  appId: appIdSchema,
  processingState: commaList(
    z.enum(["PROCESSING", "FAILED", "INVALID", "VALID"]),
  ),
  expired: z.boolean().optional(),
  buildNumber: buildNumberSchema.optional(),
  group: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9-]{1,100}$/,
      "Must be an id from the testflight groups command.",
    )
    .optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** The build fields `shapeBuild` reads, with the marketing version and platform from the pre-release version. */
const BUILD_QUERY = {
  include: "preReleaseVersion",
  "fields[builds]": [
    "version",
    "uploadedDate",
    "expirationDate",
    "expired",
    "minOsVersion",
    "processingState",
    "buildAudienceType",
    "usesNonExemptEncryption",
    "preReleaseVersion",
  ],
  "fields[preReleaseVersions]": ["version", "platform"],
} satisfies AscQuery;

/** Newest upload first. */
export function buildsQuery(appId: string, buildNumber?: string): AscQuery {
  return {
    "filter[app]": appId,
    "filter[version]": buildNumber,
    sort: "-uploadedDate",
    ...BUILD_QUERY,
  };
}

export function shapeBuild(
  response: Pick<AscDocument<unknown>, "included">,
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
    usesNonExemptEncryption: build.attributes?.usesNonExemptEncryption,
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
    "filter[betaGroups]": input.group,
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

/** Build IDs are opaque; letters, digits and hyphens keep them to one path segment. */
const buildIdSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9-]{1,100}$/,
    "Must be a build id from the builds command.",
  );

export const complianceInput = z.object({
  buildId: buildIdSchema,
  usesNonExemptEncryption: z.boolean({
    error: "Give --no-encryption or --encryption.",
  }),
  yes: z.boolean().default(false),
});

interface BuildDocument {
  data: AscResource<BuildAttributes>;
  included?: AscResource[];
}

/**
 * Answers a build's export compliance question: whether it uses non-exempt
 * encryption. Without `yes`, only shows the build and what would change.
 */
export async function setBuildCompliance(
  client: AscClient,
  input: z.output<typeof complianceInput>,
) {
  const document = await client.get<BuildDocument>(
    `/v1/builds/${input.buildId}`,
    BUILD_QUERY,
  );
  const build = shapeBuild(document, document.data);
  const changes =
    build.usesNonExemptEncryption !== input.usesNonExemptEncryption;
  if (!input.yes) {
    return {
      dryRun: true,
      action: "compliance",
      build,
      usesNonExemptEncryption: input.usesNonExemptEncryption,
      changes,
    };
  }
  if (changes) {
    await client.patch(`/v1/builds/${input.buildId}`, {
      data: {
        type: "builds",
        id: input.buildId,
        attributes: { usesNonExemptEncryption: input.usesNonExemptEncryption },
      },
    });
  }
  return {
    dryRun: false,
    action: "compliance",
    buildId: input.buildId,
    usesNonExemptEncryption: input.usesNonExemptEncryption,
    changed: changes,
  };
}

export const expireInput = z.object({
  buildId: buildIdSchema,
  yes: z.boolean().default(false),
});

/**
 * Expires a build so testers can no longer install it from TestFlight. This
 * cannot be undone. Without `yes`, only shows the build and whether it is
 * already expired.
 */
export async function expireBuild(
  client: AscClient,
  input: z.output<typeof expireInput>,
) {
  const document = await client.get<BuildDocument>(
    `/v1/builds/${input.buildId}`,
    BUILD_QUERY,
  );
  const build = shapeBuild(document, document.data);
  const changes = build.expired !== true;
  if (!input.yes) {
    return { dryRun: true, action: "expire", build, changes };
  }
  if (changes) {
    await client.patch(`/v1/builds/${input.buildId}`, {
      data: {
        type: "builds",
        id: input.buildId,
        attributes: { expired: true },
      },
    });
  }
  return {
    dryRun: false,
    action: "expire",
    buildId: input.buildId,
    changed: changes,
  };
}

const platformSchema = z.enum(PLATFORMS).optional();
const marketingVersionSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+){0,2}$/, "Must be a version such as 2.5.0.")
  .optional();

/** Every page of an app's builds matching the query, newest upload first. */
async function allBuilds(client: AscClient, query: AscQuery) {
  const builds: Build[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.get<BuildsDocument>("/v1/builds", {
      ...query,
      limit: 200,
      cursor,
    });
    builds.push(...response.data.map((build) => shapeBuild(response, build)));
    const page = pageInfo(response);
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor);
  return builds;
}

export const expireBuildsInput = z
  .object({
    appId: appIdSchema,
    olderThan: buildIdSchema.optional(),
    keep: z.coerce.number().int().min(0).max(1000).optional(),
    platform: platformSchema,
    yes: z.boolean().default(false),
  })
  .refine(
    (input) => (input.olderThan === undefined) !== (input.keep === undefined),
    "Give --older-than <build-id> or --keep <n>, not both.",
  );

/**
 * Expires many of an app's unexpired builds at once: every one uploaded
 * before --older-than's build, or all but the --keep newest. This cannot be
 * undone. Without `yes`, lists every build it would expire.
 */
export async function expireBuilds(
  client: AscClient,
  input: z.output<typeof expireBuildsInput>,
) {
  let cutoff: Build | undefined;
  if (input.olderThan) {
    const document = await client.get<BuildDocument>(
      `/v1/builds/${input.olderThan}`,
      {
        ...BUILD_QUERY,
        include: `${BUILD_QUERY.include},app`,
        "fields[builds]": [...BUILD_QUERY["fields[builds]"], "app"],
        "fields[apps]": ["bundleId"],
      },
    );
    if (document.data.relationships?.app?.data?.id !== input.appId) {
      throw new InvalidInputError(
        `Build ${input.olderThan} belongs to another app. Nothing was changed.`,
      );
    }
    cutoff = shapeBuild(document, document.data);
  }
  const unexpired = await allBuilds(client, {
    ...buildsQuery(input.appId),
    "filter[expired]": false,
    "filter[preReleaseVersion.platform]": input.platform,
  });
  const targets = cutoff
    ? unexpired.filter(
        (build) =>
          build.id !== cutoff.id &&
          build.uploadedDate !== undefined &&
          cutoff.uploadedDate !== undefined &&
          build.uploadedDate < cutoff.uploadedDate &&
          (input.platform !== undefined || build.platform === cutoff.platform),
      )
    : unexpired.slice(input.keep);
  if (!input.yes) {
    return {
      dryRun: true,
      action: "expire-builds",
      appId: input.appId,
      ...(cutoff ? { olderThan: cutoff } : { keep: input.keep }),
      count: targets.length,
      builds: targets,
      note: "Expiring a build cannot be undone; testers can no longer install it.",
    };
  }
  const expired: string[] = [];
  for (const build of targets) {
    try {
      await client.patch(`/v1/builds/${build.id}`, {
        data: { type: "builds", id: build.id, attributes: { expired: true } },
      });
    } catch (error) {
      throw new UploadIncompleteError(
        `Stopped at build ${build.version} (${build.id}) after expiring ${expired.length} of ${targets.length} builds${expired.length > 0 ? `: ${expired.join(", ")}` : ""}.`,
        { cause: error },
      );
    }
    expired.push(build.id);
  }
  return {
    dryRun: false,
    action: "expire-builds",
    appId: input.appId,
    count: expired.length,
    expired,
  };
}

/** Compares build numbers such as 9, 10 and 1.2.10 part by part as numbers. */
function compareBuildNumbers(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = Number(left[i] ?? 0);
    const y = Number(right[i] ?? 0);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      return (left[i] ?? "").localeCompare(right[i] ?? "");
    }
    if (x !== y) return x - y;
  }
  return 0;
}

/** The build number after this one: its last part plus one, or null when that part is not a number. */
function nextBuildNumber(buildNumber: string): string | null {
  const parts = buildNumber.split(".");
  const last = parts.at(-1) ?? "";
  if (!/^\d+$/.test(last)) return null;
  parts[parts.length - 1] = String(Number(last) + 1);
  return parts.join(".");
}

export const latestInput = z.object({
  appId: appIdSchema,
  appVersion: marketingVersionSchema,
  platform: platformSchema,
  next: z.boolean().default(false),
});

/**
 * The highest build number among an app's 200 most recent uploads, optionally
 * for one marketing version and platform, with its state; `next` adds the
 * number to upload next. Expired and failed builds count, since Apple does not
 * take a build number twice.
 */
export async function latestBuild(
  client: AscClient,
  input: z.output<typeof latestInput>,
) {
  const response = await client.get<BuildsDocument>("/v1/builds", {
    ...buildsQuery(input.appId),
    "filter[preReleaseVersion.version]": input.appVersion,
    "filter[preReleaseVersion.platform]": input.platform,
    limit: 200,
  });
  const builds = response.data
    .map((build) => shapeBuild(response, build))
    .filter((build) => build.version !== undefined);
  const latest = builds.reduce<Build | undefined>(
    (best, build) =>
      !best || compareBuildNumbers(build.version ?? "", best.version ?? "") > 0
        ? build
        : best,
    undefined,
  );
  if (!latest?.version) {
    throw new NotFoundError(
      `The app has no builds${input.appVersion ? ` for version ${input.appVersion}` : ""}${input.platform ? ` on ${input.platform}` : ""}.`,
    );
  }
  return {
    buildNumber: latest.version,
    ...(input.next ? { next: nextBuildNumber(latest.version) } : {}),
    id: latest.id,
    marketingVersion: latest.marketingVersion,
    platform: latest.platform,
    processingState: latest.processingState,
    expired: latest.expired,
    uploadedDate: latest.uploadedDate,
  };
}

interface BuildBundleAttributes {
  bundleId?: string;
  bundleType?: string;
  fileName?: string;
  includesSymbols?: boolean;
  dSYMUrl?: string | null;
}

export const dsymsInput = z
  .object({
    buildId: buildIdSchema.optional(),
    appId: appIdSchema.optional(),
    appVersion: marketingVersionSchema,
    buildNumber: buildNumberSchema.optional(),
    platform: platformSchema,
    out: z
      .string({ error: "Name the directory to write to with --out." })
      .min(1),
    overwrite: z.boolean().default(false),
  })
  .refine(
    (input) =>
      input.buildId !== undefined
        ? input.appId === undefined && input.buildNumber === undefined
        : input.appId !== undefined && input.buildNumber !== undefined,
    "Give a build id, or --app with --build-number (and --app-version or --platform if needed), not both.",
  );

/** The build a dSYM download names by app, build number and optionally version and platform. */
async function findBuildId(
  client: AscClient,
  input: z.output<typeof dsymsInput>,
): Promise<string> {
  const response = await client.get<BuildsDocument>("/v1/builds", {
    "filter[app]": input.appId,
    "filter[version]": input.buildNumber,
    "filter[preReleaseVersion.version]": input.appVersion,
    "filter[preReleaseVersion.platform]": input.platform,
    "fields[builds]": ["version"],
    limit: 2,
  });
  const [first, second] = response.data;
  if (!first) {
    throw new NotFoundError(
      `The app has no build ${input.buildNumber}${input.appVersion ? ` for version ${input.appVersion}` : ""}.`,
    );
  }
  if (second) {
    throw new InvalidInputError(
      `More than one build is numbered ${input.buildNumber}; add --app-version or --platform, or give the build id.`,
    );
  }
  return first.id;
}

/** A file name from Apple's bundle id, with anything but letters, digits, dots, dashes and underscores replaced. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
}

/**
 * Downloads a build's dSYMs into a directory, one file per bundle (app, app
 * clip, watch app) that Apple has symbols for, from the URLs Apple's response
 * gives and without the App Store Connect token. Existing files are left
 * alone unless `overwrite`, and are checked before anything is downloaded.
 */
export async function downloadDsyms(
  client: AscClient,
  input: z.output<typeof dsymsInput>,
) {
  const buildId = input.buildId ?? (await findBuildId(client, input));
  const document = await client.get<BuildDocument>(`/v1/builds/${buildId}`, {
    "fields[builds]": ["version", "buildBundles"],
    include: "buildBundles",
    "fields[buildBundles]": [
      "bundleId",
      "bundleType",
      "fileName",
      "includesSymbols",
      "dSYMUrl",
    ],
    "limit[buildBundles]": 50,
  });
  const version = document.data.attributes?.version;
  const bundles = (document.included ?? []).filter(
    (resource) => resource.type === "buildBundles",
  ) as AscResource<BuildBundleAttributes>[];
  const withSymbols = bundles.filter((bundle) => bundle.attributes?.dSYMUrl);
  if (withSymbols.length === 0) {
    throw new NotFoundError(
      `Build ${version ?? buildId} has no dSYMs in App Store Connect; Apple keeps them only for builds uploaded with symbols.`,
    );
  }
  const directory = resolve(input.out);
  const planned = withSymbols.map((bundle) => {
    const name = safeName(
      `${bundle.attributes?.bundleId ?? bundle.id}-${version ?? buildId}.dSYM.zip`,
    );
    return { bundle, name, path: join(directory, name) };
  });
  if (!input.overwrite) {
    for (const file of planned) {
      const exists = await access(file.path).then(
        () => true,
        () => false,
      );
      if (exists) {
        throw new InvalidInputError(
          `${file.path} already exists; give --overwrite to replace it, or another --out. Nothing was downloaded.`,
        );
      }
    }
  }
  await mkdir(directory, { recursive: true });
  const files = [];
  for (const { bundle, name, path } of planned) {
    const bytes = await client.downloadSigned(bundle.attributes?.dSYMUrl ?? "");
    await writeFile(path, bytes, { flag: input.overwrite ? "w" : "wx" });
    files.push({
      bundleId: bundle.attributes?.bundleId,
      bundleType: bundle.attributes?.bundleType,
      file: name,
      bytes: bytes.byteLength,
    });
  }
  return {
    buildId,
    version,
    directory,
    files,
    withoutSymbols: bundles
      .filter((bundle) => !bundle.attributes?.dSYMUrl)
      .map((bundle) => bundle.attributes?.bundleId ?? bundle.id),
  };
}
