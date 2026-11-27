import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import * as z from "zod";
import type { AscClient, AscDocument, AscResource } from "../asc/client.ts";
import { related } from "../asc/client.ts";
import { appIdSchema, idSchema, PLATFORMS } from "../schemas/common.ts";
import {
  InvalidInputError,
  NotEditableError,
  NotFoundError,
  UnexpectedResponseError,
} from "../utils/errors.ts";
import { EDITABLE_STATES as APP_INFO_EDITABLE } from "./app-info.ts";
import {
  readVersion,
  EDITABLE_STATES as VERSION_EDITABLE,
} from "./metadata.ts";
import {
  type LintDependencies,
  type Listing,
  lintListing,
  lintOptions,
} from "./metadata-lint.ts";
import {
  listPlacements,
  orderPlacements,
  type PlannedFile,
  placeFiles,
  planUpload,
  showPlanned,
  type UploadTarget,
} from "./screenshots.ts";

/**
 * `metadata pull` and `metadata push`: a whole App Store listing as a folder.
 *
 *   <folder>/version.json          {"copyright": "2026 Example Ltd"}
 *   <folder>/<locale>/metadata.json  the version and app info fields
 *   <folder>/<locale>/<GROUP>-<NN>-<name>.png|.jpg|.mp4|...
 *
 * A screenshot or preview names its device group and its position, so its
 * display type (image or video), group and order are clear from its name.
 */

/** The version localization fields, as `metadata set` takes them. */
const VERSION_FIELDS = [
  "description",
  "keywords",
  "promotionalText",
  "whatsNew",
  "supportUrl",
  "marketingUrl",
] as const;
/** The app info localization fields, as `app-info set` takes them. */
const APP_INFO_FIELDS = [
  "name",
  "subtitle",
  "privacyPolicyUrl",
  "privacyChoicesUrl",
  "privacyPolicyText",
] as const;
type VersionField = (typeof VERSION_FIELDS)[number];
type AppInfoField = (typeof APP_INFO_FIELDS)[number];
type Field = VersionField | AppInfoField;

const METADATA_FILE = "metadata.json";
const VERSION_FILE = "version.json";
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** The `<GROUP>-<NN>-` prefix `metadata pull` gives a file name. */
const PULL_PREFIX = /^[A-Z0-9_]+-\d+-/;

const fieldValue = z.string().nullable().optional();
const metadataFileSchema = z.strictObject(
  Object.fromEntries(
    [...VERSION_FIELDS, ...APP_INFO_FIELDS].map((field) => [field, fieldValue]),
  ) as Record<Field, typeof fieldValue>,
);
const versionFileSchema = z.strictObject({ copyright: fieldValue });

/** A field's value with empty meaning none. */
const value = (raw: unknown) =>
  typeof raw === "string" && raw !== "" ? raw : null;

/** A file name without the prefix `metadata pull` adds, so pulled and placed files match. */
export const baseName = (file: string) => file.replace(PULL_PREFIX, "");

const byName = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true });

async function readJson<T extends z.ZodType>(
  path: string,
  schema: T,
): Promise<z.output<T> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new InvalidInputError(`${path} is not valid JSON.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidInputError(`${path}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** A listing folder: the copyright (undefined without version.json) and each locale's fields. */
export async function readFolder(dir: string) {
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort(byName);
  } catch {
    throw new NotFoundError(`Could not read the folder ${dir}.`);
  }
  const bad = entries.filter((name) => !LOCALE_PATTERN.test(name));
  if (bad.length > 0) {
    throw new InvalidInputError(
      `${dir} has folders that are not locales: ${bad.join(", ")}. Name each locale's folder after it, such as en-US.`,
    );
  }
  if (entries.length === 0) {
    throw new InvalidInputError(
      `${dir} has no locale folders; metadata pull writes one per locale, such as en-US.`,
    );
  }
  const version = await readJson(join(dir, VERSION_FILE), versionFileSchema);
  const locales = [];
  for (const locale of entries) {
    const fields =
      (await readJson(join(dir, locale, METADATA_FILE), metadataFileSchema)) ??
      {};
    locales.push({
      locale,
      fields: fields as Partial<Record<Field, string | null>>,
    });
  }
  return { copyright: version?.copyright, locales };
}

/** The app info `metadata push` writes to: the one being prepared or rejected, else the live one. */
export async function pickAppInfo(client: AscClient, appId: string) {
  const response = await client.get<AscDocument<{ state?: string }>>(
    `/v1/apps/${appId}/appInfos`,
    { "fields[appInfos]": ["state"], limit: 200 },
  );
  const appInfo =
    response.data.find(({ attributes }) =>
      APP_INFO_EDITABLE.has(attributes?.state ?? ""),
    ) ?? response.data[0];
  if (!appInfo) {
    throw new NotFoundError(`App ${appId} has no app info.`);
  }
  return { id: appInfo.id, state: appInfo.attributes?.state };
}

/** The version given, or the platform's version being prepared or rejected, else its live one. */
async function pickVersion(
  client: AscClient,
  appId: string,
  platform: string,
  versionId?: string,
) {
  if (versionId) return readVersion(client, versionId);
  const response = await client.get<
    AscDocument<{ versionString?: string; appVersionState?: string }>
  >(`/v1/apps/${appId}/appStoreVersions`, {
    "filter[platform]": platform,
    "fields[appStoreVersions]": ["versionString", "appVersionState"],
    limit: 200,
  });
  const state = (version: (typeof response.data)[number]) =>
    version.attributes?.appVersionState ?? "";
  const version =
    response.data.find((item) => VERSION_EDITABLE.has(state(item))) ??
    response.data.find((item) => state(item) === "READY_FOR_DISTRIBUTION") ??
    response.data[0];
  if (!version) {
    throw new NotFoundError(
      `App ${appId} has no ${platform} version; the versions command lists them.`,
    );
  }
  return readVersion(client, version.id);
}

interface RemoteLocale {
  locale: string;
  versionLocalizationId?: string;
  appInfoLocalizationId?: string;
  fields: Partial<Record<Field, string | null>>;
}

/** A version's and an app info's localizations merged by locale, and the version's copyright. */
export async function readListing(
  client: AscClient,
  versionId: string,
  appInfoId: string,
) {
  const { data: version } = await client.get<{
    data: AscResource<{ copyright?: string | null }>;
  }>(`/v1/appStoreVersions/${versionId}`, {
    "fields[appStoreVersions]": ["copyright"],
  });
  const versionLocalizations = await client.get<
    AscDocument<
      { locale?: string } & Partial<Record<VersionField, string | null>>
    >
  >(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`, {
    "fields[appStoreVersionLocalizations]": ["locale", ...VERSION_FIELDS],
    limit: 200,
  });
  const appInfoLocalizations = await client.get<
    AscDocument<
      { locale?: string } & Partial<Record<AppInfoField, string | null>>
    >
  >(`/v1/appInfos/${appInfoId}/appInfoLocalizations`, {
    "fields[appInfoLocalizations]": ["locale", ...APP_INFO_FIELDS],
    limit: 200,
  });
  const locales = new Map<string, RemoteLocale>();
  const entry = (locale: string) => {
    const existing = locales.get(locale) ?? { locale, fields: {} };
    locales.set(locale, existing);
    return existing;
  };
  for (const { id, attributes } of versionLocalizations.data) {
    const item = entry(attributes?.locale ?? "");
    item.versionLocalizationId = id;
    for (const field of VERSION_FIELDS) {
      item.fields[field] = value(attributes?.[field]);
    }
  }
  for (const { id, attributes } of appInfoLocalizations.data) {
    const item = entry(attributes?.locale ?? "");
    item.appInfoLocalizationId = id;
    for (const field of APP_INFO_FIELDS) {
      item.fields[field] = value(attributes?.[field]);
    }
  }
  return {
    copyright: value(version.attributes?.copyright),
    locales: [...locales.values()].sort((a, b) => byName(a.locale, b.locale)),
  };
}

const platformSchema = z.enum(PLATFORMS).default("IOS");

export const pullInput = z.object({
  appId: appIdSchema,
  dir: z
    .string({ error: "Give the folder to write with --dir." })
    .trim()
    .min(1, "Give the folder to write with --dir."),
  versionId: idSchema("versions").optional(),
  platform: platformSchema,
  media: z.boolean().default(true),
});

interface MediaAttributes {
  fileName?: string;
  imageAsset?: { templateUrl?: string; width?: number; height?: number } | null;
  videoAsset?: string | null;
}

/** A localization's placements with the URLs their files can be downloaded from. */
async function placementsWithAssets(client: AscClient, localizationId: string) {
  const response = await client.get<
    AscDocument<{ placementType?: string; placementGroup?: string }>
  >(`/v1/appStoreVersionLocalizations/${localizationId}/placements`, {
    "filter[placementType]": ["APP_SCREENSHOT", "APP_PREVIEW"],
    sort: "placementGroupPosition",
    limit: 200,
    "fields[appAssetLibraryPlacements]": [
      "placementType",
      "placementGroup",
      "image",
      "video",
    ],
    "fields[appAssetLibraryImages]": ["fileName", "imageAsset"],
    "fields[appAssetLibraryVideos]": ["fileName", "videoAsset"],
    include: ["image", "video"],
  });
  return response.data.map((placement) => {
    const image = related<MediaAttributes>(response, placement, "image");
    const video = related<MediaAttributes>(response, placement, "video");
    const asset = image ?? video;
    const fileName = asset?.fileName ?? placement.id;
    let url: string | undefined;
    if (image?.imageAsset?.templateUrl) {
      const { templateUrl, width, height } = image.imageAsset;
      const format = extname(fileName).toLowerCase() === ".png" ? "png" : "jpg";
      url = templateUrl
        .replace("{w}", String(width ?? ""))
        .replace("{h}", String(height ?? ""))
        .replace("{f}", format);
    } else if (video?.videoAsset) {
      url = video.videoAsset;
    }
    return {
      id: placement.id,
      placementType: placement.attributes?.placementType ?? "",
      placementGroup: placement.attributes?.placementGroup ?? "",
      fileName,
      url,
    };
  });
}

/**
 * Writes an app's listing into a new folder: version.json with the
 * copyright, and per locale metadata.json with the version and app info
 * fields and, unless `media` is false, its screenshots and previews.
 */
export async function pullMetadata(
  client: AscClient,
  input: z.output<typeof pullInput>,
) {
  const existing = await readdir(input.dir).catch(() => []);
  if (existing.length > 0) {
    throw new InvalidInputError(
      `${input.dir} is not empty; pull into a new folder so no old file is mixed in.`,
    );
  }
  const version = await pickVersion(
    client,
    input.appId,
    input.platform,
    input.versionId,
  );
  const appInfo = await pickAppInfo(client, input.appId);
  const listing = await readListing(client, version.id, appInfo.id);
  await mkdir(input.dir, { recursive: true });
  await writeFile(
    join(input.dir, VERSION_FILE),
    `${JSON.stringify({ copyright: listing.copyright }, null, 2)}\n`,
    { flag: "wx" },
  );
  const files: string[] = [];
  const skipped: { locale: string; fileName: string; reason: string }[] = [];
  for (const locale of listing.locales) {
    const folder = join(input.dir, locale.locale);
    await mkdir(folder);
    const fields = Object.fromEntries(
      [...VERSION_FIELDS, ...APP_INFO_FIELDS].map((field) => [
        field,
        locale.fields[field] ?? null,
      ]),
    );
    await writeFile(
      join(folder, METADATA_FILE),
      `${JSON.stringify(fields, null, 2)}\n`,
      { flag: "wx" },
    );
    if (!input.media || !locale.versionLocalizationId) continue;
    const positions = new Map<string, number>();
    for (const placement of await placementsWithAssets(
      client,
      locale.versionLocalizationId,
    )) {
      if (!placement.url) {
        skipped.push({
          locale: locale.locale,
          fileName: placement.fileName,
          reason: "Apple gave no download URL; it may still be processing.",
        });
        continue;
      }
      const key = `${placement.placementType} ${placement.placementGroup}`;
      const position = (positions.get(key) ?? 0) + 1;
      positions.set(key, position);
      const name = `${placement.placementGroup}-${String(position).padStart(2, "0")}-${baseName(placement.fileName)}`;
      await writeFile(
        join(folder, name),
        await client.downloadSigned(placement.url),
        {
          flag: "wx",
        },
      );
      files.push(`${locale.locale}/${name}`);
    }
  }
  return {
    dir: input.dir,
    version,
    appInfo,
    locales: listing.locales.map(({ locale }) => locale),
    files,
    skipped,
  };
}

export const pushInput = z.object({
  appId: appIdSchema,
  dir: z.string().trim().min(1, "Give the folder from metadata pull."),
  versionId: idSchema("versions").optional(),
  platform: platformSchema,
  syncScreenshots: z.boolean().default(false),
  ignoreLint: z.boolean().default(false),
  ...lintOptions,
  yes: z.boolean().default(false),
});

interface FieldChange {
  field: Field;
  change: "added" | "changed" | "removed";
  from: string | null;
  to: string | null;
}

function diff<F extends Field>(
  fields: readonly F[],
  local: Partial<Record<Field, string | null>>,
  remote: Partial<Record<Field, string | null>>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of fields) {
    // A field the file leaves out is left as it is.
    if (!(field in local)) continue;
    const to = value(local[field]);
    const from = value(remote[field]);
    if (to === from) continue;
    changes.push({
      field,
      change: from === null ? "added" : to === null ? "removed" : "changed",
      from,
      to,
    });
  }
  return changes;
}

const attributes = (changes: FieldChange[]) =>
  Object.fromEntries(changes.map(({ field, to }) => [field, to]));

type Placement = Awaited<ReturnType<typeof listPlacements>>[number];
const mediaKey = (type: string | undefined, group: string | undefined) =>
  `${type} ${group}`;

/**
 * Compares a folder from `metadata pull` with App Store Connect and applies
 * only the differences: fields, copyright, new locales and files not yet
 * placed. With `syncScreenshots`, also removes placements the folder does
 * not have and reorders to the folder's order. The lint runs first and stops
 * the push on errors unless `ignoreLint`. Without `yes`, prints the plan.
 */
export async function pushMetadata(
  client: AscClient,
  input: z.output<typeof pushInput>,
  dependencies: LintDependencies,
) {
  const folder = await readFolder(input.dir);
  const lint = await lintListing(folder, input, dependencies);
  if (lint.errors > 0 && !input.ignoreLint) {
    const shown = lint.findings
      .filter(({ severity }) => severity === "error")
      .slice(0, 10)
      .map(
        ({ locale, field, rule, message }) =>
          `${locale ? `${locale} ` : ""}${field} (${rule}): ${message}`,
      );
    throw new InvalidInputError(
      `The metadata lint found ${lint.errors} error(s), so nothing was pushed: ${shown.join(" ")} Fix them, turn a rule off with --rule <name>=off, or pass --ignore-lint.`,
    );
  }

  const version = await pickVersion(
    client,
    input.appId,
    input.platform,
    input.versionId,
  );
  const appInfo = await pickAppInfo(client, input.appId);
  const remote = await readListing(client, version.id, appInfo.id);
  const remoteByLocale = new Map(
    remote.locales.map((item) => [item.locale, item]),
  );

  const copyright =
    folder.copyright === undefined ||
    value(folder.copyright) === remote.copyright
      ? undefined
      : { from: remote.copyright, to: value(folder.copyright) };

  const locales = folder.locales.map(({ locale, fields }) => {
    const current = remoteByLocale.get(locale);
    return {
      locale,
      versionLocalizationId: current?.versionLocalizationId,
      appInfoLocalizationId: current?.appInfoLocalizationId,
      version: diff(VERSION_FIELDS, fields, current?.fields ?? {}),
      appInfo: diff(APP_INFO_FIELDS, fields, current?.fields ?? {}),
    };
  });
  for (const item of locales) {
    if (!item.appInfoLocalizationId && item.appInfo.length > 0) {
      if (!item.appInfo.some(({ field, to }) => field === "name" && to)) {
        throw new InvalidInputError(
          `${item.locale} is a new app info locale, so its metadata.json needs a name.`,
        );
      }
    }
  }

  // Screenshots and previews: files whose name matches a placement are already there.
  const target: UploadTarget = {
    localizationType: "appStoreVersionLocalizations",
    relationship: "appStoreVersionLocalization",
    feature: "APP_STORE_VERSIONS",
    label: `Version ${version.version}`,
    localesCommand: "metadata",
    localizations: locales.map(({ locale, versionLocalizationId }) => ({
      locale,
      id: versionLocalizationId ?? "",
    })),
  };
  const existing = new Map<string, Placement[]>();
  for (const { locale, versionLocalizationId } of locales) {
    existing.set(
      locale,
      versionLocalizationId
        ? await listPlacements(client, versionLocalizationId)
        : [],
    );
  }
  const all: PlannedFile[] = [];
  const matched = new Map<string, string>();
  const unmatched = new Map(
    [...existing].map(([locale, placements]) => [locale, [...placements]]),
  );
  const { files: adding, skipped } = await planUpload(
    client,
    input.dir,
    target,
    {
      include(file) {
        all.push(file);
        const pool = unmatched.get(file.locale) ?? [];
        const index = pool.findIndex(
          (placement) =>
            mediaKey(placement.placementType, placement.placementGroup) ===
              mediaKey(file.placementType, file.placementGroup) &&
            baseName(placement.fileName ?? "") === baseName(file.file),
        );
        if (index === -1) return true;
        const [placement] = pool.splice(index, 1);
        matched.set(`${file.locale}/${file.file}`, placement?.id ?? "");
        return false;
      },
      // Read after every file is matched, before the limit check.
      removing: input.syncScreenshots
        ? {
            has: (id: string) =>
              [...unmatched.values()].some((pool) =>
                pool.some((placement) => placement.id === id),
              ),
          }
        : undefined,
      allowEmpty: true,
    },
  );
  const removing = input.syncScreenshots
    ? [...unmatched].flatMap(([locale, pool]) =>
        pool.map(({ id, placementType, placementGroup, fileName }) => ({
          locale,
          id,
          placementType,
          placementGroup,
          fileName,
        })),
      )
    : [];

  /** Each type and group whose order, after removing and appending, differs from the folder's. */
  const reorders = input.syncScreenshots
    ? locales.flatMap(({ locale }) => {
        const kept = (existing.get(locale) ?? []).filter(
          ({ id }) => !removing.some((item) => item.id === id),
        );
        const groups = new Map<string, PlannedFile[]>();
        for (const file of all.filter((item) => item.locale === locale)) {
          const key = mediaKey(file.placementType, file.placementGroup);
          groups.set(key, [...(groups.get(key) ?? []), file]);
        }
        return [...groups.values()].flatMap((files) => {
          const first = files[0];
          if (!first) return [];
          const key = mediaKey(first.placementType, first.placementGroup);
          const wanted = files.map(({ file }) => file);
          const keptHere = kept.filter(
            (placement) =>
              mediaKey(placement.placementType, placement.placementGroup) ===
              key,
          );
          const byPlacement = new Map(
            [...matched].map(([name, id]) => [
              id,
              name.slice(locale.length + 1),
            ]),
          );
          const result = [
            ...keptHere.map(({ id }) => byPlacement.get(id) ?? id),
            ...files
              .filter(({ file }) => !matched.has(`${locale}/${file}`))
              .map(({ file }) => file),
          ];
          if (result.every((name, index) => name === wanted[index])) return [];
          return [
            {
              locale,
              placementType: first.placementType,
              placementGroup: first.placementGroup ?? "",
              order: wanted,
            },
          ];
        });
      })
    : [];

  // A version past review takes only promotional text; an app info only while prepared.
  const versionEditable = VERSION_EDITABLE.has(version.state ?? "");
  if (!versionEditable) {
    const blocked = [
      ...(copyright ? ["copyright"] : []),
      ...locales.flatMap(
        ({ locale, versionLocalizationId, version: changes }) => [
          ...(versionLocalizationId || changes.length === 0
            ? []
            : [`${locale} (new locale)`]),
          ...changes
            .filter(({ field }) => field !== "promotionalText")
            .map(({ field }) => `${locale} ${field}`),
        ],
      ),
      ...(adding.length + removing.length + reorders.length > 0
        ? ["screenshots and previews"]
        : []),
    ];
    if (blocked.length > 0) {
      throw new NotEditableError(
        `Version ${version.version} is ${version.state}, so only promotional text can change; the folder also changes ${blocked.join(", ")}. Push to a version that is PREPARE_FOR_SUBMISSION or rejected with --version-id.`,
      );
    }
  }
  if (
    !APP_INFO_EDITABLE.has(appInfo.state ?? "") &&
    locales.some(({ appInfo: changes }) => changes.length > 0)
  ) {
    throw new NotEditableError(
      `App info ${appInfo.id} is ${appInfo.state}, so its name, subtitle and privacy links can no longer change. Create a new version so App Store Connect opens an app info to edit.`,
    );
  }

  const plan = {
    copyright,
    locales: locales
      .map(
        ({
          locale,
          versionLocalizationId,
          appInfoLocalizationId,
          version: v,
          appInfo: a,
        }) => ({
          locale,
          ...(versionLocalizationId ||
          (v.length === 0 && !adding.some((f) => f.locale === locale))
            ? {}
            : { createVersionLocalization: true }),
          ...(appInfoLocalizationId || a.length === 0
            ? {}
            : { createAppInfoLocalization: true }),
          version: v,
          appInfo: a,
          add: showPlanned(adding.filter((file) => file.locale === locale)),
          remove: removing.filter((item) => item.locale === locale),
          reorder: reorders.filter((item) => item.locale === locale),
        }),
      )
      .filter(
        (item) =>
          "createVersionLocalization" in item ||
          "createAppInfoLocalization" in item ||
          item.version.length +
            item.appInfo.length +
            item.add.length +
            item.remove.length +
            item.reorder.length >
            0,
      ),
  };
  const changes = Boolean(copyright) || plan.locales.length > 0;
  const shownSkipped = skipped.filter(
    (path) => !path.endsWith(`/${METADATA_FILE}`),
  );
  if (!input.yes) {
    return {
      dryRun: true,
      action: "metadata-push",
      version,
      appInfo,
      lint,
      plan,
      skipped: shownSkipped,
      changes,
    };
  }

  if (copyright) {
    await client.patch(`/v1/appStoreVersions/${version.id}`, {
      data: {
        type: "appStoreVersions",
        id: version.id,
        attributes: { copyright: copyright.to },
      },
    });
  }
  const createdIds = new Map<string, string>();
  for (const item of locales) {
    const needsVersion =
      item.version.length > 0 ||
      adding.some((file) => file.locale === item.locale);
    if (item.versionLocalizationId && item.version.length > 0) {
      await client.patch(
        `/v1/appStoreVersionLocalizations/${item.versionLocalizationId}`,
        {
          data: {
            type: "appStoreVersionLocalizations",
            id: item.versionLocalizationId,
            attributes: attributes(item.version),
          },
        },
      );
    } else if (!item.versionLocalizationId && needsVersion) {
      const created = await client.post<{ data: AscResource }>(
        "/v1/appStoreVersionLocalizations",
        {
          data: {
            type: "appStoreVersionLocalizations",
            attributes: { locale: item.locale, ...attributes(item.version) },
            relationships: {
              appStoreVersion: {
                data: { type: "appStoreVersions", id: version.id },
              },
            },
          },
        },
      );
      createdIds.set(item.locale, created.data.id);
    }
    if (item.appInfo.length === 0) continue;
    if (item.appInfoLocalizationId) {
      await client.patch(
        `/v1/appInfoLocalizations/${item.appInfoLocalizationId}`,
        {
          data: {
            type: "appInfoLocalizations",
            id: item.appInfoLocalizationId,
            attributes: attributes(item.appInfo),
          },
        },
      );
    } else {
      await client.post("/v1/appInfoLocalizations", {
        data: {
          type: "appInfoLocalizations",
          attributes: { locale: item.locale, ...attributes(item.appInfo) },
          relationships: {
            appInfo: { data: { type: "appInfos", id: appInfo.id } },
          },
        },
      });
    }
  }

  for (const { id } of removing) {
    await client.delete(`/v1/appAssetLibraryPlacements/${id}`);
  }
  const files = adding.map((file) => ({
    ...file,
    localizationId: file.localizationId || (createdIds.get(file.locale) ?? ""),
  }));
  const uploaded =
    files.length > 0
      ? await placeFiles(client, input.appId, target, files)
      : [];
  const placementIds = new Map([
    ...matched,
    ...uploaded.map(
      ({ locale, file, placementId }) =>
        [`${locale}/${file}`, placementId] as [string, string],
    ),
  ]);
  for (const { locale, placementGroup, order } of reorders) {
    const localizationId =
      locales.find((item) => item.locale === locale)?.versionLocalizationId ??
      createdIds.get(locale) ??
      "";
    await orderPlacements(
      client,
      localizationId,
      placementGroup,
      order.map((file) => placementIds.get(`${locale}/${file}`) ?? ""),
    );
  }
  return {
    dryRun: false,
    action: "metadata-push",
    versionId: version.id,
    appInfoId: appInfo.id,
    copyright: copyright?.to,
    locales: plan.locales.map(({ locale, version: v, appInfo: a }) => ({
      locale,
      created: createdIds.has(locale),
      changed: [...v, ...a].map(({ field }) => field),
    })),
    uploaded,
    removed: removing.map(({ id }) => id),
    reordered: reorders.map(({ locale, placementType, placementGroup }) => ({
      locale,
      placementType,
      placementGroup,
    })),
  };
}

export const lintInput = z
  .object({
    versionId: idSchema("versions").optional(),
    dir: z.string().trim().min(1).optional(),
    ...lintOptions,
  })
  .refine(
    (input) => (input.versionId === undefined) !== (input.dir === undefined),
    {
      message: "Give either a version id or --dir <folder>, not both.",
    },
  );

/** The version's app id. */
export async function versionAppId(client: AscClient, versionId: string) {
  const { data } = await client.get<{ data: AscResource }>(
    `/v1/appStoreVersions/${versionId}`,
    { "fields[appStoreVersions]": ["app"], include: "app" },
  );
  const appId = data.relationships?.app?.data?.id;
  if (!appId) {
    throw new UnexpectedResponseError(
      "App Store Connect did not say which app the version belongs to.",
    );
  }
  return appId;
}

/**
 * Lints a version's listing in every locale (with its app info and in-app
 * purchase names), or a folder from `metadata pull`.
 */
export async function lintMetadata(
  client: AscClient | undefined,
  input: z.output<typeof lintInput>,
  dependencies: LintDependencies,
) {
  let listing: Listing;
  let source: Record<string, string>;
  if (input.dir !== undefined) {
    const folder = await readFolder(input.dir);
    listing = folder;
    source = { dir: input.dir };
  } else {
    if (!client || !input.versionId) {
      throw new InvalidInputError("Give a version id or --dir <folder>.");
    }
    const appId = await versionAppId(client, input.versionId);
    const appInfo = await pickAppInfo(client, appId);
    const remote = await readListing(client, input.versionId, appInfo.id);
    const iaps = await client.get<AscDocument<{ name?: string }>>(
      `/v1/apps/${appId}/inAppPurchasesV2`,
      { "fields[inAppPurchases]": ["name"], limit: 200 },
    );
    listing = {
      copyright: remote.copyright,
      locales: remote.locales,
      inAppPurchases: iaps.data.map(({ id, attributes }) => ({
        id,
        name: attributes?.name,
      })),
    };
    source = { versionId: input.versionId, appInfoId: appInfo.id };
  }
  return { ...source, ...(await lintListing(listing, input, dependencies)) };
}
