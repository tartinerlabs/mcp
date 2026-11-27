import * as z from "zod";
import type { AscClient, AscDocument, AscResource } from "../asc/client.ts";
import { idSchema } from "../schemas/common.ts";
import {
  AscApiError,
  classifyError,
  InvalidInputError,
  NotEditableError,
  NotFoundError,
  PermissionError,
} from "../utils/errors.ts";
import { EDITABLE_STATES as APP_INFO_EDITABLE_STATES } from "./app-info.ts";
import { reviewDraft, submitForReview } from "./custom-pages.ts";
import { EDITABLE_STATES } from "./metadata.ts";
import { missingReviewDetails, readReviewDetail } from "./review-details.ts";

/**
 * Release steps for an App Store version: attach a build, submit it for
 * review, cancel that review, release it, and pause, resume or complete its
 * phased release. Each re-reads the version first and refuses when its state
 * does not allow the step; without `yes` it only shows what it would do.
 */

const versionIdSchema = idSchema("versions");

const ROLE_HINT =
  "Attaching builds, submitting, cancelling and releasing need a key with the Admin or App Manager role.";

interface VersionAttributes {
  platform?: string;
  versionString?: string;
  appVersionState?: string;
  releaseType?: string;
}

interface BuildAttributes {
  version?: string;
  processingState?: string;
  expired?: boolean;
  usesNonExemptEncryption?: boolean | null;
}

interface PhasedReleaseAttributes {
  phasedReleaseState?: string;
  startDate?: string | null;
  currentDayNumber?: number | null;
  totalPauseDuration?: number | null;
}

/** The version with its app, build and phased release, as the release commands print it. */
async function readVersion(client: AscClient, versionId: string) {
  const response = await client.get<{
    data: AscResource<VersionAttributes>;
    included?: AscResource[];
  }>(`/v1/appStoreVersions/${versionId}`, {
    include: "build,appStoreVersionPhasedRelease",
    "fields[appStoreVersions]": [
      "platform",
      "versionString",
      "appVersionState",
      "releaseType",
      "app",
      "build",
      "appStoreVersionPhasedRelease",
    ],
    "fields[builds]": [
      "version",
      "processingState",
      "expired",
      "usesNonExemptEncryption",
    ],
    "fields[appStoreVersionPhasedReleases]": [
      "phasedReleaseState",
      "startDate",
      "currentDayNumber",
      "totalPauseDuration",
    ],
  });
  const { data } = response;
  const find = <Attributes>(relationship: string) => {
    const ref = data.relationships?.[relationship]?.data;
    if (!ref) return undefined;
    const found = response.included?.find(
      (item) => item.type === ref.type && item.id === ref.id,
    );
    return { id: ref.id, attributes: (found?.attributes ?? {}) as Attributes };
  };
  const appId = data.relationships?.app?.data?.id;
  if (!appId) {
    throw new NotFoundError(
      `App Store Connect returned version ${versionId} without its app.`,
    );
  }
  const build = find<BuildAttributes>("build");
  const phased = find<PhasedReleaseAttributes>("appStoreVersionPhasedRelease");
  return {
    appId,
    id: data.id,
    version: data.attributes?.versionString,
    platform: data.attributes?.platform ?? "IOS",
    state: data.attributes?.appVersionState,
    releaseType: data.attributes?.releaseType,
    build: build ? { id: build.id, ...build.attributes } : null,
    phasedRelease: phased ? { id: phased.id, ...phased.attributes } : null,
  };
}

type Version = Awaited<ReturnType<typeof readVersion>>;

/** What every release result prints about the version. */
function summary(version: Version) {
  return {
    appId: version.appId,
    versionId: version.id,
    version: version.version,
    platform: version.platform,
    state: version.state,
  };
}

/** Runs a write, turning Apple's 403 into a `[permission]` error naming the role needed. */
async function write<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (error instanceof AscApiError && error.status === 403) {
      throw new PermissionError(
        `${classifyError(error).message} ${ROLE_HINT}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export const attachBuildInput = z.object({
  versionId: versionIdSchema,
  buildId: idSchema("builds"),
  yes: z.boolean().default(false),
});

/**
 * Attaches a build to a version being prepared or rejected. Refuses a build
 * of another app or platform, one that has not finished processing, or one
 * that has expired.
 */
export async function attachBuild(
  client: AscClient,
  input: z.output<typeof attachBuildInput>,
) {
  const version = await readVersion(client, input.versionId);
  if (!EDITABLE_STATES.has(version.state ?? "")) {
    throw new NotEditableError(
      `Version ${version.version} is ${version.state}, so its build can no longer be changed. Attach builds to a version that is PREPARE_FOR_SUBMISSION or rejected.`,
    );
  }
  const response = await client.get<{
    data: AscResource<BuildAttributes>;
    included?: AscResource<{ platform?: string; version?: string }>[];
  }>(`/v1/builds/${input.buildId}`, {
    include: "preReleaseVersion",
    "fields[builds]": [
      "version",
      "processingState",
      "expired",
      "usesNonExemptEncryption",
      "app",
      "preReleaseVersion",
    ],
    "fields[preReleaseVersions]": ["version", "platform"],
  });
  const attributes = response.data.attributes ?? {};
  const preRelease = response.included?.find(
    (item) => item.type === "preReleaseVersions",
  )?.attributes;
  const build = {
    id: input.buildId,
    version: attributes.version,
    marketingVersion: preRelease?.version,
    platform: preRelease?.platform,
    processingState: attributes.processingState,
    expired: attributes.expired,
    usesNonExemptEncryption: attributes.usesNonExemptEncryption ?? null,
  };
  const buildApp = response.data.relationships?.app?.data?.id;
  if (buildApp !== version.appId) {
    throw new InvalidInputError(
      `Build ${input.buildId} belongs to app ${buildApp ?? "unknown"}, not app ${version.appId} of version ${version.version}.`,
    );
  }
  if (build.platform && build.platform !== version.platform) {
    throw new InvalidInputError(
      `Build ${build.version} is for ${build.platform}, but version ${version.version} is for ${version.platform}.`,
    );
  }
  if (build.processingState !== "VALID" || build.expired) {
    throw new InvalidInputError(
      `Build ${build.version} is ${build.expired ? "expired" : build.processingState}; only an unexpired build that finished processing as VALID can be attached. The builds wait command waits for processing.`,
    );
  }
  const changes = version.build?.id !== input.buildId;
  const base = {
    action: "attach-build",
    ...summary(version),
    currentBuild: version.build,
    build,
    changes,
  };
  if (!input.yes) return { dryRun: true, ...base };
  if (changes) {
    await write(() =>
      client.patch(
        `/v1/appStoreVersions/${input.versionId}/relationships/build`,
        { data: { type: "builds", id: input.buildId } },
      ),
    );
  }
  return { dryRun: false, ...base };
}

/** Review submission states in which the version is waiting for or in review. */
const OPEN_SUBMISSION_STATES = [
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "UNRESOLVED_ISSUES",
  "CANCELING",
] as const;

/** States in which a review submission can still be cancelled. */
const CANCELLABLE_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW"]);

/** The app's submitted review submission that holds the version, if any. */
async function openSubmission(client: AscClient, version: Version) {
  const response = await client.get<
    AscDocument<{ state?: string; submittedDate?: string | null }>
  >("/v1/reviewSubmissions", {
    "filter[app]": version.appId,
    "filter[platform]": version.platform,
    "filter[state]": OPEN_SUBMISSION_STATES,
    "fields[reviewSubmissions]": [
      "platform",
      "state",
      "submittedDate",
      "appStoreVersionForReview",
    ],
    limit: 200,
  });
  const submission = response.data.find(
    (entry) =>
      entry.relationships?.appStoreVersionForReview?.data?.id === version.id,
  );
  if (!submission) return undefined;
  return {
    id: submission.id,
    state: submission.attributes?.state,
    submittedDate: submission.attributes?.submittedDate ?? null,
  };
}

/**
 * Optional age rating answers. Assumption: Apple's docs do not list which
 * declaration attributes a submission requires; these are overrides, links
 * and deprecated questions, and every other unanswered (null) one counts as
 * missing, so a question Apple adds later (such as the September 2026 one
 * about social media features) is checked without a code change.
 */
const OPTIONAL_AGE_RATING_ANSWERS = new Set([
  "kidsAgeBand",
  "ageRatingOverride",
  "ageRatingOverrideV2",
  "koreaAgeRatingOverride",
  "developerAgeRatingInfoUrl",
  "seventeenPlus",
  "gamblingAndContests",
]);

/** Unanswered age rating questions of the app info that goes for review with the version. */
async function missingAgeRatingAnswers(client: AscClient, appId: string) {
  const appInfos = await client.get<AscDocument<{ state?: string }>>(
    `/v1/apps/${appId}/appInfos`,
    { "fields[appInfos]": ["state"], limit: 200 },
  );
  const editable = appInfos.data.filter((info) =>
    APP_INFO_EDITABLE_STATES.has(info.attributes?.state ?? ""),
  );
  const checked = editable.length > 0 ? editable : appInfos.data;
  const missing: { appInfoId: string; questions: string[] }[] = [];
  for (const info of checked) {
    const { data } = await client.get<{
      data: AscResource<Record<string, unknown>>;
    }>(`/v1/appInfos/${info.id}/ageRatingDeclaration`);
    const questions = Object.entries(data.attributes ?? {})
      .filter(
        ([name, value]) =>
          value === null && !OPTIONAL_AGE_RATING_ANSWERS.has(name),
      )
      .map(([name]) => name);
    if (questions.length > 0) missing.push({ appInfoId: info.id, questions });
  }
  return missing;
}

/**
 * Unanswered questions of the app's accessibility declarations that are not
 * replaced. Assumption: Apple's docs do not say whether a submission needs
 * them; an app without declarations passes, and one with an unfinished
 * declaration is refused so it is not published half answered.
 */
async function missingAccessibilityAnswers(client: AscClient, appId: string) {
  const response = await client.get<
    AscDocument<Record<string, unknown> & { state?: string }>
  >(`/v1/apps/${appId}/accessibilityDeclarations`, { limit: 200 });
  return response.data
    .filter((declaration) => declaration.attributes?.state !== "REPLACED")
    .map((declaration) => ({
      declarationId: declaration.id,
      deviceFamily: declaration.attributes?.deviceFamily,
      questions: Object.entries(declaration.attributes ?? {})
        .filter(
          ([name, value]) => name.startsWith("supports") && value === null,
        )
        .map(([name]) => name),
    }))
    .filter((declaration) => declaration.questions.length > 0);
}

export const submitVersionInput = z.object({
  versionId: versionIdSchema,
  yes: z.boolean().default(false),
});

/**
 * Submits a version for App Review on its own: it goes into a new review
 * submission, or one being prepared that holds nothing else. Refuses a
 * version that is not being prepared or rejected, has no valid build or an
 * unanswered export compliance question, is already submitted, whose age
 * rating or accessibility declarations have unanswered questions, or whose
 * App Review details leave a required field blank.
 */
export async function submitVersion(
  client: AscClient,
  input: z.output<typeof submitVersionInput>,
) {
  const version = await readVersion(client, input.versionId);
  if (!EDITABLE_STATES.has(version.state ?? "")) {
    throw new NotEditableError(
      `Version ${version.version} is ${version.state}, so it cannot be submitted for review. Submit a version that is PREPARE_FOR_SUBMISSION or rejected.`,
    );
  }
  const { build } = version;
  if (!build) {
    throw new InvalidInputError(
      `Version ${version.version} has no build. Attach one with versions attach-build first.`,
    );
  }
  if (build.processingState !== "VALID" || build.expired) {
    throw new InvalidInputError(
      `Build ${build.version} of version ${version.version} is ${build.expired ? "expired" : build.processingState}. Attach a VALID, unexpired build with versions attach-build.`,
    );
  }
  if (build.usesNonExemptEncryption == null) {
    throw new InvalidInputError(
      `Build ${build.version} has not answered the export compliance question. Answer it with builds compliance ${build.id} first.`,
    );
  }
  const open = await openSubmission(client, version);
  if (open) {
    throw new NotEditableError(
      `Version ${version.version} is already in review submission ${open.id}, which is ${open.state}. Cancel it with versions cancel-review, or resolve it in App Store Connect.`,
    );
  }
  const ageRating = await missingAgeRatingAnswers(client, version.appId);
  if (ageRating.length > 0) {
    throw new InvalidInputError(
      `The age rating declaration has unanswered questions: ${ageRating
        .map(
          (entry) =>
            `${entry.questions.join(", ")} (app info ${entry.appInfoId})`,
        )
        .join("; ")}. Answer them with age-rating set first.`,
    );
  }
  const accessibility = await missingAccessibilityAnswers(
    client,
    version.appId,
  );
  if (accessibility.length > 0) {
    throw new InvalidInputError(
      `Accessibility declarations have unanswered questions: ${accessibility
        .map(
          (entry) =>
            `${entry.questions.join(", ")} (${entry.deviceFamily ?? entry.declarationId})`,
        )
        .join("; ")}. Answer them in App Store Connect first.`,
    );
  }
  const reviewDetails = missingReviewDetails(
    await readReviewDetail(client, version.id),
  );
  if (reviewDetails.length > 0) {
    throw new InvalidInputError(
      `The App Review details leave ${reviewDetails.join(", ")} blank. Set them with review-details set first.`,
    );
  }
  const item = {
    relationship: "appStoreVersion",
    type: "appStoreVersions",
    id: input.versionId,
  } as const;
  const draft = await reviewDraft(
    client,
    version.appId,
    version.platform,
    item,
  );
  const base = { action: "submit", ...summary(version), build };
  if (!input.yes) {
    return { dryRun: true, ...base, reviewSubmissionId: draft.id ?? null };
  }
  const submitted = await write(() =>
    submitForReview(client, version.appId, version.platform, draft, item),
  );
  return { dryRun: false, ...base, ...submitted };
}

export const cancelReviewInput = z.object({
  versionId: versionIdSchema,
  yes: z.boolean().default(false),
});

/**
 * Cancels the review submission holding a version that is waiting for or in
 * review, which returns the version to an editable state and loses its place
 * in the queue. Refuses when the submission holds other items, which
 * cancelling would withdraw too.
 */
export async function cancelReview(
  client: AscClient,
  input: z.output<typeof cancelReviewInput>,
) {
  const version = await readVersion(client, input.versionId);
  const submission = await openSubmission(client, version);
  if (!submission) {
    throw new NotFoundError(
      `Version ${version.version} (${version.state}) is not in a submitted review submission, so there is nothing to cancel.`,
    );
  }
  if (!CANCELLABLE_STATES.has(submission.state ?? "")) {
    throw new NotEditableError(
      submission.state === "CANCELING"
        ? `Review submission ${submission.id} is already being cancelled.`
        : `Review submission ${submission.id} is ${submission.state}, so it can no longer be cancelled; a rejected version can be changed and resubmitted.`,
    );
  }
  const items = await client.get<AscDocument<unknown>>(
    `/v1/reviewSubmissions/${submission.id}/items`,
    {
      "fields[reviewSubmissionItems]": ["state", "appStoreVersion"],
      limit: 200,
    },
  );
  const others = items.data.filter(
    (entry) => entry.relationships?.appStoreVersion?.data?.id !== version.id,
  ).length;
  if (others > 0) {
    throw new InvalidInputError(
      `Review submission ${submission.id} also holds ${others} other item(s), which cancelling would withdraw too. Cancel it in App Store Connect instead.`,
    );
  }
  const base = { action: "cancel-review", ...summary(version), submission };
  if (!input.yes) return { dryRun: true, ...base };
  const canceled = await write(() =>
    client.patch<{ data?: AscResource<{ state?: string }> }>(
      `/v1/reviewSubmissions/${submission.id}`,
      {
        data: {
          type: "reviewSubmissions",
          id: submission.id,
          attributes: { canceled: true },
        },
      },
    ),
  );
  return {
    dryRun: false,
    ...base,
    reviewSubmissionId: submission.id,
    submissionState: canceled?.data?.attributes?.state,
  };
}

export const releaseVersionInput = z.object({
  versionId: versionIdSchema,
  yes: z.boolean().default(false),
});

/** Releases a version that App Review approved and that waits for the developer to release it. */
export async function releaseVersion(
  client: AscClient,
  input: z.output<typeof releaseVersionInput>,
) {
  const version = await readVersion(client, input.versionId);
  if (version.state !== "PENDING_DEVELOPER_RELEASE") {
    throw new NotEditableError(
      `Version ${version.version} is ${version.state}; only a version that is PENDING_DEVELOPER_RELEASE can be released.`,
    );
  }
  const base = {
    action: "release",
    ...summary(version),
    phasedRelease: version.phasedRelease,
  };
  if (!input.yes) return { dryRun: true, ...base };
  await write(() =>
    client.post("/v1/appStoreVersionReleaseRequests", {
      data: {
        type: "appStoreVersionReleaseRequests",
        relationships: {
          appStoreVersion: {
            data: { type: "appStoreVersions", id: input.versionId },
          },
        },
      },
    }),
  );
  return { dryRun: false, ...base };
}

/** Each phased release action: the states it starts from and the state it sets. */
const PHASED_ACTIONS = {
  pause: { from: ["ACTIVE"], to: "PAUSED" },
  resume: { from: ["PAUSED"], to: "ACTIVE" },
  complete: { from: ["ACTIVE", "PAUSED"], to: "COMPLETE" },
} as const;

export const PHASED_RELEASE_ACTIONS = Object.keys(PHASED_ACTIONS) as [
  keyof typeof PHASED_ACTIONS,
  ...(keyof typeof PHASED_ACTIONS)[],
];

export const phasedReleaseInput = z.object({
  versionId: versionIdSchema,
  action: z.enum(PHASED_RELEASE_ACTIONS),
  yes: z.boolean().default(false),
});

/**
 * Pauses, resumes or completes a version's phased release; completing
 * releases it to every user at once.
 */
export async function setPhasedRelease(
  client: AscClient,
  input: z.output<typeof phasedReleaseInput>,
) {
  const version = await readVersion(client, input.versionId);
  const phased = version.phasedRelease;
  if (!phased) {
    throw new NotFoundError(
      `Version ${version.version} has no phased release.`,
    );
  }
  const { from, to } = PHASED_ACTIONS[input.action];
  if (!(from as readonly string[]).includes(phased.phasedReleaseState ?? "")) {
    throw new NotEditableError(
      `The phased release of version ${version.version} is ${phased.phasedReleaseState}, so it cannot ${input.action}; that needs ${from.join(" or ")}.`,
    );
  }
  const base = {
    action: `phased-release ${input.action}`,
    ...summary(version),
    phasedRelease: phased,
    newState: to,
  };
  if (!input.yes) return { dryRun: true, ...base };
  await write(() =>
    client.patch(`/v1/appStoreVersionPhasedReleases/${phased.id}`, {
      data: {
        type: "appStoreVersionPhasedReleases",
        id: phased.id,
        attributes: { phasedReleaseState: to },
      },
    }),
  );
  return { dryRun: false, ...base };
}
