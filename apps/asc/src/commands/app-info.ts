import * as z from "zod";
import type { AscClient, AscDocument, AscResource } from "../asc/client.ts";
import { appIdSchema, idSchema, localeSchema } from "../schemas/common.ts";
import { NotEditableError, NotFoundError } from "../utils/errors.ts";

const appInfoIdSchema = idSchema("app-info");

/** The app info localisation fields the update request accepts. */
const FIELDS = [
  "name",
  "subtitle",
  "privacyPolicyUrl",
  "privacyChoicesUrl",
  "privacyPolicyText",
] as const;

type Field = (typeof FIELDS)[number];

type LocalizationAttributes = { locale?: string } & {
  [K in Field]?: string | null;
};

const CATEGORIES = [
  "primaryCategory",
  "primarySubcategoryOne",
  "primarySubcategoryTwo",
  "secondaryCategory",
  "secondarySubcategoryOne",
  "secondarySubcategoryTwo",
] as const;

interface AppInfoAttributes {
  state?: string;
  appStoreAgeRating?: string | null;
}

/**
 * App info `state` values that still accept changes.
 *
 * Assumption: Apple's API docs do not say which states accept a PATCH to
 * appInfoLocalizations; this list follows App Store Connect's behaviour and
 * is unverified against the API.
 */
export const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
]);

function listLocalizations(
  client: AscClient,
  appInfoId: string,
  query: Record<string, string | number>,
) {
  return client.get<AscDocument<LocalizationAttributes>>(
    `/v1/appInfos/${appInfoId}/appInfoLocalizations`,
    { "fields[appInfoLocalizations]": ["locale", ...FIELDS], ...query },
  );
}

export const appInfoInput = z.object({ appId: appIdSchema });

/**
 * An app's app infos (usually the live one and, while a version is being
 * prepared, an editable one): state, age rating, category IDs and every
 * locale's name, subtitle and privacy links.
 */
export async function getAppInfo(
  client: AscClient,
  input: z.output<typeof appInfoInput>,
) {
  const response = await client.get<AscDocument<AppInfoAttributes>>(
    `/v1/apps/${input.appId}/appInfos`,
    {
      // Relationship IDs come back only for included relationships.
      include: CATEGORIES,
      "fields[appInfos]": ["state", "appStoreAgeRating", ...CATEGORIES],
      "fields[appCategories]": "platforms",
      limit: 200,
    },
  );
  const appInfos = [];
  for (const appInfo of response.data) {
    const localizations = await listLocalizations(client, appInfo.id, {
      limit: 200,
    });
    appInfos.push({
      id: appInfo.id,
      state: appInfo.attributes?.state,
      appStoreAgeRating: appInfo.attributes?.appStoreAgeRating,
      categories: Object.fromEntries(
        CATEGORIES.map((name) => [
          name,
          appInfo.relationships?.[name]?.data?.id ?? null,
        ]),
      ),
      localizations: localizations.data.map(({ id, attributes }) => ({
        id,
        locale: attributes?.locale,
        name: attributes?.name,
        subtitle: attributes?.subtitle,
        privacyPolicyUrl: attributes?.privacyPolicyUrl,
        privacyChoicesUrl: attributes?.privacyChoicesUrl,
        privacyPolicyText: attributes?.privacyPolicyText,
      })),
    });
  }
  return { appInfos };
}

const text = z.string().trim().optional();
const url = z.url({ protocol: /^https?$/ }).optional();

export const setAppInfoInput = z
  .object({
    appInfoId: appInfoIdSchema,
    locale: localeSchema,
    name: text,
    subtitle: text,
    privacyPolicyUrl: url,
    privacyChoicesUrl: url,
    privacyPolicyText: text,
    yes: z.boolean().default(false),
  })
  .refine((input) => FIELDS.some((field) => input[field] !== undefined), {
    message: "Give at least one field to change, such as --name or --subtitle.",
  });

/**
 * Updates one locale of an app info. Only an app info being prepared, or
 * rejected, accepts changes. Without `yes`, shows the current and new values.
 */
export async function setAppInfo(
  client: AscClient,
  input: z.output<typeof setAppInfoInput>,
) {
  const { data } = await client.get<{ data: AscResource<AppInfoAttributes> }>(
    `/v1/appInfos/${input.appInfoId}`,
    { "fields[appInfos]": ["state"] },
  );
  const state = data.attributes?.state;
  if (!EDITABLE_STATES.has(state ?? "")) {
    throw new NotEditableError(
      `App info ${input.appInfoId} is ${state}, so it can no longer be changed. Edit the app info that is PREPARE_FOR_SUBMISSION or rejected; the app-info command lists them.`,
    );
  }
  const existing = (
    await listLocalizations(client, input.appInfoId, {
      "filter[locale]": input.locale,
      limit: 1,
    })
  ).data[0];
  if (!existing) {
    throw new NotFoundError(
      `App info ${input.appInfoId} has no ${input.locale} localisation; the app-info command lists its locales.`,
    );
  }
  const given = FIELDS.filter((field) => input[field] !== undefined);
  const current: Partial<Record<Field, string | null>> = {};
  const update: Partial<Record<Field, string>> = {};
  for (const field of given) {
    current[field] = existing.attributes?.[field] ?? null;
    update[field] = input[field];
  }
  const changed = given.filter((field) => current[field] !== update[field]);
  if (!input.yes) {
    return {
      dryRun: true,
      action: "app-info",
      appInfo: { id: input.appInfoId, state },
      locale: input.locale,
      current,
      update,
      changes: changed.length > 0,
    };
  }
  if (changed.length > 0) {
    await client.patch(`/v1/appInfoLocalizations/${existing.id}`, {
      data: {
        type: "appInfoLocalizations",
        id: existing.id,
        attributes: Object.fromEntries(
          changed.map((field) => [field, update[field]]),
        ),
      },
    });
  }
  return {
    dryRun: false,
    action: "app-info",
    appInfoId: input.appInfoId,
    locale: input.locale,
    changed,
  };
}
