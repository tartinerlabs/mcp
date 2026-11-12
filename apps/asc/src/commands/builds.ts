import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  pageInfo,
  related,
} from "../asc/client.ts";
import { appIdSchema, commaList, limitSchema } from "../schemas/common.ts";

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

export const buildsInput = z.object({
  appId: appIdSchema,
  processingState: commaList(
    z.enum(["PROCESSING", "FAILED", "INVALID", "VALID"]),
  ),
  expired: z.boolean().optional(),
  buildNumber: z.string().trim().min(1).max(100).optional(),
  limit: limitSchema,
});

export async function listBuilds(
  client: AscClient,
  input: z.output<typeof buildsInput>,
) {
  const response = await client.get<AscDocument<BuildAttributes>>(
    "/v1/builds",
    {
      "filter[app]": input.appId,
      "filter[processingState]": input.processingState,
      "filter[expired]": input.expired,
      "filter[version]": input.buildNumber,
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
      limit: input.limit,
    },
  );
  return {
    builds: response.data.map((build) => {
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
    }),
    ...pageInfo(response),
  };
}
