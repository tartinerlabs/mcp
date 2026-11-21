import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  pageInfo,
} from "../asc/client.ts";
import {
  appIdSchema,
  commaList,
  cursorSchema,
  idSchema,
  limitSchema,
  localeSchema,
  PLATFORMS,
} from "../schemas/common.ts";
import {
  NotEditableError,
  UnexpectedResponseError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import { reviewDraft, submitForReview } from "./custom-pages.ts";
import { placeFiles, planUpload, showPlanned } from "./screenshots.ts";

/**
 * Product page optimization tests (Apple's appStoreVersionExperimentsV2): an
 * app-wide A/B test of up to three treatments, each with its own icon,
 * screenshots and previews, against the default product page. A test is
 * reviewed, then started and stopped. Apple's API returns no conversion
 * results for a test; those are in App Store Connect and analytics reports.
 */

const testIdSchema = idSchema("page-tests");
const treatmentIdSchema = idSchema("page-tests show");

export const TEST_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "ACCEPTED",
  "APPROVED",
  "REJECTED",
  "COMPLETED",
  "STOPPED",
] as const;

/**
 * Test states whose treatments accept new screenshots and previews.
 *
 * Assumption: Apple's API docs list the states but not which accept changes;
 * this follows App Store Connect, where a test is edited before review or
 * after a rejection.
 */
const EDITABLE_STATES = new Set(["PREPARE_FOR_SUBMISSION", "REJECTED"]);

/** Test states that can go to review; READY_FOR_REVIEW is one already in a draft submission. */
const SUBMITTABLE_STATES = new Set([...EDITABLE_STATES, "READY_FOR_REVIEW"]);

/** States of a test that has ended and cannot start or stop again. */
const ENDED_STATES = new Set(["COMPLETED", "STOPPED"]);

interface TestAttributes {
  name?: string;
  platform?: string;
  state?: string;
  trafficProportion?: number;
  reviewRequired?: boolean;
  startDate?: string | null;
  endDate?: string | null;
}

interface TreatmentAttributes {
  name?: string;
  appIconName?: string | null;
  promotedDate?: string | null;
}

const TEST_FIELDS = [
  "name",
  "platform",
  "state",
  "trafficProportion",
  "reviewRequired",
  "startDate",
  "endDate",
] as const;

const TREATMENT_FIELDS = ["name", "appIconName", "promotedDate"] as const;

function shapeTest({ id, attributes }: AscResource<TestAttributes>) {
  return {
    id,
    name: attributes?.name,
    platform: attributes?.platform,
    state: attributes?.state,
    trafficProportion: attributes?.trafficProportion,
    reviewRequired: attributes?.reviewRequired,
    startDate: attributes?.startDate ?? null,
    endDate: attributes?.endDate ?? null,
  };
}

function shapeTreatment({ id, attributes }: AscResource<TreatmentAttributes>) {
  return {
    id,
    name: attributes?.name,
    appIconName: attributes?.appIconName ?? null,
    promotedDate: attributes?.promotedDate ?? null,
  };
}

/** A test with the id of the app it belongs to. */
async function readTest(client: AscClient, testId: string) {
  const { data } = await client.get<{ data: AscResource<TestAttributes> }>(
    `/v2/appStoreVersionExperiments/${testId}`,
    {
      "fields[appStoreVersionExperiments]": [...TEST_FIELDS, "app"],
      include: "app",
    },
  );
  const appId = data.relationships?.app?.data?.id;
  if (!appId) {
    throw new UnexpectedResponseError(
      "App Store Connect did not say which app the product page test belongs to.",
    );
  }
  return { test: shapeTest(data), appId };
}

type Test = ReturnType<typeof shapeTest>;

function listLocalizations(client: AscClient, treatmentId: string) {
  // A treatment has at most one localization per App Store locale, fewer than one page of 200.
  return client.get<AscDocument<{ locale?: string }>>(
    `/v1/appStoreVersionExperimentTreatments/${treatmentId}/appStoreVersionExperimentTreatmentLocalizations`,
    {
      "fields[appStoreVersionExperimentTreatmentLocalizations]": ["locale"],
      limit: 200,
    },
  );
}

export const pageTestsInput = z.object({
  appId: appIdSchema,
  state: commaList(z.enum(TEST_STATES)),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** An app's product page tests: state, traffic proportion, dates and treatments. */
export async function listPageTests(
  client: AscClient,
  input: z.output<typeof pageTestsInput>,
) {
  const response = await client.get<AscDocument<TestAttributes>>(
    `/v1/apps/${input.appId}/appStoreVersionExperimentsV2`,
    {
      "fields[appStoreVersionExperiments]": [
        ...TEST_FIELDS,
        "appStoreVersionExperimentTreatments",
      ],
      "fields[appStoreVersionExperimentTreatments]": TREATMENT_FIELDS,
      include: "appStoreVersionExperimentTreatments",
      // A test has at most three treatments, well under Apple's limit of 50.
      "limit[appStoreVersionExperimentTreatments]": 50,
      "filter[state]": input.state,
      limit: input.limit,
      cursor: input.cursor,
    },
  );
  const treatments = new Map(
    (response.included ?? [])
      .filter((item) => item.type === "appStoreVersionExperimentTreatments")
      .map((item) => [
        item.id,
        shapeTreatment(item as AscResource<TreatmentAttributes>),
      ]),
  );
  return {
    tests: response.data.map((test) => {
      // A to-many relationship's data is a list of references.
      const refs = test.relationships?.appStoreVersionExperimentTreatments
        ?.data as unknown as { id: string }[] | undefined;
      return {
        ...shapeTest(test),
        treatments: (refs ?? []).flatMap(({ id }) => treatments.get(id) ?? []),
      };
    }),
    ...pageInfo(response),
  };
}

export const pageTestInput = z.object({ testId: testIdSchema });

/** One product page test with each treatment's icon and locales. */
export async function getPageTest(
  client: AscClient,
  input: z.output<typeof pageTestInput>,
) {
  const { test } = await readTest(client, input.testId);
  const response = await client.get<AscDocument<TreatmentAttributes>>(
    `/v2/appStoreVersionExperiments/${input.testId}/appStoreVersionExperimentTreatments`,
    {
      "fields[appStoreVersionExperimentTreatments]": TREATMENT_FIELDS,
      limit: 200,
    },
  );
  const treatments = [];
  for (const treatment of response.data) {
    const localizations = await listLocalizations(client, treatment.id);
    treatments.push({
      ...shapeTreatment(treatment),
      localizations: localizations.data.map(({ id, attributes }) => ({
        id,
        locale: attributes?.locale,
      })),
    });
  }
  return { test, treatments };
}

/** `Name` or `Name=AppIconName`: the treatment's name and the alternate icon it shows. */
const treatmentSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => {
    const split = value.lastIndexOf("=");
    if (split < 0) return { name: value, appIconName: null };
    return {
      name: value.slice(0, split).trim(),
      appIconName: value.slice(split + 1).trim() || null,
    };
  })
  .refine((treatment) => treatment.name.length > 0, {
    message:
      "Give each --treatment a name, such as --treatment Bold=AppIconBold.",
  });

export const createPageTestInput = z.object({
  appId: appIdSchema,
  name: z
    .string({ error: "Give the test's name with --name." })
    .trim()
    .min(1, "Give the test's name with --name."),
  platform: z.enum(PLATFORMS).default("IOS"),
  // Assumption: Apple documents an integer; App Store Connect asks for a percentage of visitors.
  trafficProportion: z.coerce
    .number({ error: "Give the share of traffic with --traffic-proportion." })
    .int()
    .min(1)
    .max(100),
  treatments: z
    .array(treatmentSchema)
    .min(1, "Give at least one --treatment.")
    .max(3, "A test has at most 3 treatments."),
  // Treatment localizations are only created here, and upload needs one per locale folder.
  locales: z
    .array(localeSchema)
    .min(1, "Give at least one --locale for the treatments' screenshots."),
  yes: z.boolean().default(false),
});

/**
 * Creates a test with its treatments and, on each treatment, a localization
 * per locale for screenshots and previews. Without `yes`, shows the test and
 * how many of the app's tests have not ended.
 */
export async function createPageTest(
  client: AscClient,
  input: z.output<typeof createPageTestInput>,
) {
  const test = {
    name: input.name,
    platform: input.platform,
    trafficProportion: input.trafficProportion,
    treatments: input.treatments,
    locales: input.locales,
  };
  if (!input.yes) {
    const open = await client.get<AscDocument<TestAttributes>>(
      `/v1/apps/${input.appId}/appStoreVersionExperimentsV2`,
      {
        "fields[appStoreVersionExperiments]": ["state"],
        "filter[state]": TEST_STATES.filter(
          (state) => !ENDED_STATES.has(state),
        ),
        limit: 1,
      },
    );
    return {
      dryRun: true,
      action: "create",
      appId: input.appId,
      test,
      openTests: open.meta?.paging?.total,
    };
  }
  const created = await client.post<{ data: AscResource<TestAttributes> }>(
    "/v2/appStoreVersionExperiments",
    {
      data: {
        type: "appStoreVersionExperiments",
        attributes: {
          name: input.name,
          platform: input.platform,
          trafficProportion: input.trafficProportion,
        },
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    },
  );
  const testId = created.data.id;
  // Apple's create request takes no treatments, so each is its own request.
  const treatments = [];
  try {
    for (const treatment of input.treatments) {
      const { data } = await client.post<{
        data: AscResource<TreatmentAttributes>;
      }>("/v1/appStoreVersionExperimentTreatments", {
        data: {
          type: "appStoreVersionExperimentTreatments",
          attributes: {
            name: treatment.name,
            ...(treatment.appIconName === null
              ? {}
              : { appIconName: treatment.appIconName }),
          },
          relationships: {
            appStoreVersionExperimentV2: {
              data: { type: "appStoreVersionExperiments", id: testId },
            },
          },
        },
      });
      const localizations: { id: string; locale: string }[] = [];
      treatments.push({ ...shapeTreatment(data), localizations });
      for (const locale of input.locales) {
        const { data: localization } = await client.post<{
          data: AscResource;
        }>("/v1/appStoreVersionExperimentTreatmentLocalizations", {
          data: {
            type: "appStoreVersionExperimentTreatmentLocalizations",
            attributes: { locale },
            relationships: {
              appStoreVersionExperimentTreatment: {
                data: {
                  type: "appStoreVersionExperimentTreatments",
                  id: data.id,
                },
              },
            },
          },
        });
        localizations.push({ id: localization.id, locale });
      }
    }
  } catch (error) {
    const done = treatments.map(
      ({ id, name, localizations }) =>
        `${name} (${id}${localizations.length > 0 ? `; ${localizations.map(({ locale }) => locale).join(", ")}` : ""})`,
    );
    throw new UploadIncompleteError(
      `Test ${testId} was created but setting it up stopped partway. ${done.length > 0 ? `Treatments created: ${done.join(", ")}.` : "No treatments were created."} Finish it in App Store Connect, or delete it there and run the command again.`,
      { cause: error },
    );
  }
  return {
    dryRun: false,
    action: "create",
    test: shapeTest(created.data),
    treatments,
  };
}

export const uploadPageTestInput = z.object({
  treatmentId: treatmentIdSchema,
  dir: z
    .string({ error: "Give the folder to upload with --dir." })
    .trim()
    .min(1, "Give the folder to upload with --dir."),
  yes: z.boolean().default(false),
});

/**
 * Uploads a folder of screenshots and app previews to a treatment, the same
 * way `screenshots upload` does for an App Store version. Without `yes`,
 * shows where each file would go.
 */
export async function uploadPageTestScreenshots(
  client: AscClient,
  input: z.output<typeof uploadPageTestInput>,
) {
  const { data: treatment } = await client.get<{
    data: AscResource<TreatmentAttributes>;
  }>(`/v1/appStoreVersionExperimentTreatments/${input.treatmentId}`, {
    "fields[appStoreVersionExperimentTreatments]": [
      "name",
      "appStoreVersionExperimentV2",
    ],
    include: "appStoreVersionExperimentV2",
  });
  const testId = treatment.relationships?.appStoreVersionExperimentV2?.data?.id;
  if (!testId) {
    throw new UnexpectedResponseError(
      "App Store Connect did not say which product page test the treatment belongs to.",
    );
  }
  const { test, appId } = await readTest(client, testId);
  editable(test, "treatments' screenshots and previews");
  const localizations = await listLocalizations(client, input.treatmentId);
  const target = {
    localizationType: "appStoreVersionExperimentTreatmentLocalizations",
    relationship: "appStoreVersionExperimentTreatmentLocalization",
    feature: "PRODUCT_PAGE_OPTIMIZATIONS",
    label: `Treatment ${treatment.attributes?.name} of product page test ${test.name}`,
    localesCommand: "page-tests show",
    localizations: localizations.data.map(({ id, attributes }) => ({
      id,
      locale: attributes?.locale ?? "",
    })),
  } as const;
  const { files, skipped } = await planUpload(client, input.dir, target);
  if (!input.yes) {
    return {
      dryRun: true,
      action: "upload",
      test,
      treatment: shapeTreatment(treatment),
      files: showPlanned(files),
      skipped,
    };
  }
  return {
    dryRun: false,
    action: "upload",
    treatmentId: input.treatmentId,
    uploaded: await placeFiles(client, appId, target, files),
    skipped,
  };
}

function editable(test: Test, what: string) {
  if (!EDITABLE_STATES.has(test.state ?? "")) {
    throw new NotEditableError(
      `Product page test ${test.name} is ${test.state}, so its ${what} can no longer be changed. Use a test that is PREPARE_FOR_SUBMISSION or REJECTED.`,
    );
  }
}

export const pageTestWriteInput = z.object({
  testId: testIdSchema,
  yes: z.boolean().default(false),
});

/**
 * Submits a test for App Review on its own, on the test's platform: it goes
 * into a new review submission, or one being prepared that holds nothing
 * else. Without `yes`, shows the test and the submission it would use.
 */
export async function submitPageTest(
  client: AscClient,
  input: z.output<typeof pageTestWriteInput>,
) {
  const { test, appId } = await readTest(client, input.testId);
  if (!SUBMITTABLE_STATES.has(test.state ?? "")) {
    throw new NotEditableError(
      `Product page test ${test.name} is ${test.state}, so it cannot be submitted for review. Submit a test that is PREPARE_FOR_SUBMISSION or REJECTED.`,
    );
  }
  if (!test.platform) {
    throw new UnexpectedResponseError(
      "App Store Connect did not say which platform the product page test is for.",
    );
  }
  const item = {
    relationship: "appStoreVersionExperimentV2",
    type: "appStoreVersionExperiments",
    id: input.testId,
  } as const;
  const draft = await reviewDraft(client, appId, test.platform, item);
  if (!input.yes) {
    return {
      dryRun: true,
      action: "submit",
      test,
      reviewSubmissionId: draft.id ?? null,
    };
  }
  return {
    dryRun: false,
    action: "submit",
    testId: input.testId,
    ...(await submitForReview(client, appId, test.platform, draft, item)),
  };
}

/** Sets the test's `started` attribute and returns its new state. */
async function setStarted(client: AscClient, testId: string, started: boolean) {
  const updated = await client.patch<{ data?: AscResource<TestAttributes> }>(
    `/v2/appStoreVersionExperiments/${testId}`,
    {
      data: {
        type: "appStoreVersionExperiments",
        id: testId,
        attributes: { started },
      },
    },
  );
  return updated?.data ? shapeTest(updated.data) : undefined;
}

/**
 * Starts a test that App Review accepted, or one that needs no review.
 * Without `yes`, shows the test.
 *
 * Assumption: Apple's docs do not say which states can start; this allows
 * ACCEPTED and APPROVED, and PREPARE_FOR_SUBMISSION when `reviewRequired` is
 * false, and leaves the final word to Apple.
 */
export async function startPageTest(
  client: AscClient,
  input: z.output<typeof pageTestWriteInput>,
) {
  const { test } = await readTest(client, input.testId);
  const startable =
    test.startDate === null &&
    (test.state === "ACCEPTED" ||
      test.state === "APPROVED" ||
      (test.state === "PREPARE_FOR_SUBMISSION" &&
        test.reviewRequired === false));
  if (!startable) {
    throw new NotEditableError(
      test.startDate !== null
        ? `Product page test ${test.name} already started on ${test.startDate}.`
        : `Product page test ${test.name} is ${test.state}, so it cannot start. Submit it for review with page-tests submit and start it once it is approved.`,
    );
  }
  if (!input.yes) return { dryRun: true, action: "start", test };
  return {
    dryRun: false,
    action: "start",
    testId: input.testId,
    test: await setStarted(client, input.testId, true),
  };
}

/**
 * Stops a running test. Without `yes`, shows the test.
 *
 * Assumption: Apple documents only the `started` attribute; setting it to
 * false is taken to stop the test, as App Store Connect's Stop Test does.
 */
export async function stopPageTest(
  client: AscClient,
  input: z.output<typeof pageTestWriteInput>,
) {
  const { test } = await readTest(client, input.testId);
  if (test.startDate === null || ENDED_STATES.has(test.state ?? "")) {
    throw new NotEditableError(
      test.startDate === null
        ? `Product page test ${test.name} has not started, so there is nothing to stop.`
        : `Product page test ${test.name} is already ${test.state}.`,
    );
  }
  if (!input.yes) return { dryRun: true, action: "stop", test };
  return {
    dryRun: false,
    action: "stop",
    testId: input.testId,
    test: await setStarted(client, input.testId, false),
  };
}
