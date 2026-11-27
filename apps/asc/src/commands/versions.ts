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
  commaList,
  cursorSchema,
  idSchema,
  limitSchema,
  PLATFORMS,
} from "../schemas/common.ts";
import {
  InvalidInputError,
  NotEditableError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import { EDITABLE_STATES } from "./metadata.ts";

/** `AppVersionState` in the App Store Connect API 4.5 spec. */
const APP_VERSION_STATES = [
  "ACCEPTED",
  "DEVELOPER_REJECTED",
  "IN_REVIEW",
  "INVALID_BINARY",
  "METADATA_REJECTED",
  "PENDING_APPLE_RELEASE",
  "PENDING_DEVELOPER_RELEASE",
  "PREPARE_FOR_SUBMISSION",
  "PROCESSING_FOR_DISTRIBUTION",
  "READY_FOR_DISTRIBUTION",
  "READY_FOR_REVIEW",
  "REJECTED",
  "REPLACED_WITH_NEW_VERSION",
  "WAITING_FOR_EXPORT_COMPLIANCE",
  "WAITING_FOR_REVIEW",
] as const;

interface VersionAttributes {
  platform?: string;
  versionString?: string;
  appVersionState?: string;
  appStoreState?: string;
  releaseType?: string;
  earliestReleaseDate?: string | null;
  createdDate?: string;
}

export const versionsInput = z.object({
  appId: appIdSchema,
  platform: z.enum(PLATFORMS).optional(),
  state: commaList(z.enum(APP_VERSION_STATES)),
  limit: limitSchema,
  cursor: cursorSchema,
});

export async function listVersions(
  client: AscClient,
  input: z.output<typeof versionsInput>,
) {
  const response = await client.get<AscDocument<VersionAttributes>>(
    `/v1/apps/${input.appId}/appStoreVersions`,
    {
      "filter[platform]": input.platform,
      "filter[appVersionState]": input.state,
      include: "build",
      "fields[appStoreVersions]": [
        "platform",
        "versionString",
        "appVersionState",
        "appStoreState",
        "releaseType",
        "earliestReleaseDate",
        "createdDate",
        "build",
      ],
      "fields[builds]": "version",
      limit: input.limit,
      cursor: input.cursor,
    },
  );
  const versions = response.data
    .map((version) => ({
      id: version.id,
      platform: version.attributes?.platform,
      versionString: version.attributes?.versionString,
      appVersionState: version.attributes?.appVersionState,
      appStoreState: version.attributes?.appStoreState,
      releaseType: version.attributes?.releaseType,
      earliestReleaseDate: version.attributes?.earliestReleaseDate,
      createdDate: version.attributes?.createdDate,
      build: related<{ version?: string }>(response, version, "build")?.version,
    }))
    // The endpoint has no sort parameter.
    .sort((a, b) => (b.createdDate ?? "").localeCompare(a.createdDate ?? ""));
  return { versions, ...pageInfo(response) };
}

const versionIdSchema = idSchema("versions");

export const RELEASE_TYPES = ["MANUAL", "AFTER_APPROVAL", "SCHEDULED"] as const;

/** A version string as App Store Connect takes it: up to three period-separated numbers. */
const versionStringSchema = z
  .string({ error: "Give the version with --app-version, such as 2.5.0." })
  .trim()
  .regex(
    /^\d{1,9}(\.\d{1,9}){0,2}$/,
    "The version must be up to three period-separated numbers, such as 2.5.0.",
  );

/** An ISO 8601 date and time with its offset, such as 2026-12-01T09:00:00Z. */
const releaseDateSchema = z.iso.datetime({
  offset: true,
  error:
    "The release date must be a date and time such as 2026-12-01T09:00:00Z.",
});

const copyrightSchema = z.string().trim().min(1).max(500);

/** Refuses a release date that has already passed. */
function futureDate(value: string): string {
  if (Date.parse(value) <= Date.now()) {
    throw new InvalidInputError(
      `The release date ${value} has already passed; give a future one.`,
    );
  }
  return new Date(value).toISOString();
}

/**
 * The localized fields `--copy-from` copies. What's New is left out: it
 * describes the version it belongs to, so the new version's is written with
 * `metadata set --whats-new`.
 */
const COPIED_FIELDS = [
  "description",
  "keywords",
  "promotionalText",
  "supportUrl",
  "marketingUrl",
] as const;

type CopiedField = (typeof COPIED_FIELDS)[number];

type LocalizationAttributes = { locale?: string } & {
  [K in CopiedField]?: string | null;
};

async function readLocalizations(client: AscClient, versionId: string) {
  // An app has far fewer locales than the 200 one page holds.
  const response = await client.get<AscDocument<LocalizationAttributes>>(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    {
      "fields[appStoreVersionLocalizations]": ["locale", ...COPIED_FIELDS],
      limit: 200,
    },
  );
  return response.data.map(({ id, attributes }) => ({
    id,
    locale: attributes?.locale ?? "",
    values: Object.fromEntries(
      COPIED_FIELDS.flatMap((field) => {
        const value = attributes?.[field];
        return value ? [[field, value]] : [];
      }),
    ) as Partial<Record<CopiedField, string>>,
  }));
}

export const createVersionInput = z
  .object({
    appId: appIdSchema,
    version: versionStringSchema,
    platform: z.enum(PLATFORMS).default("IOS"),
    copyFrom: versionIdSchema.optional(),
    copyright: copyrightSchema.optional(),
    releaseType: z.enum(RELEASE_TYPES).optional(),
    releaseDate: releaseDateSchema.optional(),
    yes: z.boolean().default(false),
  })
  .refine(
    (input) =>
      input.releaseDate === undefined || input.releaseType === "SCHEDULED",
    {
      message: "--release-date needs --release-type SCHEDULED.",
      path: ["releaseDate"],
    },
  )
  .refine(
    (input) =>
      input.releaseType !== "SCHEDULED" || input.releaseDate !== undefined,
    {
      message: "--release-type SCHEDULED needs --release-date.",
      path: ["releaseType"],
    },
  );

/**
 * Creates the next App Store version of an app. Refuses a version string the
 * app already has on that platform. With `copyFrom`, copies another version's
 * localized description, keywords, promotional text and URLs into the new
 * one, one request per locale.
 */
export async function createVersion(
  client: AscClient,
  input: z.output<typeof createVersionInput>,
) {
  const existing = await client.get<AscDocument<VersionAttributes>>(
    `/v1/apps/${input.appId}/appStoreVersions`,
    {
      "filter[versionString]": input.version,
      "filter[platform]": input.platform,
      "fields[appStoreVersions]": ["versionString", "appVersionState"],
      limit: 1,
    },
  );
  const duplicate = existing.data[0];
  if (duplicate) {
    throw new InvalidInputError(
      `The app already has ${input.platform} version ${input.version} (${duplicate.id}, ${duplicate.attributes?.appVersionState}).`,
    );
  }
  const releaseDate =
    input.releaseDate === undefined ? undefined : futureDate(input.releaseDate);

  let source:
    | {
        versionId: string;
        version?: string;
        locales: Awaited<ReturnType<typeof readLocalizations>>;
      }
    | undefined;
  if (input.copyFrom !== undefined) {
    const { data } = await client.get<{
      data: AscResource<VersionAttributes>;
    }>(`/v1/appStoreVersions/${input.copyFrom}`, {
      "fields[appStoreVersions]": ["versionString", "platform", "app"],
      include: "app",
      "fields[apps]": ["bundleId"],
    });
    const sourceApp = data.relationships?.app?.data?.id;
    if (sourceApp !== undefined && sourceApp !== input.appId) {
      throw new InvalidInputError(
        `Version ${input.copyFrom} belongs to app ${sourceApp}, not app ${input.appId}.`,
      );
    }
    source = {
      versionId: data.id,
      version: data.attributes?.versionString,
      locales: await readLocalizations(client, input.copyFrom),
    };
  }

  const attributes = {
    platform: input.platform,
    versionString: input.version,
    copyright: input.copyright,
    releaseType: input.releaseType,
    earliestReleaseDate: releaseDate,
  };
  const base = {
    action: "create",
    appId: input.appId,
    attributes,
    copyFrom: source && {
      versionId: source.versionId,
      version: source.version,
      locales: source.locales.map(({ locale, values }) => ({
        locale,
        fields: Object.keys(values),
      })),
    },
  };
  if (!input.yes) return { dryRun: true, ...base };

  const { data: created } = await client.post<{
    data: AscResource<VersionAttributes>;
  }>("/v1/appStoreVersions", {
    data: {
      type: "appStoreVersions",
      attributes,
      relationships: { app: { data: { type: "apps", id: input.appId } } },
    },
  });
  const copied: { locale: string; action: string; fields: string[] }[] = [];
  if (source) {
    try {
      // Apple may create some locales with the version; those are updated.
      const target = await readLocalizations(client, created.id);
      for (const { locale, values } of source.locales) {
        const match = target.find((entry) => entry.locale === locale);
        if (!match) {
          await client.post("/v1/appStoreVersionLocalizations", {
            data: {
              type: "appStoreVersionLocalizations",
              attributes: { locale, ...values },
              relationships: {
                appStoreVersion: {
                  data: { type: "appStoreVersions", id: created.id },
                },
              },
            },
          });
          copied.push({
            locale,
            action: "created",
            fields: Object.keys(values),
          });
          continue;
        }
        const changed = Object.fromEntries(
          Object.entries(values).filter(
            ([field, value]) => match.values[field as CopiedField] !== value,
          ),
        );
        const fields = Object.keys(changed);
        if (fields.length > 0) {
          await client.patch(`/v1/appStoreVersionLocalizations/${match.id}`, {
            data: {
              type: "appStoreVersionLocalizations",
              id: match.id,
              attributes: changed,
            },
          });
        }
        copied.push({
          locale,
          action: fields.length > 0 ? "updated" : "unchanged",
          fields,
        });
      }
    } catch (error) {
      const done = copied.map((entry) => entry.locale);
      throw new UploadIncompleteError(
        `Version ${input.version} was created (${created.id}), but its metadata was copied only for ${done.length > 0 ? done.join(", ") : "no locale"}; set the rest with metadata set.`,
        { cause: error },
      );
    }
  }
  return {
    dryRun: false,
    ...base,
    versionId: created.id,
    state: created.attributes?.appVersionState,
    copied,
  };
}

const SET_FIELDS = ["releaseType", "earliestReleaseDate", "copyright"] as const;

type SetField = (typeof SET_FIELDS)[number];

export const setVersionInput = z
  .object({
    versionId: versionIdSchema,
    releaseType: z.enum(RELEASE_TYPES).optional(),
    releaseDate: releaseDateSchema.optional(),
    copyright: copyrightSchema.optional(),
    yes: z.boolean().default(false),
  })
  .refine(
    (input) =>
      input.releaseType !== undefined ||
      input.releaseDate !== undefined ||
      input.copyright !== undefined,
    {
      message:
        "Give at least one of --release-type, --release-date and --copyright.",
    },
  )
  .refine(
    (input) =>
      input.releaseDate === undefined ||
      input.releaseType === undefined ||
      input.releaseType === "SCHEDULED",
    {
      message: "--release-date needs --release-type SCHEDULED.",
      path: ["releaseDate"],
    },
  );

/**
 * Changes a version's release type, scheduled release date or copyright.
 * Only a version being prepared or rejected accepts changes.
 */
export async function setVersion(
  client: AscClient,
  input: z.output<typeof setVersionInput>,
) {
  const { data } = await client.get<{
    data: AscResource<VersionAttributes & { copyright?: string | null }>;
  }>(`/v1/appStoreVersions/${input.versionId}`, {
    "fields[appStoreVersions]": [
      "platform",
      "versionString",
      "appVersionState",
      "releaseType",
      "earliestReleaseDate",
      "copyright",
    ],
  });
  const attributes = data.attributes ?? {};
  const version = {
    id: data.id,
    version: attributes.versionString,
    platform: attributes.platform,
    state: attributes.appVersionState,
  };
  if (!EDITABLE_STATES.has(version.state ?? "")) {
    throw new NotEditableError(
      `Version ${version.version} is ${version.state}, so its release options and copyright can no longer be changed. Change a version that is PREPARE_FOR_SUBMISSION or rejected.`,
    );
  }
  const current: Record<SetField, string | null> = {
    releaseType: attributes.releaseType ?? null,
    earliestReleaseDate: attributes.earliestReleaseDate ?? null,
    copyright: attributes.copyright ?? null,
  };
  const releaseType = input.releaseType ?? current.releaseType;
  if (input.releaseDate !== undefined && releaseType !== "SCHEDULED") {
    throw new InvalidInputError(
      `Version ${version.version} is released ${releaseType ?? "MANUAL"}; give --release-type SCHEDULED with --release-date.`,
    );
  }
  const releaseDate =
    input.releaseDate === undefined ? undefined : futureDate(input.releaseDate);
  if (
    releaseType === "SCHEDULED" &&
    (releaseDate ?? current.earliestReleaseDate) === null
  ) {
    throw new InvalidInputError(
      "A SCHEDULED release needs a date: give --release-date.",
    );
  }
  const wanted: Partial<Record<SetField, string>> = {
    releaseType: input.releaseType,
    earliestReleaseDate: releaseDate,
    copyright: input.copyright,
  };
  const update = Object.fromEntries(
    SET_FIELDS.flatMap((field) => {
      const value = wanted[field];
      if (value === undefined) return [];
      const same =
        field === "earliestReleaseDate" && current[field] !== null
          ? Date.parse(current[field] ?? "") === Date.parse(value)
          : current[field] === value;
      return same ? [] : [[field, value]];
    }),
  ) as Partial<Record<SetField, string>>;
  const changed = Object.keys(update);
  const base = { action: "set", version, current, update };
  if (!input.yes) {
    return { dryRun: true, ...base, changes: changed.length > 0 };
  }
  if (changed.length > 0) {
    await client.patch(`/v1/appStoreVersions/${input.versionId}`, {
      data: {
        type: "appStoreVersions",
        id: input.versionId,
        attributes: update,
      },
    });
  }
  return { dryRun: false, ...base, changed };
}
