import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  pageInfo,
} from "../asc/client.ts";
import {
  appIdSchema,
  cursorSchema,
  idSchema,
  limitSchema,
  localeSchema,
  PLATFORMS,
} from "../schemas/common.ts";
import {
  AscApiError,
  classifyError,
  InvalidInputError,
  NotEditableError,
  NotFoundError,
  UnexpectedResponseError,
} from "../utils/errors.ts";
import { placeFiles, planUpload, showPlanned } from "./screenshots.ts";

/**
 * Custom product pages: alternate product pages of an app, each with
 * versions that are reviewed on their own, and a promotional text plus
 * screenshots and previews per locale.
 */

const pageIdSchema = idSchema("custom-pages");
const pageVersionIdSchema = idSchema("custom-pages show");

interface PageAttributes {
  name?: string;
  url?: string;
  visible?: boolean;
}

interface PageVersionAttributes {
  version?: string;
  state?: string;
  deepLink?: string | null;
}

interface PageLocalizationAttributes {
  locale?: string;
  promotionalText?: string | null;
}

/**
 * Page version states that accept changes.
 *
 * Assumption: Apple's API docs list the states but not which accept a PATCH
 * or new placements; this follows App Store Connect, where only a version
 * being prepared or rejected can be edited.
 */
const EDITABLE_STATES = new Set(["PREPARE_FOR_SUBMISSION", "REJECTED"]);

/** Page version states that can go to review; READY_FOR_REVIEW is one already in a draft submission. */
const SUBMITTABLE_STATES = new Set([...EDITABLE_STATES, "READY_FOR_REVIEW"]);

function shapePage({ id, attributes }: AscResource<PageAttributes>) {
  return {
    id,
    name: attributes?.name,
    url: attributes?.url,
    visible: attributes?.visible,
  };
}

/** A page version with its page's id and name. */
async function readPageVersion(client: AscClient, versionId: string) {
  const response = await client.get<{
    data: AscResource<PageVersionAttributes>;
    included?: AscResource<PageAttributes>[];
  }>(`/v1/appCustomProductPageVersions/${versionId}`, {
    "fields[appCustomProductPageVersions]": [
      "version",
      "state",
      "deepLink",
      "appCustomProductPage",
    ],
    "fields[appCustomProductPages]": ["name"],
    include: "appCustomProductPage",
  });
  const pageId =
    response.data.relationships?.appCustomProductPage?.data?.id ?? "";
  return {
    id: response.data.id,
    version: response.data.attributes?.version,
    state: response.data.attributes?.state,
    deepLink: response.data.attributes?.deepLink ?? null,
    pageId,
    page: response.included?.find((item) => item.id === pageId)?.attributes
      ?.name,
  };
}

type PageVersion = Awaited<ReturnType<typeof readPageVersion>>;

function editable(version: PageVersion, what: string) {
  if (!EDITABLE_STATES.has(version.state ?? "")) {
    throw new NotEditableError(
      `Version ${version.version} of custom product page ${version.page} is ${version.state}, so its ${what} can no longer be changed. Use a page version that is PREPARE_FOR_SUBMISSION or REJECTED.`,
    );
  }
}

/** The app a custom product page belongs to. */
async function pageAppId(client: AscClient, pageId: string) {
  const { data } = await client.get<{ data: AscResource }>(
    `/v1/appCustomProductPages/${pageId}`,
    { "fields[appCustomProductPages]": ["app"], include: "app" },
  );
  const appId = data.relationships?.app?.data?.id;
  if (!appId) {
    throw new UnexpectedResponseError(
      "App Store Connect did not say which app the custom product page belongs to.",
    );
  }
  return appId;
}

function listLocalizations(
  client: AscClient,
  versionId: string,
  locale?: string,
) {
  // A page has far fewer locales than the 200 one page holds.
  return client.get<AscDocument<PageLocalizationAttributes>>(
    `/v1/appCustomProductPageVersions/${versionId}/appCustomProductPageLocalizations`,
    {
      "fields[appCustomProductPageLocalizations]": [
        "locale",
        "promotionalText",
      ],
      "filter[locale]": locale,
      limit: 200,
    },
  );
}

export const customPagesInput = z.object({
  appId: appIdSchema,
  visible: z.boolean().optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** An app's custom product pages: name, URL and whether it is visible. */
export async function listCustomPages(
  client: AscClient,
  input: z.output<typeof customPagesInput>,
) {
  const response = await client.get<AscDocument<PageAttributes>>(
    `/v1/apps/${input.appId}/appCustomProductPages`,
    {
      "fields[appCustomProductPages]": ["name", "url", "visible"],
      "filter[visible]":
        input.visible === undefined ? undefined : String(input.visible),
      limit: input.limit,
      cursor: input.cursor,
    },
  );
  return { pages: response.data.map(shapePage), ...pageInfo(response) };
}

export const customPageInput = z.object({ pageId: pageIdSchema });

/** One custom product page with each version's state, deep link and localizations. */
export async function getCustomPage(
  client: AscClient,
  input: z.output<typeof customPageInput>,
) {
  const { data: page } = await client.get<{
    data: AscResource<PageAttributes>;
  }>(`/v1/appCustomProductPages/${input.pageId}`, {
    "fields[appCustomProductPages]": ["name", "url", "visible"],
  });
  // A page keeps only a few versions, far fewer than one page of 200.
  const response = await client.get<AscDocument<PageVersionAttributes>>(
    `/v1/appCustomProductPages/${input.pageId}/appCustomProductPageVersions`,
    {
      "fields[appCustomProductPageVersions]": ["version", "state", "deepLink"],
      limit: 200,
    },
  );
  const versions = [];
  for (const { id, attributes } of response.data) {
    const localizations = await listLocalizations(client, id);
    versions.push({
      id,
      version: attributes?.version,
      state: attributes?.state,
      deepLink: attributes?.deepLink ?? null,
      localizations: localizations.data.map((localization) => ({
        id: localization.id,
        locale: localization.attributes?.locale,
        promotionalText: localization.attributes?.promotionalText ?? null,
      })),
    });
  }
  return { page: shapePage(page), versions };
}

const promotionalTextSchema = z.string().trim().min(1).optional();
const deepLinkSchema = z.url().optional();

export const createCustomPageInput = z.object({
  appId: appIdSchema,
  name: z
    .string({ error: "Give the page's name with --name." })
    .trim()
    .min(1, "Give the page's name with --name."),
  locale: localeSchema,
  promotionalText: promotionalTextSchema,
  deepLink: deepLinkSchema,
  yes: z.boolean().default(false),
});

/**
 * Creates a custom product page with its first version and one locale.
 * Without `yes`, shows the page it would create and how many the app has.
 */
export async function createCustomPage(
  client: AscClient,
  input: z.output<typeof createCustomPageInput>,
) {
  const page = {
    name: input.name,
    locale: input.locale,
    promotionalText: input.promotionalText ?? null,
    deepLink: input.deepLink ?? null,
  };
  if (!input.yes) {
    const existing = await client.get<AscDocument<PageAttributes>>(
      `/v1/apps/${input.appId}/appCustomProductPages`,
      { "fields[appCustomProductPages]": ["name"], limit: 1 },
    );
    return {
      dryRun: true,
      action: "create",
      appId: input.appId,
      page,
      existingPages: existing.meta?.paging?.total,
    };
  }
  // Inline-created resources take a local id that the request's own relationships refer to.
  const versionRef = {
    type: "appCustomProductPageVersions",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Apple's own local id form, not a template.
    id: "${new-appCustomProductPageVersion-id}",
  };
  const localizationRef = {
    type: "appCustomProductPageLocalizations",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Apple's own local id form, not a template.
    id: "${new-appCustomProductPageLocalization-id}",
  };
  const created = await client
    .post<{
      data: AscResource<PageAttributes> & {
        relationships?: {
          appCustomProductPageVersions?: { data?: { id: string }[] };
        };
      };
    }>("/v1/appCustomProductPages", {
      data: {
        type: "appCustomProductPages",
        attributes: { name: input.name },
        relationships: {
          app: { data: { type: "apps", id: input.appId } },
          appCustomProductPageVersions: { data: [versionRef] },
        },
      },
      included: [
        {
          ...versionRef,
          ...(input.deepLink === undefined
            ? {}
            : { attributes: { deepLink: input.deepLink } }),
          relationships: {
            appCustomProductPageLocalizations: { data: [localizationRef] },
          },
        },
        {
          ...localizationRef,
          attributes: {
            locale: input.locale,
            ...(input.promotionalText === undefined
              ? {}
              : { promotionalText: input.promotionalText }),
          },
        },
      ],
    })
    .catch((error: unknown) => {
      // Apple lists 409 and 422 for this request; an app at its page limit is the likely cause.
      if (
        error instanceof AscApiError &&
        (error.status === 409 || error.status === 422)
      ) {
        throw new InvalidInputError(
          `App ${input.appId} may have reached Apple's limit of custom product pages; reuse one with custom-pages set or remove one in App Store Connect. ${classifyError(error).message}`,
          { cause: error },
        );
      }
      throw error;
    });
  return {
    dryRun: false,
    action: "create",
    page: shapePage(created.data),
    versionId:
      created.data.relationships?.appCustomProductPageVersions?.data?.[0]?.id,
  };
}

export const setCustomPageInput = z
  .object({
    versionId: pageVersionIdSchema,
    locale: localeSchema.optional(),
    promotionalText: promotionalTextSchema,
    deepLink: deepLinkSchema,
    yes: z.boolean().default(false),
  })
  .refine(
    (input) =>
      input.promotionalText !== undefined || input.deepLink !== undefined,
    { message: "Give --promotional-text, --deep-link or both." },
  )
  .refine((input) => input.promotionalText === undefined || input.locale, {
    message: "Give the locale of the promotional text with --locale.",
    path: ["locale"],
  });

/**
 * Sets a page version's deep link, a locale's promotional text, or both, on
 * a version being prepared or rejected. Without `yes`, shows the current and
 * new values.
 */
export async function setCustomPage(
  client: AscClient,
  input: z.output<typeof setCustomPageInput>,
) {
  const version = await readPageVersion(client, input.versionId);
  editable(version, "deep link and promotional text");
  let localization: AscResource<PageLocalizationAttributes> | undefined;
  if (input.promotionalText !== undefined) {
    localization = (
      await listLocalizations(client, input.versionId, input.locale)
    ).data[0];
    if (!localization) {
      throw new NotFoundError(
        `Version ${version.version} of custom product page ${version.page} has no ${input.locale} localization; custom-pages show lists its locales.`,
      );
    }
  }
  const current: { deepLink?: string | null; promotionalText?: string | null } =
    {};
  const update: { deepLink?: string; promotionalText?: string } = {};
  if (input.deepLink !== undefined) {
    current.deepLink = version.deepLink;
    update.deepLink = input.deepLink;
  }
  if (input.promotionalText !== undefined) {
    current.promotionalText = localization?.attributes?.promotionalText ?? null;
    update.promotionalText = input.promotionalText;
  }
  const changed = (["deepLink", "promotionalText"] as const).filter(
    (field) => update[field] !== undefined && current[field] !== update[field],
  );
  if (!input.yes) {
    return {
      dryRun: true,
      action: "set",
      version,
      locale: input.locale,
      current,
      update,
      changes: changed.length > 0,
    };
  }
  if (changed.includes("deepLink")) {
    await client.patch(`/v1/appCustomProductPageVersions/${input.versionId}`, {
      data: {
        type: "appCustomProductPageVersions",
        id: input.versionId,
        attributes: { deepLink: update.deepLink },
      },
    });
  }
  if (localization && changed.includes("promotionalText")) {
    await client.patch(
      `/v1/appCustomProductPageLocalizations/${localization.id}`,
      {
        data: {
          type: "appCustomProductPageLocalizations",
          id: localization.id,
          attributes: { promotionalText: update.promotionalText },
        },
      },
    );
  }
  return {
    dryRun: false,
    action: "set",
    versionId: input.versionId,
    locale: input.locale,
    changed,
  };
}

export const uploadCustomPageInput = z.object({
  versionId: pageVersionIdSchema,
  dir: z
    .string({ error: "Give the folder to upload with --dir." })
    .trim()
    .min(1, "Give the folder to upload with --dir."),
  yes: z.boolean().default(false),
});

/**
 * Uploads a folder of screenshots and app previews to a page version, the
 * same way `screenshots upload` does for an App Store version. Without
 * `yes`, shows where each file would go.
 */
export async function uploadCustomPageScreenshots(
  client: AscClient,
  input: z.output<typeof uploadCustomPageInput>,
) {
  const version = await readPageVersion(client, input.versionId);
  editable(version, "screenshots and previews");
  const localizations = await listLocalizations(client, input.versionId);
  const target = {
    localizationType: "appCustomProductPageLocalizations",
    relationship: "appCustomProductPageLocalization",
    // Assumption: the ref data feature for custom product pages is not documented.
    feature: "CUSTOM_PRODUCT_PAGES",
    label: `Version ${version.version} of custom product page ${version.page}`,
    localesCommand: "custom-pages show",
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
      version,
      files: showPlanned(files),
      skipped,
    };
  }
  const appId = await pageAppId(client, version.pageId);
  return {
    dryRun: false,
    action: "upload",
    versionId: input.versionId,
    uploaded: await placeFiles(client, appId, target, files),
    skipped,
  };
}

export const submitCustomPageInput = z.object({
  versionId: pageVersionIdSchema,
  platform: z.enum(PLATFORMS).default("IOS"),
  yes: z.boolean().default(false),
});

/**
 * The app's review submission being prepared for the platform, with the page
 * versions in it and how many other items it holds.
 */
async function draftSubmission(
  client: AscClient,
  appId: string,
  platform: string,
) {
  const drafts = await client.get<AscDocument<unknown>>(
    "/v1/reviewSubmissions",
    {
      "filter[app]": appId,
      "filter[platform]": platform,
      "filter[state]": "READY_FOR_REVIEW",
      "fields[reviewSubmissions]": ["platform", "state"],
      limit: 1,
    },
  );
  const draft = drafts.data[0];
  if (!draft) return undefined;
  const items = await client.get<AscDocument<unknown>>(
    `/v1/reviewSubmissions/${draft.id}/items`,
    {
      "fields[reviewSubmissionItems]": ["state", "appCustomProductPageVersion"],
      limit: 200,
    },
  );
  const pageVersions = items.data.flatMap(
    (item) => item.relationships?.appCustomProductPageVersion?.data?.id ?? [],
  );
  return {
    id: draft.id,
    pageVersions,
    otherItems: items.data.length - pageVersions.length,
  };
}

/**
 * Submits a page version for App Review on its own: it goes into a new
 * review submission, or one being prepared that holds nothing else. Without
 * `yes`, shows the version and the submission it would use.
 */
export async function submitCustomPage(
  client: AscClient,
  input: z.output<typeof submitCustomPageInput>,
) {
  const version = await readPageVersion(client, input.versionId);
  if (!SUBMITTABLE_STATES.has(version.state ?? "")) {
    throw new NotEditableError(
      `Version ${version.version} of custom product page ${version.page} is ${version.state}, so it cannot be submitted for review. Submit a page version that is PREPARE_FOR_SUBMISSION or REJECTED.`,
    );
  }
  const appId = await pageAppId(client, version.pageId);
  const draft = await draftSubmission(client, appId, input.platform);
  const others = draft
    ? draft.otherItems +
      draft.pageVersions.filter((id) => id !== input.versionId).length
    : 0;
  if (draft && others > 0) {
    throw new InvalidInputError(
      `The app's ${input.platform} review submission ${draft.id} is being prepared with ${others} other item(s), which submitting would send for review too. Submit or remove them in App Store Connect first.`,
    );
  }
  const alreadyAdded = draft?.pageVersions.includes(input.versionId) === true;
  if (!input.yes) {
    return {
      dryRun: true,
      action: "submit",
      version,
      platform: input.platform,
      reviewSubmissionId: draft?.id ?? null,
    };
  }
  let submissionId = draft?.id;
  if (!submissionId) {
    const created = await client.post<{ data: AscResource }>(
      "/v1/reviewSubmissions",
      {
        data: {
          type: "reviewSubmissions",
          attributes: { platform: input.platform },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      },
    );
    submissionId = created.data.id;
  }
  if (!alreadyAdded) {
    await client.post("/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: {
            data: { type: "reviewSubmissions", id: submissionId },
          },
          appCustomProductPageVersion: {
            data: { type: "appCustomProductPageVersions", id: input.versionId },
          },
        },
      },
    });
  }
  const submitted = await client.patch<{
    data: AscResource<{ state?: string }>;
  }>(`/v1/reviewSubmissions/${submissionId}`, {
    data: {
      type: "reviewSubmissions",
      id: submissionId,
      attributes: { submitted: true },
    },
  });
  return {
    dryRun: false,
    action: "submit",
    versionId: input.versionId,
    reviewSubmissionId: submissionId,
    state: submitted?.data?.attributes?.state,
  };
}
