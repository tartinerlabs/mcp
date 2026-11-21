import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  pageInfo,
  related,
} from "../asc/client.ts";
import { appIdSchema, cursorSchema, limitSchema } from "../schemas/common.ts";

/** Group and build IDs are opaque; letters, digits and hyphens keep them to one value. */
function idSchema(source: string) {
  return z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9-]{1,100}$/,
      `Must be an id from the ${source} command.`,
    );
}

export const groupIdSchema = idSchema("testflight groups");

interface BetaGroupAttributes {
  name?: string;
  createdDate?: string;
  isInternalGroup?: boolean;
  hasAccessToAllBuilds?: boolean | null;
  feedbackEnabled?: boolean;
  publicLinkEnabled?: boolean | null;
  publicLink?: string | null;
  publicLinkLimitEnabled?: boolean | null;
  publicLinkLimit?: number | null;
}

export const betaGroupsInput = z.object({
  appId: appIdSchema,
  internal: z.boolean().optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** An app's TestFlight groups, by name. */
export async function listBetaGroups(
  client: AscClient,
  input: z.output<typeof betaGroupsInput>,
) {
  const response = await client.get<AscDocument<BetaGroupAttributes>>(
    "/v1/betaGroups",
    {
      "filter[app]": input.appId,
      "filter[isInternalGroup]": input.internal,
      sort: "name",
      "fields[betaGroups]": [
        "name",
        "createdDate",
        "isInternalGroup",
        "hasAccessToAllBuilds",
        "feedbackEnabled",
        "publicLinkEnabled",
        "publicLink",
        "publicLinkLimitEnabled",
        "publicLinkLimit",
      ],
      limit: input.limit,
      cursor: input.cursor,
    },
  );
  return {
    groups: response.data.map(({ id, attributes: group }) => ({
      id,
      name: group?.name,
      internal: group?.isInternalGroup,
      hasAccessToAllBuilds: group?.hasAccessToAllBuilds,
      feedbackEnabled: group?.feedbackEnabled,
      publicLinkEnabled: group?.publicLinkEnabled,
      publicLink: group?.publicLink,
      publicLinkLimit: group?.publicLinkLimitEnabled
        ? group.publicLinkLimit
        : null,
      createdDate: group?.createdDate,
    })),
    ...pageInfo(response),
  };
}

interface BetaTesterAttributes {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  inviteType?: string;
  state?: string;
}

export const betaTestersInput = z.object({
  appId: appIdSchema,
  group: groupIdSchema.optional(),
  inviteType: z.enum(["EMAIL", "PUBLIC_LINK"]).optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** An app's TestFlight testers, or one group's, with how they were invited and how far they got. */
export async function listBetaTesters(
  client: AscClient,
  input: z.output<typeof betaTestersInput>,
) {
  const response = await client.get<AscDocument<BetaTesterAttributes>>(
    "/v1/betaTesters",
    {
      // Apple allows one relationship filter here; a group belongs to one app.
      ...(input.group
        ? { "filter[betaGroups]": input.group }
        : { "filter[apps]": input.appId }),
      "filter[inviteType]": input.inviteType,
      sort: "lastName",
      "fields[betaTesters]": [
        "firstName",
        "lastName",
        "email",
        "inviteType",
        "state",
      ],
      limit: input.limit,
      cursor: input.cursor,
    },
  );
  return {
    testers: response.data.map(({ id, attributes: tester }) => ({
      id,
      firstName: tester?.firstName,
      lastName: tester?.lastName,
      email: tester?.email,
      inviteType: tester?.inviteType,
      state: tester?.state,
    })),
    ...pageInfo(response),
  };
}

/** Feedback attributes we print. The tester's email and time zone are left out. */
interface FeedbackAttributes {
  createdDate?: string;
  comment?: string | null;
  deviceModel?: string;
  deviceFamily?: string;
  devicePlatform?: string;
  osVersion?: string;
  appPlatform?: string;
  locale?: string;
  architecture?: string;
  connectionType?: string;
  batteryPercentage?: number | null;
  appUptimeInMilliseconds?: number | null;
  /** Screenshot feedback only. */
  screenshots?: unknown;
}

export const FEEDBACK_TYPES = ["crash", "screenshot"] as const;

const FEEDBACK_PATHS = {
  crash: "betaFeedbackCrashSubmissions",
  screenshot: "betaFeedbackScreenshotSubmissions",
} as const;

export const betaFeedbackInput = z.object({
  appId: appIdSchema,
  type: z.enum(FEEDBACK_TYPES, { error: "Give --type crash or screenshot." }),
  build: idSchema("builds").optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** Crash or screenshot feedback from TestFlight testers, newest first, with the build it was sent from. */
export async function listBetaFeedback(
  client: AscClient,
  input: z.output<typeof betaFeedbackInput>,
) {
  const response = await client.get<AscDocument<FeedbackAttributes>>(
    `/v1/apps/${input.appId}/${FEEDBACK_PATHS[input.type]}`,
    {
      "filter[build]": input.build,
      sort: "-createdDate",
      include: "build",
      "fields[builds]": ["version"],
      limit: input.limit,
      cursor: input.cursor,
    },
  );
  return {
    feedback: response.data.map((item) => {
      const feedback = item.attributes;
      return {
        id: item.id,
        type: input.type,
        createdDate: feedback?.createdDate,
        comment: feedback?.comment,
        build: {
          id: item.relationships?.build?.data?.id,
          version: related<{ version?: string }>(response, item, "build")
            ?.version,
        },
        deviceModel: feedback?.deviceModel,
        deviceFamily: feedback?.deviceFamily,
        devicePlatform: feedback?.devicePlatform,
        osVersion: feedback?.osVersion,
        appPlatform: feedback?.appPlatform,
        locale: feedback?.locale,
        architecture: feedback?.architecture,
        connectionType: feedback?.connectionType,
        batteryPercentage: feedback?.batteryPercentage,
        appUptimeInMilliseconds: feedback?.appUptimeInMilliseconds,
        ...(input.type === "screenshot"
          ? { screenshots: feedback?.screenshots }
          : {}),
      };
    }),
    ...pageInfo(response),
  };
}
