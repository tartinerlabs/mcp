import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  related,
} from "../asc/client.ts";
import { appIdSchema, PLATFORMS } from "../schemas/common.ts";
import { type BuildsDocument, buildsQuery, shapeBuild } from "./builds.ts";

interface VersionAttributes {
  platform?: string;
  versionString?: string;
  appVersionState?: string;
  releaseType?: string;
  earliestReleaseDate?: string | null;
  createdDate?: string;
}

type VersionsDocument = AscDocument<VersionAttributes>;

/** The live version on the App Store. */
const LIVE = "READY_FOR_DISTRIBUTION";
/** Superseded versions: history, not in progress. */
const DONE = new Set([LIVE, "REPLACED_WITH_NEW_VERSION"]);

export const statusInput = z.object({
  appId: appIdSchema,
  platform: z.enum(PLATFORMS).optional(),
});

function shapeVersion(
  response: VersionsDocument,
  version: AscResource<VersionAttributes>,
) {
  return {
    id: version.id,
    version: version.attributes?.versionString,
    state: version.attributes?.appVersionState,
    releaseType: version.attributes?.releaseType,
    earliestReleaseDate: version.attributes?.earliestReleaseDate,
    createdDate: version.attributes?.createdDate,
    build: related<{ version?: string }>(response, version, "build")?.version,
    // Passed through as Apple returns it: state, start date, day number, pauses.
    phasedRelease:
      related<Record<string, unknown>>(
        response,
        version,
        "appStoreVersionPhasedRelease",
      ) ?? null,
  };
}

/**
 * Where an app stands on each platform: the live version, a newer version
 * being prepared or reviewed, and the newest build. One versions request plus
 * one builds request per platform.
 */
export async function getStatus(
  client: AscClient,
  input: z.output<typeof statusInput>,
) {
  const versions = await client.get<VersionsDocument>(
    `/v1/apps/${input.appId}/appStoreVersions`,
    {
      "filter[platform]": input.platform,
      include: "build,appStoreVersionPhasedRelease",
      "fields[appStoreVersions]": [
        "platform",
        "versionString",
        "appVersionState",
        "releaseType",
        "earliestReleaseDate",
        "createdDate",
        "build",
        "appStoreVersionPhasedRelease",
      ],
      "fields[builds]": "version",
      limit: 200,
    },
  );
  // Dates carry mixed UTC offsets (-07:00, -08:00), so compare instants, not strings.
  const created = (v: AscResource<VersionAttributes>) =>
    Date.parse(v.attributes?.createdDate ?? "") || 0;
  // The endpoint has no sort parameter.
  const newestFirst = [...versions.data].sort(
    (a, b) => created(b) - created(a),
  );
  const platforms = input.platform
    ? [input.platform]
    : [
        ...new Set(newestFirst.flatMap((v) => v.attributes?.platform ?? [])),
      ].sort();

  const entries = await Promise.all(
    platforms.map(async (platform) => {
      const own = newestFirst.filter(
        (v) => v.attributes?.platform === platform,
      );
      const live = own.find((v) => v.attributes?.appVersionState === LIVE);
      const inProgress = own.find(
        (v) =>
          !DONE.has(v.attributes?.appVersionState ?? "") &&
          (!live || created(v) > created(live)),
      );
      const builds = await client.get<BuildsDocument>("/v1/builds", {
        ...buildsQuery(input.appId),
        "filter[preReleaseVersion.platform]": platform,
        limit: 1,
      });
      const newest = builds.data[0];
      return [
        platform,
        {
          live: live ? shapeVersion(versions, live) : null,
          inProgress: inProgress ? shapeVersion(versions, inProgress) : null,
          latestBuild: newest ? shapeBuild(builds, newest) : null,
        },
      ] as const;
    }),
  );
  return { appId: input.appId, platforms: Object.fromEntries(entries) };
}
