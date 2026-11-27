import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import * as z from "zod";
import type {
  AscClient,
  AscDocument,
  AscResource,
  UploadOperation,
} from "../asc/client.ts";
import { appIdSchema, idSchema, localeSchema } from "../schemas/common.ts";
import {
  AscApiError,
  InvalidInputError,
  NotFoundError,
  UnexpectedResponseError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import { md5, sendParts } from "./build-upload.ts";

/**
 * App Clips: each App Clip has default experiences (the App Clip card's
 * action, and per locale a subtitle and header image), their App Review
 * details (the invocation URLs App Review opens), and advanced experiences
 * tied to a URL or a place. Header images are not part of the App Asset
 * Library, so they use their own reserve, send parts and commit resources.
 */

const experienceIdSchema = idSchema("app-clips");
const appClipIdSchema = idSchema("app-clips");

export const ACTIONS = ["OPEN", "VIEW", "PLAY"] as const;

export const LANGUAGES = [
  "AR",
  "CA",
  "CS",
  "DA",
  "DE",
  "EL",
  "EN",
  "ES",
  "FI",
  "FR",
  "HE",
  "HI",
  "HR",
  "HU",
  "ID",
  "IT",
  "JA",
  "KO",
  "MS",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "RU",
  "SK",
  "SV",
  "TH",
  "TR",
  "UK",
  "VI",
  "ZH",
] as const;

export const BUSINESS_CATEGORIES = [
  "AUTOMOTIVE",
  "BEAUTY",
  "BIKES",
  "BOOKS",
  "CASINO",
  "EDUCATION",
  "EDUCATION_JAPAN",
  "ENTERTAINMENT",
  "EV_CHARGER",
  "FINANCIAL_USD",
  "FINANCIAL_CNY",
  "FINANCIAL_GBP",
  "FINANCIAL_JPY",
  "FINANCIAL_EUR",
  "FITNESS",
  "FOOD_AND_DRINK",
  "GAS",
  "GROCERY",
  "HEALTH_AND_MEDICAL",
  "HOTEL_AND_TRAVEL",
  "MUSIC",
  "PARKING",
  "PET_SERVICES",
  "PROFESSIONAL_SERVICES",
  "SHOPPING",
  "TICKETING",
  "TRANSIT",
] as const;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

interface ImageAttributes {
  fileName?: string;
  fileSize?: number;
  assetDeliveryState?: {
    state?: string;
    errors?: { code?: string; description?: string }[] | null;
  } | null;
  uploadOperations?: UploadOperation[] | null;
}

interface DefaultExperienceAttributes {
  action?: string | null;
}

interface DefaultLocalizationAttributes {
  locale?: string;
  subtitle?: string | null;
}

interface AdvancedExperienceAttributes {
  link?: string;
  version?: number;
  action?: string | null;
  isPoweredBy?: boolean;
  status?: string;
  placeStatus?: string | null;
  businessCategory?: string | null;
  defaultLanguage?: string;
  place?: { names?: string[] | null } | null;
}

interface AdvancedLocalizationAttributes {
  language?: string;
  title?: string | null;
  subtitle?: string | null;
}

function shapeImage(image?: AscResource<ImageAttributes>) {
  if (!image) return null;
  return {
    id: image.id,
    fileName: image.attributes?.fileName,
    state: image.attributes?.assetDeliveryState?.state ?? null,
    errors: (image.attributes?.assetDeliveryState?.errors ?? []).map(
      ({ code, description }) => ({ code, description }),
    ),
  };
}

/** Every resource of a to-many relationship found in `included`. */
function includedMany<Attributes>(
  document: Pick<AscDocument<unknown>, "included">,
  resource: AscResource<unknown>,
  relationship: string,
): AscResource<Attributes>[] {
  const refs = (
    resource.relationships?.[relationship] as
      | { data?: { type: string; id: string }[] }
      | undefined
  )?.data;
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((ref) => {
    const found = document.included?.find(
      (item) => item.type === ref.type && item.id === ref.id,
    );
    return found ? [found as AscResource<Attributes>] : [];
  });
}

function includedOne<Attributes>(
  document: Pick<AscDocument<unknown>, "included">,
  resource: AscResource<unknown>,
  relationship: string,
): AscResource<Attributes> | undefined {
  const ref = resource.relationships?.[relationship]?.data;
  if (!ref) return undefined;
  return document.included?.find(
    (item) => item.type === ref.type && item.id === ref.id,
  ) as AscResource<Attributes> | undefined;
}

/** A localization's header image, or undefined when it has none. */
async function readHeaderImage(client: AscClient, localizationId: string) {
  try {
    const { data } = await client.get<{
      data: AscResource<ImageAttributes> | null;
    }>(
      `/v1/appClipDefaultExperienceLocalizations/${localizationId}/appClipHeaderImage`,
      {
        "fields[appClipHeaderImages]": [
          "fileName",
          "fileSize",
          "assetDeliveryState",
        ],
      },
    );
    return data ?? undefined;
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) return undefined;
    throw error;
  }
}

const DEFAULT_EXPERIENCE_QUERY = {
  "fields[appClipDefaultExperiences]": [
    "action",
    "releaseWithAppStoreVersion",
    "appClipDefaultExperienceLocalizations",
    "appClipAppStoreReviewDetail",
  ],
  "fields[appClipDefaultExperienceLocalizations]": ["locale", "subtitle"],
  "fields[appClipAppStoreReviewDetails]": ["invocationUrls"],
  "fields[appStoreVersions]": ["versionString", "appStoreState"],
  include: [
    "appClipDefaultExperienceLocalizations",
    "appClipAppStoreReviewDetail",
    "releaseWithAppStoreVersion",
  ],
};

/** A default experience with its locales, header images and review detail. */
async function shapeDefaultExperience(
  client: AscClient,
  document: Pick<AscDocument<unknown>, "included">,
  experience: AscResource<DefaultExperienceAttributes>,
) {
  const localizations = [];
  for (const localization of includedMany<DefaultLocalizationAttributes>(
    document,
    experience,
    "appClipDefaultExperienceLocalizations",
  )) {
    localizations.push({
      id: localization.id,
      locale: localization.attributes?.locale,
      subtitle: localization.attributes?.subtitle ?? null,
      headerImage: shapeImage(await readHeaderImage(client, localization.id)),
    });
  }
  const review = includedOne<{ invocationUrls?: string[] | null }>(
    document,
    experience,
    "appClipAppStoreReviewDetail",
  );
  const version = includedOne<{
    versionString?: string;
    appStoreState?: string;
  }>(document, experience, "releaseWithAppStoreVersion");
  return {
    id: experience.id,
    action: experience.attributes?.action ?? null,
    releaseWithVersion: version
      ? {
          id: version.id,
          version: version.attributes?.versionString,
          state: version.attributes?.appStoreState,
        }
      : null,
    localizations,
    reviewDetail: review
      ? {
          id: review.id,
          invocationUrls: review.attributes?.invocationUrls ?? [],
        }
      : null,
  };
}
type DefaultExperience = Awaited<ReturnType<typeof shapeDefaultExperience>>;

function shapeAdvancedExperience(
  document: Pick<AscDocument<unknown>, "included">,
  experience: AscResource<AdvancedExperienceAttributes>,
) {
  const a = experience.attributes;
  return {
    id: experience.id,
    link: a?.link,
    status: a?.status,
    placeStatus: a?.placeStatus ?? null,
    action: a?.action ?? null,
    businessCategory: a?.businessCategory ?? null,
    defaultLanguage: a?.defaultLanguage,
    isPoweredBy: a?.isPoweredBy ?? false,
    place: a?.place?.names?.[0] ?? null,
    localizations: includedMany<AdvancedLocalizationAttributes>(
      document,
      experience,
      "localizations",
    ).map(({ attributes }) => ({
      language: attributes?.language,
      title: attributes?.title ?? null,
      subtitle: attributes?.subtitle ?? null,
    })),
    headerImage: shapeImage(
      includedOne<ImageAttributes>(document, experience, "headerImage"),
    ),
  };
}

const ADVANCED_QUERY = {
  "fields[appClipAdvancedExperiences]": [
    "link",
    "version",
    "action",
    "isPoweredBy",
    "status",
    "placeStatus",
    "businessCategory",
    "defaultLanguage",
    "place",
    "headerImage",
    "localizations",
  ],
  "fields[appClipAdvancedExperienceImages]": ["fileName", "assetDeliveryState"],
  include: ["headerImage", "localizations"],
};

export const appClipsInput = z.object({ appId: appIdSchema });

/** An app's App Clips with their default and advanced experiences. */
export async function listAppClips(
  client: AscClient,
  input: z.output<typeof appClipsInput>,
) {
  const clips = await client.get<AscDocument<{ bundleId?: string }>>(
    `/v1/apps/${input.appId}/appClips`,
    { "fields[appClips]": ["bundleId"], limit: 200 },
  );
  const result = [];
  for (const clip of clips.data) {
    const defaults = await client.get<AscDocument<DefaultExperienceAttributes>>(
      `/v1/appClips/${clip.id}/appClipDefaultExperiences`,
      {
        ...DEFAULT_EXPERIENCE_QUERY,
        limit: 200,
      },
    );
    const defaultExperiences = [];
    for (const experience of defaults.data) {
      defaultExperiences.push(
        await shapeDefaultExperience(client, defaults, experience),
      );
    }
    const advanced = await client.get<
      AscDocument<AdvancedExperienceAttributes>
    >(`/v1/appClips/${clip.id}/appClipAdvancedExperiences`, {
      ...ADVANCED_QUERY,
      limit: 200,
    });
    result.push({
      id: clip.id,
      bundleId: clip.attributes?.bundleId,
      defaultExperiences,
      advancedExperiences: advanced.data.map((experience) =>
        shapeAdvancedExperience(advanced, experience),
      ),
    });
  }
  return { appClips: result };
}

async function readDefaultExperience(
  client: AscClient,
  experienceId: string,
): Promise<DefaultExperience> {
  const document = await client.get<{
    data: AscResource<DefaultExperienceAttributes>;
    included?: AscResource[];
  }>(`/v1/appClipDefaultExperiences/${experienceId}`, DEFAULT_EXPERIENCE_QUERY);
  return shapeDefaultExperience(client, document, document.data);
}

export const setDefaultInput = z
  .object({
    experienceId: experienceIdSchema,
    locale: localeSchema.optional(),
    subtitle: z.string().trim().min(1).max(56).optional(),
    action: z.enum(ACTIONS).optional(),
    yes: z.boolean().default(false),
  })
  .refine((input) => input.subtitle === undefined || input.locale, {
    message: "Give the locale of the subtitle with --locale.",
  })
  .refine((input) => input.subtitle !== undefined || input.action, {
    message: "Give --subtitle (with --locale) or --action.",
  });

/** Changes a default experience's action or one locale's subtitle, adding the locale when it has none. */
export async function setDefaultExperience(
  client: AscClient,
  input: z.output<typeof setDefaultInput>,
) {
  const experience = await readDefaultExperience(client, input.experienceId);
  const localization = experience.localizations.find(
    (item) => item.locale === input.locale,
  );
  const actionChanges =
    input.action !== undefined && input.action !== experience.action;
  const subtitleChanges =
    input.subtitle !== undefined && localization?.subtitle !== input.subtitle;
  if (!input.yes) {
    return {
      dryRun: true,
      action: "set",
      experience,
      update: {
        ...(input.action ? { action: input.action } : {}),
        ...(input.subtitle !== undefined
          ? { locale: input.locale, subtitle: input.subtitle }
          : {}),
      },
      newLocale: input.subtitle !== undefined && !localization,
      changes: actionChanges || subtitleChanges,
    };
  }
  const changed: string[] = [];
  if (actionChanges) {
    await client.patch(`/v1/appClipDefaultExperiences/${input.experienceId}`, {
      data: {
        type: "appClipDefaultExperiences",
        id: input.experienceId,
        attributes: { action: input.action },
      },
    });
    changed.push("action");
  }
  if (subtitleChanges) {
    if (localization) {
      await client.patch(
        `/v1/appClipDefaultExperienceLocalizations/${localization.id}`,
        {
          data: {
            type: "appClipDefaultExperienceLocalizations",
            id: localization.id,
            attributes: { subtitle: input.subtitle },
          },
        },
      );
    } else {
      await client.post("/v1/appClipDefaultExperienceLocalizations", {
        data: {
          type: "appClipDefaultExperienceLocalizations",
          attributes: { locale: input.locale, subtitle: input.subtitle },
          relationships: {
            appClipDefaultExperience: {
              data: {
                type: "appClipDefaultExperiences",
                id: input.experienceId,
              },
            },
          },
        },
      });
    }
    changed.push("subtitle");
  }
  return {
    dryRun: false,
    action: "set",
    experienceId: input.experienceId,
    locale: input.locale,
    changed,
  };
}

/** An image to upload: a non-empty PNG or JPEG. */
async function readImage(path: string) {
  if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw new InvalidInputError(
      `${basename(path)} is not a PNG or JPEG image.`,
    );
  }
  let fileSize: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    fileSize = info.size;
  } catch {
    throw new NotFoundError(`Could not read the file ${path}.`);
  }
  if (fileSize === 0)
    throw new InvalidInputError(`${basename(path)} is empty.`);
  return { path, fileName: basename(path), fileSize };
}

/** Reserves an image, sends the parts Apple lists and commits it with its MD5. */
async function uploadImage(
  client: AscClient,
  type: "appClipHeaderImages" | "appClipAdvancedExperienceImages",
  image: Awaited<ReturnType<typeof readImage>>,
  relationships?: Record<string, unknown>,
) {
  const checksum = await md5(image.path);
  const { data: reserved } = await client.post<{
    data: AscResource<ImageAttributes>;
  }>(`/v1/${type}`, {
    data: {
      type,
      attributes: { fileName: image.fileName, fileSize: image.fileSize },
      ...(relationships ? { relationships } : {}),
    },
  });
  try {
    const operations = reserved.attributes?.uploadOperations ?? [];
    if (operations.length === 0) {
      throw new UnexpectedResponseError(
        "App Store Connect reserved the image but gave no upload operations.",
      );
    }
    await sendParts(client, image.path, image.fileSize, operations);
    await client.patch(`/v1/${type}/${reserved.id}`, {
      data: {
        type,
        id: reserved.id,
        attributes: { uploaded: true, sourceFileChecksum: checksum },
      },
    });
  } catch (error) {
    throw new UploadIncompleteError(
      `The image ${reserved.id} was reserved but not committed; run the command again.`,
      { cause: error },
    );
  }
  return reserved.id;
}

export const headerImageInput = z.object({
  experienceId: experienceIdSchema,
  locale: localeSchema,
  file: z
    .string({ error: "Give the image with --file." })
    .trim()
    .min(1, "Give the image with --file."),
  yes: z.boolean().default(false),
});

/** Uploads one locale's App Clip card header image, replacing the one it has. */
export async function uploadHeaderImage(
  client: AscClient,
  input: z.output<typeof headerImageInput>,
) {
  const image = await readImage(input.file);
  const experience = await readDefaultExperience(client, input.experienceId);
  const localization = experience.localizations.find(
    (item) => item.locale === input.locale,
  );
  if (!localization) {
    throw new NotFoundError(
      `The default experience has no ${input.locale} localization; add it with app-clips default set --locale ${input.locale} --subtitle <text>.`,
    );
  }
  const planned = {
    experienceId: input.experienceId,
    locale: input.locale,
    file: { fileName: image.fileName, fileSize: image.fileSize },
    replaces: localization.headerImage,
  };
  if (!input.yes) return { dryRun: true, action: "upload", ...planned };
  // Apple keeps one header image per localization, so the old one goes first.
  if (localization.headerImage) {
    await client.delete(
      `/v1/appClipHeaderImages/${localization.headerImage.id}`,
    );
  }
  const imageId = await uploadImage(client, "appClipHeaderImages", image, {
    appClipDefaultExperienceLocalization: {
      data: {
        type: "appClipDefaultExperienceLocalizations",
        id: localization.id,
      },
    },
  });
  return { dryRun: false, action: "upload", ...planned, imageId };
}

export const reviewDetailInput = z.object({
  experienceId: experienceIdSchema,
  invocationUrls: z
    .array(z.url({ error: "Each --invocation-url must be a full URL." }))
    .min(1, "Give at least one --invocation-url."),
  yes: z.boolean().default(false),
});

/** Sets the invocation URLs App Review uses to open a default experience. */
export async function setReviewDetail(
  client: AscClient,
  input: z.output<typeof reviewDetailInput>,
) {
  const experience = await readDefaultExperience(client, input.experienceId);
  const current = experience.reviewDetail;
  if (!input.yes) {
    return {
      dryRun: true,
      action: "set",
      experienceId: input.experienceId,
      current: current?.invocationUrls ?? null,
      invocationUrls: input.invocationUrls,
    };
  }
  if (current) {
    await client.patch(`/v1/appClipAppStoreReviewDetails/${current.id}`, {
      data: {
        type: "appClipAppStoreReviewDetails",
        id: current.id,
        attributes: { invocationUrls: input.invocationUrls },
      },
    });
  } else {
    await client.post("/v1/appClipAppStoreReviewDetails", {
      data: {
        type: "appClipAppStoreReviewDetails",
        attributes: { invocationUrls: input.invocationUrls },
        relationships: {
          appClipDefaultExperience: {
            data: { type: "appClipDefaultExperiences", id: input.experienceId },
          },
        },
      },
    });
  }
  return {
    dryRun: false,
    action: "set",
    experienceId: input.experienceId,
    invocationUrls: input.invocationUrls,
  };
}

const flag = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

export const createAdvancedInput = z.object({
  appClipId: appClipIdSchema,
  link: z.url({ error: "Give the experience's URL with --link." }),
  defaultLanguage: z.enum(LANGUAGES, {
    error: "Give --default-language, such as EN.",
  }),
  title: z
    .string({ error: "Give the card's title with --title." })
    .trim()
    .min(1)
    .max(30),
  subtitle: z
    .string({ error: "Give the card's subtitle with --subtitle." })
    .trim()
    .min(1)
    .max(56),
  image: z
    .string({ error: "Give the card's header image with --image." })
    .trim()
    .min(1, "Give the card's header image with --image."),
  action: z.enum(ACTIONS).optional(),
  businessCategory: z.enum(BUSINESS_CATEGORIES).optional(),
  poweredBy: flag.default(false),
  yes: z.boolean().default(false),
});

/** Creates an advanced experience for a URL, with its header image and one localization in its default language. */
export async function createAdvancedExperience(
  client: AscClient,
  input: z.output<typeof createAdvancedInput>,
) {
  const image = await readImage(input.image);
  const { data: clip } = await client.get<{
    data: AscResource<{ bundleId?: string }>;
  }>(`/v1/appClips/${input.appClipId}`, { "fields[appClips]": ["bundleId"] });
  const attributes = {
    link: input.link,
    defaultLanguage: input.defaultLanguage,
    isPoweredBy: input.poweredBy,
    ...(input.action ? { action: input.action } : {}),
    ...(input.businessCategory
      ? { businessCategory: input.businessCategory }
      : {}),
  };
  const localization = {
    language: input.defaultLanguage,
    title: input.title,
    subtitle: input.subtitle,
  };
  const planned = {
    appClip: { id: clip.id, bundleId: clip.attributes?.bundleId },
    experience: attributes,
    localization,
    image: { fileName: image.fileName, fileSize: image.fileSize },
  };
  if (!input.yes) return { dryRun: true, action: "create", ...planned };

  // Apple's advanced experience images have no parent; the experience points at one.
  const imageId = await uploadImage(
    client,
    "appClipAdvancedExperienceImages",
    image,
  );
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Apple's own local id form, not a template.
  const localId = "${new-appClipAdvancedExperienceLocalization-id}";
  try {
    const { data } = await client.post<{
      data: AscResource<AdvancedExperienceAttributes>;
    }>("/v1/appClipAdvancedExperiences", {
      data: {
        type: "appClipAdvancedExperiences",
        attributes,
        relationships: {
          appClip: { data: { type: "appClips", id: input.appClipId } },
          headerImage: {
            data: { type: "appClipAdvancedExperienceImages", id: imageId },
          },
          localizations: {
            data: [
              { type: "appClipAdvancedExperienceLocalizations", id: localId },
            ],
          },
        },
      },
      included: [
        {
          type: "appClipAdvancedExperienceLocalizations",
          id: localId,
          attributes: localization,
        },
      ],
    });
    return {
      dryRun: false,
      action: "create",
      ...planned,
      experienceId: data.id,
      status: data.attributes?.status,
    };
  } catch (error) {
    throw new UploadIncompleteError(
      `The header image ${imageId} was uploaded but the experience was not created.`,
      { cause: error },
    );
  }
}

async function readAdvancedExperience(client: AscClient, experienceId: string) {
  const document = await client.get<{
    data: AscResource<AdvancedExperienceAttributes>;
    included?: AscResource[];
  }>(`/v1/appClipAdvancedExperiences/${experienceId}`, ADVANCED_QUERY);
  return shapeAdvancedExperience(document, document.data);
}

export const setAdvancedInput = z.object({
  experienceId: experienceIdSchema,
  action: z.enum(ACTIONS).optional(),
  businessCategory: z.enum(BUSINESS_CATEGORIES).optional(),
  defaultLanguage: z.enum(LANGUAGES).optional(),
  poweredBy: flag.optional(),
  yes: z.boolean().default(false),
});

/** Changes an advanced experience's action, business category, default language or "powered by" flag. */
export async function setAdvancedExperience(
  client: AscClient,
  input: z.output<typeof setAdvancedInput>,
) {
  const experience = await readAdvancedExperience(client, input.experienceId);
  const update: Record<string, unknown> = {};
  if (input.action !== undefined) update.action = input.action;
  if (input.businessCategory !== undefined) {
    update.businessCategory = input.businessCategory;
  }
  if (input.defaultLanguage !== undefined) {
    update.defaultLanguage = input.defaultLanguage;
  }
  if (input.poweredBy !== undefined) update.isPoweredBy = input.poweredBy;
  if (Object.keys(update).length === 0) {
    throw new InvalidInputError(
      "Give at least one of --action, --business-category, --default-language or --powered-by.",
    );
  }
  const changed = Object.keys(update).filter(
    (field) => experience[field as keyof typeof experience] !== update[field],
  );
  if (!input.yes) {
    return {
      dryRun: true,
      action: "set",
      experience,
      update,
      changes: changed.length > 0,
    };
  }
  if (changed.length > 0) {
    await client.patch(`/v1/appClipAdvancedExperiences/${input.experienceId}`, {
      data: {
        type: "appClipAdvancedExperiences",
        id: input.experienceId,
        attributes: Object.fromEntries(
          changed.map((field) => [field, update[field]]),
        ),
      },
    });
  }
  return {
    dryRun: false,
    action: "set",
    experienceId: input.experienceId,
    changed,
  };
}

export const removeAdvancedInput = z.object({
  experienceId: experienceIdSchema,
  yes: z.boolean().default(false),
});

/** Removes an advanced experience; Apple has no DELETE for them, so it is marked removed. */
export async function removeAdvancedExperience(
  client: AscClient,
  input: z.output<typeof removeAdvancedInput>,
) {
  const experience = await readAdvancedExperience(client, input.experienceId);
  if (!input.yes) return { dryRun: true, action: "remove", experience };
  await client.patch(`/v1/appClipAdvancedExperiences/${input.experienceId}`, {
    data: {
      type: "appClipAdvancedExperiences",
      id: input.experienceId,
      attributes: { removed: true },
    },
  });
  return {
    dryRun: false,
    action: "remove",
    experienceId: input.experienceId,
    link: experience.link,
  };
}
