import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  pageInfo,
  related,
} from "../asc/client.ts";
import {
  appIdSchema,
  cursorSchema,
  idSchema,
  limitSchema,
} from "../schemas/common.ts";

export const groupIdSchema = idSchema("testflight groups");
const buildIdSchema = idSchema("builds");

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
  build: buildIdSchema.optional(),
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

const YES = z.boolean().default(false);

interface GroupDocument {
  data: AscResource<BetaGroupAttributes>;
}

/** The group a write changes, as the dry run shows it, and the app it belongs to. */
async function readGroup(client: AscClient, groupId: string) {
  const { data } = await client.get<GroupDocument>(
    `/v1/betaGroups/${groupId}`,
    {
      "fields[betaGroups]": [
        "name",
        "isInternalGroup",
        "hasAccessToAllBuilds",
        "app",
      ],
      include: "app",
      "fields[apps]": ["name"],
    },
  );
  return {
    group: {
      id: data.id,
      name: data.attributes?.name,
      internal: data.attributes?.isInternalGroup,
      hasAccessToAllBuilds: data.attributes?.hasAccessToAllBuilds,
    },
    appId: data.relationships?.app?.data?.id,
  };
}

interface BuildDocument {
  data: AscResource<{ version?: string }>;
}

async function readBuild(client: AscClient, buildId: string) {
  const { data } = await client.get<BuildDocument>(`/v1/builds/${buildId}`, {
    "fields[builds]": ["version"],
  });
  return { id: data.id, version: data.attributes?.version };
}

/** The first tester matching the filters, if any. */
async function findTester(client: AscClient, filters: Record<string, string>) {
  const response = await client.get<AscDocument<BetaTesterAttributes>>(
    "/v1/betaTesters",
    { ...filters, "fields[betaTesters]": ["state"], limit: 1 },
  );
  return response.data[0]?.id;
}

const emailsSchema = z
  .array(z.email({ error: "Each --email must be an email address." }))
  .min(1, "Give at least one tester with --email.")
  .max(50, "Give at most 50 emails at a time.");

export const addTestersInput = z.object({
  group: groupIdSchema,
  emails: emailsSchema,
  yes: YES,
});

/**
 * Adds testers to a group by email. Apple keeps a tester record per app, so
 * someone already testing the app is added to the group and anyone else is
 * invited. Without `yes`, only shows what would happen to each email.
 */
export async function addTesters(
  client: AscClient,
  input: z.output<typeof addTestersInput>,
) {
  const { group, appId } = await readGroup(client, input.group);
  const testers: {
    email: string;
    testerId?: string;
    change: "none" | "add" | "invite";
  }[] = [];
  for (const email of input.emails) {
    const inGroup = await findTester(client, {
      "filter[email]": email,
      "filter[betaGroups]": input.group,
    });
    if (inGroup) {
      testers.push({ email, testerId: inGroup, change: "none" });
      continue;
    }
    const existing = appId
      ? await findTester(client, {
          "filter[email]": email,
          "filter[apps]": appId,
        })
      : undefined;
    testers.push(
      existing
        ? { email, testerId: existing, change: "add" }
        : { email, change: "invite" },
    );
  }
  if (!input.yes) {
    return { dryRun: true, action: "add-testers", group, testers };
  }
  const toAdd = testers.filter((tester) => tester.change === "add");
  if (toAdd.length > 0) {
    await client.post(
      `/v1/betaGroups/${input.group}/relationships/betaTesters`,
      {
        data: toAdd.map((tester) => ({
          type: "betaTesters",
          id: tester.testerId,
        })),
      },
    );
  }
  for (const tester of testers) {
    if (tester.change !== "invite") continue;
    const created = await client.post<{ data: AscResource }>(
      "/v1/betaTesters",
      {
        data: {
          type: "betaTesters",
          attributes: { email: tester.email },
          relationships: {
            betaGroups: { data: [{ type: "betaGroups", id: input.group }] },
          },
        },
      },
    );
    tester.testerId = created.data.id;
  }
  return {
    dryRun: false,
    action: "add-testers",
    groupId: input.group,
    testers,
  };
}

export const removeTestersInput = addTestersInput;

/**
 * Removes testers from a group by email; they lose access to the group's
 * builds. Without `yes`, only shows which emails are in the group.
 */
export async function removeTesters(
  client: AscClient,
  input: z.output<typeof removeTestersInput>,
) {
  const { group } = await readGroup(client, input.group);
  const testers: {
    email: string;
    testerId?: string;
    change: "none" | "remove";
  }[] = [];
  for (const email of input.emails) {
    const testerId = await findTester(client, {
      "filter[email]": email,
      "filter[betaGroups]": input.group,
    });
    testers.push(
      testerId
        ? { email, testerId, change: "remove" }
        : { email, change: "none" },
    );
  }
  if (!input.yes) {
    return { dryRun: true, action: "remove-testers", group, testers };
  }
  const toRemove = testers.filter((tester) => tester.change === "remove");
  if (toRemove.length > 0) {
    await client.delete(
      `/v1/betaGroups/${input.group}/relationships/betaTesters`,
      {
        data: toRemove.map((tester) => ({
          type: "betaTesters",
          id: tester.testerId,
        })),
      },
    );
  }
  return {
    dryRun: false,
    action: "remove-testers",
    groupId: input.group,
    testers,
  };
}

export const addBuildInput = z.object({
  group: groupIdSchema,
  buildId: buildIdSchema,
  yes: YES,
});

/**
 * Lets a group test a build. External groups can only get a build that passed
 * beta review. Without `yes`, only shows the group, the build and whether the
 * group already has it.
 */
export async function addBuildToGroup(
  client: AscClient,
  input: z.output<typeof addBuildInput>,
) {
  const { group } = await readGroup(client, input.group);
  const build = await readBuild(client, input.buildId);
  const inGroup = await client.get<AscDocument<unknown>>("/v1/builds", {
    "filter[betaGroups]": input.group,
    "filter[id]": input.buildId,
    "fields[builds]": ["version"],
    limit: 1,
  });
  const changes = inGroup.data.length === 0;
  if (!input.yes) {
    return { dryRun: true, action: "add-build", group, build, changes };
  }
  if (changes) {
    await client.post(`/v1/betaGroups/${input.group}/relationships/builds`, {
      data: [{ type: "builds", id: input.buildId }],
    });
  }
  return {
    dryRun: false,
    action: "add-build",
    groupId: input.group,
    buildId: input.buildId,
    changed: changes,
  };
}

export const notesInput = z.object({
  buildId: buildIdSchema,
  locale: z
    .string({ error: "Give the notes' language with --locale, such as en-US." })
    .trim()
    .regex(
      /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
      "Must be a locale such as en-US or zh-Hans.",
    ),
  whatsNew: z
    .string()
    .trim()
    .min(1, "The notes are empty.")
    .max(4000, "The notes are longer than 4000 characters."),
  yes: YES,
});

/**
 * Sets a build's "What to Test" notes for one locale, creating that locale's
 * notes if the build has none. Without `yes`, shows the current notes and the
 * new ones.
 */
export async function setBuildNotes(
  client: AscClient,
  input: z.output<typeof notesInput>,
) {
  const build = await readBuild(client, input.buildId);
  const existing = (
    await client.get<AscDocument<{ whatsNew?: string | null }>>(
      "/v1/betaBuildLocalizations",
      {
        "filter[build]": input.buildId,
        "filter[locale]": input.locale,
        "fields[betaBuildLocalizations]": ["whatsNew", "locale"],
        limit: 1,
      },
    )
  ).data[0];
  const current = existing?.attributes?.whatsNew ?? null;
  const changes = current !== input.whatsNew;
  if (!input.yes) {
    return {
      dryRun: true,
      action: "notes",
      build,
      locale: input.locale,
      current,
      whatsNew: input.whatsNew,
      creates: existing === undefined,
      changes,
    };
  }
  if (existing && changes) {
    await client.patch(`/v1/betaBuildLocalizations/${existing.id}`, {
      data: {
        type: "betaBuildLocalizations",
        id: existing.id,
        attributes: { whatsNew: input.whatsNew },
      },
    });
  } else if (!existing) {
    await client.post("/v1/betaBuildLocalizations", {
      data: {
        type: "betaBuildLocalizations",
        attributes: { locale: input.locale, whatsNew: input.whatsNew },
        relationships: {
          build: { data: { type: "builds", id: input.buildId } },
        },
      },
    });
  }
  return {
    dryRun: false,
    action: "notes",
    buildId: input.buildId,
    locale: input.locale,
    changed: changes,
  };
}
