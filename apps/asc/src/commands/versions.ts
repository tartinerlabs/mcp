import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  pageInfo,
  related,
} from "../asc/client.ts";
import {
  appIdSchema,
  commaList,
  limitSchema,
  PLATFORMS,
} from "../schemas/common.ts";

/** `AppVersionState` in the App Store Connect API 4.5 spec. */
const APP_VERSION_STATES = [
  "ACCEPTED",
  "DEVELOPER_REJECTED",
  "IN_REVIEW",
  "INVALID_BINARY",
  "METADATA_REJECTED",
  "PENDING_APPLE_RELEASE",
  "PENDING_DEVELOPER_RELEASE",
  "PREPARE_FOR_SUBMISSION",
  "PROCESSING_FOR_DISTRIBUTION",
  "READY_FOR_DISTRIBUTION",
  "READY_FOR_REVIEW",
  "REJECTED",
  "REPLACED_WITH_NEW_VERSION",
  "WAITING_FOR_EXPORT_COMPLIANCE",
  "WAITING_FOR_REVIEW",
] as const;

interface VersionAttributes {
  platform?: string;
  versionString?: string;
  appVersionState?: string;
  appStoreState?: string;
  releaseType?: string;
  earliestReleaseDate?: string | null;
  createdDate?: string;
}

export const versionsInput = z.object({
  appId: appIdSchema,
  platform: z.enum(PLATFORMS).optional(),
  state: commaList(z.enum(APP_VERSION_STATES)),
  limit: limitSchema,
});

export async function listVersions(
  client: AscClient,
  input: z.output<typeof versionsInput>,
) {
  const response = await client.get<AscDocument<VersionAttributes>>(
    `/v1/apps/${input.appId}/appStoreVersions`,
    {
      "filter[platform]": input.platform,
      "filter[appVersionState]": input.state,
      include: "build",
      "fields[appStoreVersions]": [
        "platform",
        "versionString",
        "appVersionState",
        "appStoreState",
        "releaseType",
        "earliestReleaseDate",
        "createdDate",
        "build",
      ],
      "fields[builds]": "version",
      limit: input.limit,
    },
  );
  const versions = response.data
    .map((version) => ({
      id: version.id,
      platform: version.attributes?.platform,
      versionString: version.attributes?.versionString,
      appVersionState: version.attributes?.appVersionState,
      appStoreState: version.attributes?.appStoreState,
      releaseType: version.attributes?.releaseType,
      earliestReleaseDate: version.attributes?.earliestReleaseDate,
      createdDate: version.attributes?.createdDate,
      build: related<{ version?: string }>(response, version, "build")?.version,
    }))
    // The endpoint has no sort parameter.
    .sort((a, b) => (b.createdDate ?? "").localeCompare(a.createdDate ?? ""));
  return { versions, ...pageInfo(response) };
}
