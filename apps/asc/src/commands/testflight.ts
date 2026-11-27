import { readFile, writeFile } from "node:fs/promises";
import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  pageInfo,
  related,
} from "../asc/client.ts";
import { splitCsv } from "../asc/reports.ts";
import {
  appIdSchema,
  cursorSchema,
  idSchema,
  limitSchema,
  localeSchema,
} from "../schemas/common.ts";
import { classifyError, InvalidInputError } from "../utils/errors.ts";

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

interface ReviewBuildAttributes {
  version?: string;
  processingState?: string;
  expired?: boolean;
}

interface ReviewBuildDocument {
  data: AscResource<ReviewBuildAttributes>;
  included?: AscResource[];
}

interface BetaAppReviewSubmissionAttributes {
  betaReviewState?: string;
  submittedDate?: string | null;
}

interface BuildBetaDetailAttributes {
  externalBuildState?: string;
  internalBuildState?: string;
}

/** A build, its app and its beta app review submission, if it has one. */
async function readReview(client: AscClient, buildId: string) {
  const document = await client.get<ReviewBuildDocument>(
    `/v1/builds/${buildId}`,
    {
      "fields[builds]": [
        "version",
        "processingState",
        "expired",
        "app",
        "betaAppReviewSubmission",
        "buildBetaDetail",
      ],
      include: ["app", "betaAppReviewSubmission", "buildBetaDetail"],
      "fields[apps]": ["name"],
      "fields[betaAppReviewSubmissions]": ["betaReviewState", "submittedDate"],
      "fields[buildBetaDetails]": ["externalBuildState", "internalBuildState"],
    },
  );
  const { data } = document;
  const submissionId = data.relationships?.betaAppReviewSubmission?.data?.id;
  const submission = related<BetaAppReviewSubmissionAttributes>(
    document,
    data,
    "betaAppReviewSubmission",
  );
  const detail = related<BuildBetaDetailAttributes>(
    document,
    data,
    "buildBetaDetail",
  );
  return {
    build: {
      id: data.id,
      version: data.attributes?.version,
      processingState: data.attributes?.processingState,
      expired: data.attributes?.expired,
      appId: data.relationships?.app?.data?.id,
      appName: related<{ name?: string }>(document, data, "app")?.name,
    },
    submission: submissionId
      ? {
          id: submissionId,
          betaReviewState: submission?.betaReviewState,
          submittedDate: submission?.submittedDate,
        }
      : null,
    externalBuildState: detail?.externalBuildState,
    internalBuildState: detail?.internalBuildState,
  };
}

export const betaReviewInput = z.object({ buildId: buildIdSchema });

/**
 * A build's beta app review: the submission's state (WAITING_FOR_REVIEW,
 * IN_REVIEW, REJECTED or APPROVED), null if it was never submitted, and the
 * build's external and internal TestFlight states.
 */
export async function getBetaReview(
  client: AscClient,
  input: z.output<typeof betaReviewInput>,
) {
  return readReview(client, input.buildId);
}

interface BetaAppReviewDetailAttributes {
  contactFirstName?: string | null;
  contactLastName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  demoAccountRequired?: boolean | null;
  demoAccountName?: string | null;
  demoAccountPassword?: string | null;
  notes?: string | null;
}

const REVIEW_CONTACT_FIELDS = {
  contactFirstName: "contact first name",
  contactLastName: "contact last name",
  contactPhone: "contact phone",
  contactEmail: "contact email",
} as const;

/** An app's beta app review details; the password is read only to tell whether it is set. */
async function readReviewDetail(client: AscClient, appId: string) {
  const { data } = await client.get<{
    data: AscResource<BetaAppReviewDetailAttributes>;
  }>(`/v1/apps/${appId}/betaAppReviewDetail`, {
    "fields[betaAppReviewDetails]": [
      ...Object.keys(REVIEW_CONTACT_FIELDS),
      "demoAccountRequired",
      "demoAccountName",
      "demoAccountPassword",
      "notes",
    ],
  });
  return data;
}

/**
 * The beta app review details Apple needs before a submission that are
 * blank. Only which ones are missing is returned: the contact details and
 * the demo account are never printed.
 */
async function missingReviewDetails(client: AscClient, appId: string) {
  const details = (await readReviewDetail(client, appId)).attributes ?? {};
  const blank = (value: string | null | undefined) => !value?.trim();
  const missing: string[] = Object.entries(REVIEW_CONTACT_FIELDS)
    .filter(([field]) =>
      blank(details[field as keyof typeof REVIEW_CONTACT_FIELDS]),
    )
    .map(([, label]) => label);
  if (details.demoAccountRequired) {
    if (blank(details.demoAccountName)) missing.push("demo account name");
    if (blank(details.demoAccountPassword)) {
      missing.push("demo account password");
    }
  }
  return { missing, demoAccountRequired: details.demoAccountRequired ?? false };
}

export const submitBetaReviewInput = z.object({
  buildId: buildIdSchema,
  yes: YES,
});

/**
 * Submits a build for beta app review, which a build needs before external
 * groups can test it. Refuses a build that is expired, not processed, or
 * whose app has blank review details, naming what is missing. Without `yes`,
 * only shows the build, its current submission and whether it would submit.
 */
export async function submitBetaReview(
  client: AscClient,
  input: z.output<typeof submitBetaReviewInput>,
) {
  const { build, submission } = await readReview(client, input.buildId);
  const changes = submission === null;
  if (changes) {
    if (build.expired) {
      throw new InvalidInputError(
        `Build ${build.version} has expired; submit a newer build.`,
      );
    }
    if (build.processingState !== "VALID") {
      throw new InvalidInputError(
        `Build ${build.version} is ${build.processingState ?? "not processed"}; only a build that finished processing as VALID can be submitted. Wait for it with builds wait.`,
      );
    }
  }
  const details =
    changes && build.appId
      ? await missingReviewDetails(client, build.appId)
      : undefined;
  if (details && details.missing.length > 0) {
    throw new InvalidInputError(
      `The app's beta app review details are missing: ${details.missing.join(", ")}. Fill them in under TestFlight > Test Information in App Store Connect, then run this again.`,
    );
  }
  if (!input.yes) {
    return {
      dryRun: true,
      action: "submit-beta-review",
      build,
      submission,
      changes,
    };
  }
  let created = submission;
  if (changes) {
    const response = await client.post<{
      data: AscResource<BetaAppReviewSubmissionAttributes>;
    }>("/v1/betaAppReviewSubmissions", {
      data: {
        type: "betaAppReviewSubmissions",
        relationships: {
          build: { data: { type: "builds", id: input.buildId } },
        },
      },
    });
    created = {
      id: response.data.id,
      betaReviewState: response.data.attributes?.betaReviewState,
      submittedDate: response.data.attributes?.submittedDate,
    };
  }
  return {
    dryRun: false,
    action: "submit-beta-review",
    buildId: input.buildId,
    submission: created,
    changed: changes,
  };
}

interface BetaAppLocalizationAttributes {
  locale?: string;
  description?: string | null;
  feedbackEmail?: string | null;
  marketingUrl?: string | null;
  privacyPolicyUrl?: string | null;
}

const LOCALIZATION_FIELDS = [
  "description",
  "feedbackEmail",
  "marketingUrl",
  "privacyPolicyUrl",
] as const;

async function readBetaLocalizations(client: AscClient, appId: string) {
  const response = await client.get<AscDocument<BetaAppLocalizationAttributes>>(
    `/v1/apps/${appId}/betaAppLocalizations`,
    {
      "fields[betaAppLocalizations]": ["locale", ...LOCALIZATION_FIELDS],
      limit: 200,
    },
  );
  return response.data;
}

/** Review details as printed: whether a demo password is set, never the password. */
function shapeReviewDetail(detail: AscResource<BetaAppReviewDetailAttributes>) {
  const attributes = detail.attributes ?? {};
  return {
    id: detail.id,
    contactFirstName: attributes.contactFirstName ?? null,
    contactLastName: attributes.contactLastName ?? null,
    contactPhone: attributes.contactPhone ?? null,
    contactEmail: attributes.contactEmail ?? null,
    demoAccountRequired: attributes.demoAccountRequired ?? false,
    demoAccountName: attributes.demoAccountName ?? null,
    demoAccountPasswordSet: Boolean(attributes.demoAccountPassword?.trim()),
    notes: attributes.notes ?? null,
  };
}

export const betaInfoInput = z.object({ appId: appIdSchema });

/**
 * An app's TestFlight test information: the beta app description, feedback
 * email and URLs per locale, and the beta app review details. The demo
 * account password is never printed, only whether it is set.
 */
export async function getBetaInfo(
  client: AscClient,
  input: z.output<typeof betaInfoInput>,
) {
  const localizations = await readBetaLocalizations(client, input.appId);
  const detail = await readReviewDetail(client, input.appId);
  return {
    appId: input.appId,
    localizations: localizations.map(({ id, attributes }) => ({
      id,
      locale: attributes?.locale,
      description: attributes?.description ?? null,
      feedbackEmail: attributes?.feedbackEmail ?? null,
      marketingUrl: attributes?.marketingUrl ?? null,
      privacyPolicyUrl: attributes?.privacyPolicyUrl ?? null,
    })),
    reviewDetails: shapeReviewDetail(detail),
  };
}

const urlSchema = z.url({
  protocol: /^https?$/,
  error: "Must be an http or https URL.",
});

export const setBetaInfoInput = z
  .object({
    appId: appIdSchema,
    locale: localeSchema,
    description: z
      .string()
      .trim()
      .max(4000, "The description is longer than 4000 characters.")
      .optional(),
    feedbackEmail: z
      .email({ error: "--feedback-email must be an email address." })
      .optional(),
    marketingUrl: urlSchema.optional(),
    privacyPolicyUrl: urlSchema.optional(),
    yes: YES,
  })
  .refine(
    (input) => LOCALIZATION_FIELDS.some((field) => input[field] !== undefined),
    "Give at least one of --description, --feedback-email, --marketing-url or --privacy-url.",
  );

/**
 * Sets an app's beta app information for one locale, creating the locale if
 * the app has none for it. Without `yes`, shows the current and new values.
 */
export async function setBetaInfo(
  client: AscClient,
  input: z.output<typeof setBetaInfoInput>,
) {
  const existing = (await readBetaLocalizations(client, input.appId)).find(
    (localization) => localization.attributes?.locale === input.locale,
  );
  const current = Object.fromEntries(
    LOCALIZATION_FIELDS.map((field) => [
      field,
      existing?.attributes?.[field] ?? null,
    ]),
  );
  const changes = Object.fromEntries(
    LOCALIZATION_FIELDS.filter(
      (field) => input[field] !== undefined && input[field] !== current[field],
    ).map((field) => [field, input[field]]),
  );
  const changed = existing === undefined || Object.keys(changes).length > 0;
  if (!input.yes) {
    return {
      dryRun: true,
      action: "beta-info",
      appId: input.appId,
      locale: input.locale,
      creates: existing === undefined,
      current,
      changes,
    };
  }
  if (existing && changed) {
    await client.patch(`/v1/betaAppLocalizations/${existing.id}`, {
      data: {
        type: "betaAppLocalizations",
        id: existing.id,
        attributes: changes,
      },
    });
  } else if (!existing) {
    await client.post("/v1/betaAppLocalizations", {
      data: {
        type: "betaAppLocalizations",
        attributes: { locale: input.locale, ...changes },
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    });
  }
  return {
    dryRun: false,
    action: "beta-info",
    appId: input.appId,
    locale: input.locale,
    created: existing === undefined,
    changed,
  };
}

const REVIEW_DETAIL_TEXT_FIELDS = [
  "contactFirstName",
  "contactLastName",
  "contactPhone",
  "contactEmail",
  "demoAccountName",
  "notes",
] as const;

const detailText = z.string().trim().min(1).max(4000);

export const setReviewDetailsInput = z
  .object({
    appId: appIdSchema,
    contactFirstName: detailText.optional(),
    contactLastName: detailText.optional(),
    contactPhone: detailText.optional(),
    contactEmail: z
      .email({ error: "--contact-email must be an email address." })
      .optional(),
    demoAccountRequired: z.boolean().optional(),
    demoAccountName: detailText.optional(),
    /** A secret: sent to Apple, never printed or put in an error. */
    demoAccountPassword: z
      .string({ error: "The demo account password must be text." })
      .min(1, "The demo account password is empty.")
      .max(4000, "The demo account password is too long.")
      .optional(),
    notes: detailText.optional(),
    yes: YES,
  })
  .refine(
    (input) =>
      REVIEW_DETAIL_TEXT_FIELDS.some((field) => input[field] !== undefined) ||
      input.demoAccountRequired !== undefined ||
      input.demoAccountPassword !== undefined,
    "Give at least one review detail to set.",
  );

/**
 * Sets an app's beta app review details: the contact Apple's reviewers reach,
 * the demo account and notes. The demo account password is sent but never
 * printed. Without `yes`, shows the current details and what would change.
 */
export async function setReviewDetails(
  client: AscClient,
  input: z.output<typeof setReviewDetailsInput>,
) {
  const detail = await readReviewDetail(client, input.appId);
  const current = shapeReviewDetail(detail);
  const changes: Record<string, string | boolean> = {};
  for (const field of REVIEW_DETAIL_TEXT_FIELDS) {
    const value = input[field];
    if (value !== undefined && value !== current[field]) changes[field] = value;
  }
  if (
    input.demoAccountRequired !== undefined &&
    input.demoAccountRequired !== current.demoAccountRequired
  ) {
    changes.demoAccountRequired = input.demoAccountRequired;
  }
  const required = input.demoAccountRequired ?? current.demoAccountRequired;
  if (required) {
    const missing = [
      ...((input.demoAccountName ?? current.demoAccountName)
        ? []
        : ["--demo-account-name"]),
      ...(input.demoAccountPassword !== undefined ||
      current.demoAccountPasswordSet
        ? []
        : ["--demo-account-password or ASC_DEMO_ACCOUNT_PASSWORD"]),
    ];
    if (missing.length > 0) {
      throw new InvalidInputError(
        `A required demo account needs ${missing.join(" and ")}. Nothing was changed.`,
      );
    }
  }
  const setsPassword = input.demoAccountPassword !== undefined;
  const changed = Object.keys(changes).length > 0 || setsPassword;
  if (!input.yes) {
    return {
      dryRun: true,
      action: "review-details",
      appId: input.appId,
      current,
      changes,
      setsDemoAccountPassword: setsPassword,
    };
  }
  if (changed) {
    await client.patch(`/v1/betaAppReviewDetails/${detail.id}`, {
      data: {
        type: "betaAppReviewDetails",
        id: detail.id,
        attributes: {
          ...changes,
          ...(setsPassword
            ? { demoAccountPassword: input.demoAccountPassword }
            : {}),
        },
      },
    });
  }
  return {
    dryRun: false,
    action: "review-details",
    appId: input.appId,
    changed: Object.keys(changes),
    setDemoAccountPassword: setsPassword,
  };
}

/** Apple caps a public link at 10,000 testers. */
const publicLinkLimitSchema = z.coerce
  .number()
  .int()
  .min(1, "--public-link-limit must be at least 1.")
  .max(10000, "--public-link-limit must be at most 10000.");

const groupNameSchema = z
  .string({ error: "Give the group's name with --name." })
  .trim()
  .min(1, "Give the group's name with --name.")
  .max(100, "The group name is longer than 100 characters.");

export const createGroupInput = z
  .object({
    appId: appIdSchema,
    name: groupNameSchema,
    internal: z.boolean({ error: "Give --internal or --external." }),
    allBuilds: z.boolean().optional(),
    publicLink: z.boolean().optional(),
    publicLinkLimit: publicLinkLimitSchema.optional(),
    feedback: z.boolean().optional(),
    yes: YES,
  })
  .refine((input) => !input.internal || !input.publicLink, {
    message: "Only external groups have a public link.",
  })
  .refine((input) => input.internal || input.allBuilds === undefined, {
    message: "--all-builds is for internal groups only.",
  })
  .refine((input) => input.publicLinkLimit === undefined || input.publicLink, {
    message: "--public-link-limit needs --public-link.",
  });

/**
 * Creates a TestFlight group. Refuses a name the app already uses. Without
 * `yes`, shows the group that would be created.
 */
export async function createGroup(
  client: AscClient,
  input: z.output<typeof createGroupInput>,
) {
  const existing = await client.get<AscDocument<BetaGroupAttributes>>(
    "/v1/betaGroups",
    {
      "filter[app]": input.appId,
      "filter[name]": input.name,
      "fields[betaGroups]": ["name"],
      limit: 1,
    },
  );
  if (existing.data.length > 0) {
    throw new InvalidInputError(
      `The app already has a group named "${input.name}" (${existing.data[0]?.id}). Nothing was changed.`,
    );
  }
  const attributes = {
    name: input.name,
    isInternalGroup: input.internal,
    ...(input.allBuilds === undefined
      ? {}
      : { hasAccessToAllBuilds: input.allBuilds }),
    ...(input.publicLink === undefined
      ? {}
      : { publicLinkEnabled: input.publicLink }),
    ...(input.publicLinkLimit === undefined
      ? {}
      : {
          publicLinkLimitEnabled: true,
          publicLinkLimit: input.publicLinkLimit,
        }),
    ...(input.feedback === undefined
      ? {}
      : { feedbackEnabled: input.feedback }),
  };
  if (!input.yes) {
    return {
      dryRun: true,
      action: "create-group",
      appId: input.appId,
      group: attributes,
    };
  }
  const created = await client.post<{ data: AscResource<BetaGroupAttributes> }>(
    "/v1/betaGroups",
    {
      data: {
        type: "betaGroups",
        attributes,
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    },
  );
  return {
    dryRun: false,
    action: "create-group",
    appId: input.appId,
    groupId: created.data.id,
    publicLink: created.data.attributes?.publicLink ?? null,
  };
}

export const deleteGroupInput = z.object({ group: groupIdSchema, yes: YES });

/**
 * Deletes a TestFlight group; its testers lose access to the builds they got
 * through it. This cannot be undone. Without `yes`, shows the group.
 */
export async function deleteGroup(
  client: AscClient,
  input: z.output<typeof deleteGroupInput>,
) {
  const { group, appId } = await readGroup(client, input.group);
  if (!input.yes) {
    return {
      dryRun: true,
      action: "delete-group",
      group,
      appId,
      note: "Deleting a group cannot be undone; its testers lose access to the builds they got through it.",
    };
  }
  await client.delete(`/v1/betaGroups/${input.group}`);
  return { dryRun: false, action: "delete-group", groupId: input.group };
}

export const setGroupInput = z
  .object({
    group: groupIdSchema,
    name: groupNameSchema.optional(),
    publicLink: z.boolean().optional(),
    /** A number sets the limit; false removes it. */
    publicLinkLimit: z
      .union([z.literal(false), publicLinkLimitSchema])
      .optional(),
    feedback: z.boolean().optional(),
    yes: YES,
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.publicLink !== undefined ||
      input.publicLinkLimit !== undefined ||
      input.feedback !== undefined,
    "Give at least one of --name, --public-link, --public-link-limit or --feedback.",
  );

/**
 * Renames a group or changes its public link, public link limit or feedback
 * setting. Refuses a public link on an internal group. Without `yes`, shows
 * the current settings and what would change.
 */
export async function setGroup(
  client: AscClient,
  input: z.output<typeof setGroupInput>,
) {
  const { data } = await client.get<GroupDocument>(
    `/v1/betaGroups/${input.group}`,
    {
      "fields[betaGroups]": [
        "name",
        "isInternalGroup",
        "feedbackEnabled",
        "publicLinkEnabled",
        "publicLinkLimitEnabled",
        "publicLinkLimit",
      ],
    },
  );
  const group = data.attributes ?? {};
  const current = {
    name: group.name,
    internal: group.isInternalGroup,
    feedbackEnabled: group.feedbackEnabled ?? null,
    publicLinkEnabled: group.publicLinkEnabled ?? false,
    publicLinkLimit: group.publicLinkLimitEnabled
      ? (group.publicLinkLimit ?? null)
      : null,
  };
  const touchesLink =
    input.publicLink === true || typeof input.publicLinkLimit === "number";
  if (current.internal && touchesLink) {
    throw new InvalidInputError(
      "Only external groups have a public link. Nothing was changed.",
    );
  }
  const changes: Partial<BetaGroupAttributes> = {};
  if (input.name !== undefined && input.name !== current.name) {
    changes.name = input.name;
  }
  if (
    input.publicLink !== undefined &&
    input.publicLink !== current.publicLinkEnabled
  ) {
    changes.publicLinkEnabled = input.publicLink;
  }
  if (input.publicLinkLimit === false && current.publicLinkLimit !== null) {
    changes.publicLinkLimitEnabled = false;
  } else if (
    typeof input.publicLinkLimit === "number" &&
    input.publicLinkLimit !== current.publicLinkLimit
  ) {
    changes.publicLinkLimitEnabled = true;
    changes.publicLinkLimit = input.publicLinkLimit;
  }
  if (
    input.feedback !== undefined &&
    input.feedback !== current.feedbackEnabled
  ) {
    changes.feedbackEnabled = input.feedback;
  }
  const changed = Object.keys(changes).length > 0;
  if (!input.yes) {
    return {
      dryRun: true,
      action: "set-group",
      group: { id: data.id, ...current },
      changes,
    };
  }
  if (changed) {
    await client.patch(`/v1/betaGroups/${input.group}`, {
      data: { type: "betaGroups", id: input.group, attributes: changes },
    });
  }
  return {
    dryRun: false,
    action: "set-group",
    groupId: input.group,
    changed: Object.keys(changes),
  };
}

const MAX_IMPORT_ROWS = 1000;

export const importTestersInput = z.object({
  appId: appIdSchema,
  file: z.string({ error: "Give the CSV file with --file." }).min(1),
  groups: z
    .array(groupIdSchema)
    .min(1, "Give at least one group with --group.")
    .max(20, "Give at most 20 groups."),
  yes: YES,
});

interface ImportRow {
  row: number;
  email: string;
  firstName?: string;
  lastName?: string;
}

/** The header names a column may have, compared without case, spaces, dashes or underscores. */
const CSV_COLUMNS = {
  email: ["email", "emailaddress"],
  firstName: ["firstname", "givenname"],
  lastName: ["lastname", "familyname", "surname"],
};

/**
 * Reads testers from a CSV file whose header names an email column and,
 * optionally, first and last name columns. Row numbers count the header as
 * row 1, as a spreadsheet does. Errors name rows, never their emails.
 */
async function readTesterCsv(path: string): Promise<ImportRow[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new InvalidInputError(`Could not read the --file ${path}.`);
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const normalise = (name: string) => name.toLowerCase().replace(/[\s_-]/g, "");
  const header = splitCsv(lines[0] ?? "").map(normalise);
  const index = (names: string[]) =>
    header.findIndex((name) => names.includes(name));
  const columns = {
    email: index(CSV_COLUMNS.email),
    firstName: index(CSV_COLUMNS.firstName),
    lastName: index(CSV_COLUMNS.lastName),
  };
  if (columns.email < 0) {
    throw new InvalidInputError(
      "The CSV file's first line must be a header with an email column (and optionally firstName and lastName).",
    );
  }
  const rows: ImportRow[] = [];
  const invalid: number[] = [];
  const seen = new Set<string>();
  lines.slice(1).forEach((line, offset) => {
    if (line.trim() === "") return;
    const fields = splitCsv(line).map((field) => field.trim());
    const row = offset + 2;
    const email = fields[columns.email] ?? "";
    if (!z.email().safeParse(email).success) {
      invalid.push(row);
      return;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const firstName = fields[columns.firstName] || undefined;
    const lastName = fields[columns.lastName] || undefined;
    rows.push({
      row,
      email,
      ...(columns.firstName >= 0 && firstName ? { firstName } : {}),
      ...(columns.lastName >= 0 && lastName ? { lastName } : {}),
    });
  });
  if (invalid.length > 0) {
    throw new InvalidInputError(
      `These rows have no valid email address: ${invalid.slice(0, 20).join(", ")}${invalid.length > 20 ? " and more" : ""}. Nothing was changed.`,
    );
  }
  if (rows.length === 0) {
    throw new InvalidInputError("The CSV file has no testers.");
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new InvalidInputError(
      `The CSV file has ${rows.length} testers; import at most ${MAX_IMPORT_ROWS} at a time.`,
    );
  }
  return rows;
}

/** The ids of the groups a tester is in. */
async function testerGroupIds(client: AscClient, testerId: string) {
  const response = await client.get<{ data: { id: string }[] }>(
    `/v1/betaTesters/${testerId}/relationships/betaGroups`,
    { limit: 200 },
  );
  return new Set(response.data.map((group) => group.id));
}

/**
 * Adds every tester in a CSV file to one or more of an app's groups. Someone
 * already testing the app joins the groups they are not in; anyone else is
 * invited into all of them. Each row's result names the row, not the email.
 * Without `yes`, only shows what would happen to each row.
 */
export async function importTesters(
  client: AscClient,
  input: z.output<typeof importTestersInput>,
) {
  const groupIds = [...new Set(input.groups)];
  const groups = [];
  for (const id of groupIds) {
    const { group, appId } = await readGroup(client, id);
    if (appId !== input.appId) {
      throw new InvalidInputError(
        `Group ${id} belongs to another app. Nothing was changed.`,
      );
    }
    groups.push(group);
  }
  const rows = await readTesterCsv(input.file);
  const plan: {
    source: ImportRow;
    testerId?: string;
    change: "none" | "add" | "invite";
    groups: string[];
  }[] = [];
  for (const source of rows) {
    const testerId = await findTester(client, {
      "filter[email]": source.email,
      "filter[apps]": input.appId,
    });
    if (!testerId) {
      plan.push({ source, change: "invite", groups: groupIds });
      continue;
    }
    const current = await testerGroupIds(client, testerId);
    const missing = groupIds.filter((id) => !current.has(id));
    plan.push({
      source,
      testerId,
      change: missing.length > 0 ? "add" : "none",
      groups: missing,
    });
  }
  const report = (
    item: (typeof plan)[number],
    extra: { error?: string } = {},
  ) => ({
    row: item.source.row,
    change: item.change,
    groups: item.groups,
    ...(item.testerId ? { testerId: item.testerId } : {}),
    ...extra,
  });
  const summary = (items: typeof plan) => ({
    invite: items.filter((item) => item.change === "invite").length,
    add: items.filter((item) => item.change === "add").length,
    none: items.filter((item) => item.change === "none").length,
  });
  if (!input.yes) {
    return {
      dryRun: true,
      action: "import-testers",
      appId: input.appId,
      groups,
      summary: summary(plan),
      rows: plan.map((item) => report(item)),
    };
  }
  const results = [];
  let failed = 0;
  for (const item of plan) {
    try {
      if (item.change === "add" && item.testerId) {
        await client.post(
          `/v1/betaTesters/${item.testerId}/relationships/betaGroups`,
          { data: item.groups.map((id) => ({ type: "betaGroups", id })) },
        );
      } else if (item.change === "invite") {
        const { email, firstName, lastName } = item.source;
        const created = await client.post<{ data: AscResource }>(
          "/v1/betaTesters",
          {
            data: {
              type: "betaTesters",
              attributes: { email, firstName, lastName },
              relationships: {
                betaGroups: {
                  data: item.groups.map((id) => ({ type: "betaGroups", id })),
                },
              },
            },
          },
        );
        item.testerId = created.data.id;
      }
      results.push(report(item));
    } catch (error) {
      failed++;
      const { kind, message } = classifyError(error);
      results.push(report(item, { error: `[${kind}] ${message}` }));
    }
  }
  return {
    dryRun: false,
    action: "import-testers",
    appId: input.appId,
    summary: summary(plan),
    failed,
    rows: results,
  };
}

export const exportTestersInput = z.object({
  appId: appIdSchema,
  group: groupIdSchema.optional(),
  out: z.string({ error: "Name the file to write with --out." }).min(1),
  format: z.enum(["csv", "json"]).optional(),
});

/** One CSV field, quoted when it needs to be; a leading =, +, - or @ is prefixed so spreadsheets do not run it. */
function csvField(value: string | null | undefined): string {
  let text = value ?? "";
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Writes an app's testers, or one group's, to a new file the user names, as
 * CSV or JSON. Names and emails go only to that file (mode 600), never to
 * stdout; the result says where it wrote and how many testers.
 */
export async function exportTesters(
  client: AscClient,
  input: z.output<typeof exportTestersInput>,
) {
  if (input.group) {
    const { appId } = await readGroup(client, input.group);
    if (appId !== input.appId) {
      throw new InvalidInputError(
        `Group ${input.group} belongs to another app.`,
      );
    }
  }
  const testers: Awaited<ReturnType<typeof listBetaTesters>>["testers"] = [];
  let cursor: string | undefined;
  do {
    const page = await listBetaTesters(client, {
      appId: input.appId,
      group: input.group,
      limit: 200,
      cursor,
    });
    testers.push(...page.testers);
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor);
  const format =
    input.format ??
    (input.out.toLowerCase().endsWith(".json") ? "json" : "csv");
  const contents =
    format === "json"
      ? `${JSON.stringify(testers, null, 2)}\n`
      : `${[
          "id,email,firstName,lastName,inviteType,state",
          ...testers.map((tester) =>
            [
              tester.id,
              tester.email,
              tester.firstName,
              tester.lastName,
              tester.inviteType,
              tester.state,
            ]
              .map(csvField)
              .join(","),
          ),
        ].join("\n")}\n`;
  try {
    await writeFile(input.out, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new InvalidInputError(
        `--out ${input.out} already exists; name a new file.`,
      );
    }
    throw new InvalidInputError(`Could not write --out ${input.out}.`);
  }
  return {
    appId: input.appId,
    group: input.group ?? null,
    file: input.out,
    format,
    count: testers.length,
  };
}

export const notifyInput = z.object({ buildId: buildIdSchema, yes: YES });

/**
 * Sends a build's "new build available" notification to its testers, for an
 * app that does not notify them automatically. Without `yes`, shows the build.
 */
export async function notifyTesters(
  client: AscClient,
  input: z.output<typeof notifyInput>,
) {
  const { build } = await readReview(client, input.buildId);
  if (build.expired) {
    throw new InvalidInputError(
      `Build ${build.version} has expired; testers cannot install it.`,
    );
  }
  if (!input.yes) {
    return { dryRun: true, action: "notify", build };
  }
  await client.post("/v1/buildBetaNotifications", {
    data: {
      type: "buildBetaNotifications",
      relationships: { build: { data: { type: "builds", id: input.buildId } } },
    },
  });
  return { dryRun: false, action: "notify", buildId: input.buildId };
}
