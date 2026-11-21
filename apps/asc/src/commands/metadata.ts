import * as z from "zod";
import type { AscClient, AscDocument, AscResource } from "../asc/client.ts";
import { idSchema, localeSchema } from "../schemas/common.ts";
import { NotEditableError, NotFoundError } from "../utils/errors.ts";

const versionIdSchema = idSchema("versions");

/** The version localisation fields the update request accepts. */
const FIELDS = [
  "description",
  "keywords",
  "promotionalText",
  "whatsNew",
  "supportUrl",
  "marketingUrl",
] as const;

type Field = (typeof FIELDS)[number];

type LocalizationAttributes = { locale?: string } & {
  [K in Field]?: string | null;
};

interface VersionAttributes {
  platform?: string;
  versionString?: string;
  appVersionState?: string;
}

/**
 * `appVersionState` values whose metadata can still be edited. Promotional
 * text can be changed in any state.
 *
 * Assumption: Apple's API docs do not say which states accept a PATCH to
 * appStoreVersionLocalizations; this list and the promotional text exception
 * follow App Store Connect's behaviour and are unverified against the API.
 */
const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);

/** The version as the metadata commands print it. */
async function readVersion(client: AscClient, versionId: string) {
  const { data } = await client.get<{ data: AscResource<VersionAttributes> }>(
    `/v1/appStoreVersions/${versionId}`,
    {
      "fields[appStoreVersions]": [
        "platform",
        "versionString",
        "appVersionState",
      ],
    },
  );
  return {
    id: data.id,
    version: data.attributes?.versionString,
    platform: data.attributes?.platform,
    state: data.attributes?.appVersionState,
  };
}

function listLocalizations(
  client: AscClient,
  versionId: string,
  query: Record<string, string | number>,
) {
  return client.get<AscDocument<LocalizationAttributes>>(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    {
      "fields[appStoreVersionLocalizations]": ["locale", ...FIELDS],
      ...query,
    },
  );
}

export const metadataInput = z.object({ versionId: versionIdSchema });

/** A version's App Store metadata in every locale it has. */
export async function getMetadata(
  client: AscClient,
  input: z.output<typeof metadataInput>,
) {
  const version = await readVersion(client, input.versionId);
  // An app has far fewer locales than the 200 one page holds.
  const response = await listLocalizations(client, input.versionId, {
    limit: 200,
  });
  return {
    version,
    localizations: response.data.map(({ id, attributes }) => ({
      id,
      locale: attributes?.locale,
      description: attributes?.description,
      keywords: attributes?.keywords,
      promotionalText: attributes?.promotionalText,
      whatsNew: attributes?.whatsNew,
      supportUrl: attributes?.supportUrl,
      marketingUrl: attributes?.marketingUrl,
    })),
  };
}

const text = z.string().trim().optional();
const url = z.url({ protocol: /^https?$/ }).optional();

export const setMetadataInput = z
  .object({
    versionId: versionIdSchema,
    locale: localeSchema,
    description: text,
    keywords: text,
    promotionalText: text,
    whatsNew: text,
    supportUrl: url,
    marketingUrl: url,
    yes: z.boolean().default(false),
  })
  .refine((input) => FIELDS.some((field) => input[field] !== undefined), {
    message:
      "Give at least one field to change, such as --description or --whats-new.",
  });

/**
 * Updates one locale of a version's metadata. Only versions still being
 * prepared, or rejected, accept changes, except promotional text. Without
 * `yes`, shows the current and new values.
 */
export async function setMetadata(
  client: AscClient,
  input: z.output<typeof setMetadataInput>,
) {
  const version = await readVersion(client, input.versionId);
  const given = FIELDS.filter((field) => input[field] !== undefined);
  if (
    !EDITABLE_STATES.has(version.state ?? "") &&
    given.some((field) => field !== "promotionalText")
  ) {
    throw new NotEditableError(
      `Version ${version.version} is ${version.state}, so its metadata can no longer be changed (only --promotional-text can). Edit a version that is PREPARE_FOR_SUBMISSION or rejected.`,
    );
  }
  const existing = (
    await listLocalizations(client, input.versionId, {
      "filter[locale]": input.locale,
      limit: 1,
    })
  ).data[0];
  if (!existing) {
    throw new NotFoundError(
      `Version ${version.version} has no ${input.locale} metadata; the metadata command lists its locales.`,
    );
  }
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
      action: "metadata",
      version,
      locale: input.locale,
      current,
      update,
      changes: changed.length > 0,
    };
  }
  if (changed.length > 0) {
    await client.patch(`/v1/appStoreVersionLocalizations/${existing.id}`, {
      data: {
        type: "appStoreVersionLocalizations",
        id: existing.id,
        attributes: Object.fromEntries(
          changed.map((field) => [field, update[field]]),
        ),
      },
    });
  }
  return {
    dryRun: false,
    action: "metadata",
    versionId: input.versionId,
    locale: input.locale,
    changed,
  };
}
