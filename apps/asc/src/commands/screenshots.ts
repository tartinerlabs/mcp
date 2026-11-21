import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  related,
  type UploadOperation,
} from "../asc/client.ts";
import { idSchema, localeSchema } from "../schemas/common.ts";
import {
  InvalidInputError,
  NotEditableError,
  NotFoundError,
  UnexpectedResponseError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import { EDITABLE_STATES, readVersion } from "./metadata.ts";

/**
 * Screenshots and app previews through Apple's App Asset Library: a file is
 * uploaded to the app's library as an image or video, then placed on a
 * version localization with a placement type and a placement group (the
 * device family). The set-based appScreenshotSets and appPreviewSets
 * resources are deprecated in favour of this.
 */

const versionIdSchema = idSchema("versions");
const placementIdSchema = idSchema("screenshots");

const PLACEMENT_TYPES = ["APP_SCREENSHOT", "APP_PREVIEW"] as const;
/** An in-app event's card and details page; each takes an image or a video. */
export const EVENT_PLACEMENT_TYPES = [
  "EVENT_CARD_ASSET",
  "EVENT_DETAILS_PAGE_ASSET",
] as const;
type PlacementType =
  | (typeof PLACEMENT_TYPES)[number]
  | (typeof EVENT_PLACEMENT_TYPES)[number];

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);

const isVideo = (file: string) =>
  VIDEO_EXTENSIONS.has(extname(file).toLowerCase());

/**
 * The asset category a placement type accepts: screenshots and previews
 * take their own, and the creative types such as event cards take
 * CREATIVE_ASSETS.
 */
const category = (type: PlacementType) =>
  type === "APP_SCREENSHOT" || type === "APP_PREVIEW"
    ? "APP_SCREENSHOTS_AND_PREVIEWS"
    : "CREATIVE_ASSETS";

interface PlacementAttributes {
  placementType?: string;
  placementGroup?: string;
  state?: string;
}

interface AssetAttributes {
  fileName?: string;
  state?: string;
  uploadOperations?: UploadOperation[] | null;
}

const PLACEMENT_FIELDS = {
  "fields[appAssetLibraryPlacements]": [
    "placementType",
    "placementGroup",
    "state",
    "image",
    "video",
  ],
  "fields[appAssetLibraryImages]": ["fileName", "state"],
  "fields[appAssetLibraryVideos]": ["fileName", "state"],
  include: ["image", "video"],
};

/** A placement with the name and state of the file it shows. */
function shapePlacement(
  document: Pick<AscDocument<unknown>, "included">,
  placement: AscResource<PlacementAttributes>,
) {
  const asset =
    related<AssetAttributes>(document, placement, "image") ??
    related<AssetAttributes>(document, placement, "video");
  return {
    id: placement.id,
    placementType: placement.attributes?.placementType,
    placementGroup: placement.attributes?.placementGroup,
    state: placement.attributes?.state,
    fileName: asset?.fileName,
    assetState: asset?.state,
  };
}

/** Where placements go: an App Store version's localizations, a custom product page version's, a product page test treatment's or an in-app event's. */
type LocalizationType =
  | "appStoreVersionLocalizations"
  | "appCustomProductPageLocalizations"
  | "appStoreVersionExperimentTreatmentLocalizations"
  | "appEventLocalizations";

/** A localization's screenshots and previews, or the given placement types, in display order. */
export async function listPlacements(
  client: AscClient,
  localizationId: string,
  placementGroup?: string,
  localizationType: LocalizationType = "appStoreVersionLocalizations",
  placementTypes: readonly PlacementType[] = PLACEMENT_TYPES,
) {
  // Ten screenshots and three previews per group fit easily in one page.
  const response = await client.get<AscDocument<PlacementAttributes>>(
    `/v1/${localizationType}/${localizationId}/placements`,
    {
      "filter[placementType]": placementTypes,
      "filter[placementGroup]": placementGroup,
      sort: "placementGroupPosition",
      limit: 200,
      ...PLACEMENT_FIELDS,
    },
  );
  return response.data.map((placement) => shapePlacement(response, placement));
}

/** The version's localizations, optionally only one locale. */
async function listLocalizations(
  client: AscClient,
  versionId: string,
  locale?: string,
) {
  const response = await client.get<AscDocument<{ locale?: string }>>(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    {
      "fields[appStoreVersionLocalizations]": ["locale"],
      "filter[locale]": locale,
      limit: 200,
    },
  );
  return response.data.map(({ id, attributes }) => ({
    id,
    locale: attributes?.locale ?? "",
  }));
}

async function editableVersion(client: AscClient, versionId: string) {
  const version = await readVersion(client, versionId);
  if (!EDITABLE_STATES.has(version.state ?? "")) {
    throw new NotEditableError(
      `Version ${version.version} is ${version.state}, so its screenshots and previews can no longer be changed. Use a version that is PREPARE_FOR_SUBMISSION or rejected.`,
    );
  }
  return version;
}

/** Groups placements by placement type and group, keeping display order. */
function byGroup(placements: ReturnType<typeof shapePlacement>[]) {
  const groups = new Map<
    string,
    {
      placementType?: string;
      placementGroup?: string;
      placements: Omit<
        ReturnType<typeof shapePlacement>,
        "placementType" | "placementGroup"
      >[];
    }
  >();
  for (const { placementType, placementGroup, ...rest } of placements) {
    const key = `${placementType} ${placementGroup}`;
    const group = groups.get(key) ?? {
      placementType,
      placementGroup,
      placements: [],
    };
    group.placements.push(rest);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export const screenshotsInput = z.object({
  versionId: versionIdSchema,
  locale: localeSchema.optional(),
});

/** A version's screenshots and previews per locale and device group, in display order. */
export async function getScreenshots(
  client: AscClient,
  input: z.output<typeof screenshotsInput>,
) {
  const version = await readVersion(client, input.versionId);
  const localizations = await listLocalizations(
    client,
    input.versionId,
    input.locale,
  );
  if (input.locale !== undefined && localizations.length === 0) {
    throw new NotFoundError(
      `Version ${version.version} has no ${input.locale} localization; the metadata command lists its locales.`,
    );
  }
  const result = [];
  for (const localization of localizations) {
    result.push({
      ...localization,
      groups: byGroup(await listPlacements(client, localization.id)),
    });
  }
  return { version, localizations: result };
}

interface RefData {
  imageSpecs?: {
    specId?: string;
    dimensions?: {
      minWidth?: number;
      maxWidth?: number;
      minHeight?: number;
      maxHeight?: number;
    };
  }[];
  placementTypes?: {
    placementTypeId?: string;
    specMappings?: { placementGroupId?: string; specs?: string[] }[];
  }[];
  features?: {
    featureId?: string;
    placementPolicies?: {
      placementType?: string;
      groupLimits?: { groupIds?: string[]; maxCount?: number }[];
    }[];
  }[];
}

/** Apple's placement groups for each placement type, and the image specs each group accepts. */
async function readRefData(client: AscClient) {
  const response = await client.get<AscDocument<RefData>>(
    "/v1/appAssetLibraryRefData",
    {
      "fields[appAssetLibraryRefData]": [
        "imageSpecs",
        "placementTypes",
        "features",
      ],
    },
  );
  const attributes = response.data[0]?.attributes ?? {};
  const mappings = (type: PlacementType) =>
    attributes.placementTypes?.find((item) => item.placementTypeId === type)
      ?.specMappings ?? [];
  return {
    /** How many of this type a localization's group holds under a feature, if Apple says. */
    maxCount: (
      type: PlacementType,
      group: string | undefined,
      feature: string,
    ) =>
      (
        attributes.features?.find(({ featureId }) => featureId === feature) ??
        attributes.features?.find(
          ({ featureId }) => featureId === "APP_STORE_VERSIONS",
        )
      )?.placementPolicies
        ?.find(({ placementType }) => placementType === type)
        ?.groupLimits?.find(
          ({ groupIds }) => group !== undefined && groupIds?.includes(group),
        )?.maxCount,
    groups: (type: PlacementType) =>
      mappings(type).flatMap(({ placementGroupId }) =>
        placementGroupId ? [placementGroupId] : [],
      ),
    /** The type's groups with an image spec of this size, in either orientation. */
    groupsFor(type: PlacementType, width: number, height: number) {
      const fits = (min?: number, max?: number, value?: number) =>
        min !== undefined && max !== undefined && value !== undefined
          ? value >= min && value <= max
          : false;
      const specs = new Set(
        (attributes.imageSpecs ?? [])
          .filter(({ dimensions: d }) =>
            [
              [width, height],
              [height, width],
            ].some(
              ([w, h]) =>
                fits(d?.minWidth, d?.maxWidth, w) &&
                fits(d?.minHeight, d?.maxHeight, h),
            ),
          )
          .flatMap(({ specId }) => (specId ? [specId] : [])),
      );
      return mappings(type)
        .filter(({ specs: ids }) => ids?.some((id) => specs.has(id)))
        .flatMap(({ placementGroupId }) =>
          placementGroupId ? [placementGroupId] : [],
        );
    },
  };
}

/** A PNG's or JPEG's pixel size from its header, or undefined for anything else. */
export function imageSize(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: the 8-byte signature, then the IHDR chunk's width and height.
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return undefined;
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return undefined;
}

/** Sorts file and folder names the way Finder does, so 2.png comes before 10.png. */
const byName = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true });

export const uploadInput = z.object({
  versionId: versionIdSchema,
  dir: z
    .string({ error: "Give the folder to upload with --dir." })
    .trim()
    .min(1, "Give the folder to upload with --dir."),
  yes: z.boolean().default(false),
});

/** The localizations an upload places files on, and how errors name them. */
export interface UploadTarget {
  localizationType: LocalizationType;
  /** The placement's relationship to the localization. */
  relationship:
    | "appStoreVersionLocalization"
    | "appCustomProductPageLocalization"
    | "appStoreVersionExperimentTreatmentLocalization"
    | "appEventLocalization";
  /**
   * The placement types a file names in its file name, such as an in-app
   * event's; without them, images are screenshots and videos app previews.
   */
  placementTypes?: readonly PlacementType[];
  /**
   * The ref data feature whose group limits apply; App Store versions' limits
   * are used when Apple lists none for it.
   */
  feature: string;
  /** Names the parent in errors, such as "Version 2.4". */
  label: string;
  /** The command that lists the parent's locales. */
  localesCommand: string;
  localizations: { id: string; locale: string }[];
}

export interface PlannedFile {
  locale: string;
  localizationId: string;
  file: string;
  path: string;
  placementType: PlacementType;
  /** Left out for an event type Apple's ref data lists no group for. */
  placementGroup?: string;
  fileSize: number;
}

/** Reads the folder: one subfolder per locale, each file placed by the group in its name or its image size. */
export async function planUpload(
  client: AscClient,
  dir: string,
  target: UploadTarget,
) {
  let folders: string[];
  try {
    folders = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort(byName);
  } catch {
    throw new NotFoundError(`Could not read the folder ${dir}.`);
  }
  if (folders.length === 0) {
    throw new InvalidInputError(
      `${dir} has no locale folders: put each locale's files in a subfolder named after it, such as en-US.`,
    );
  }
  const localizations = new Map(
    target.localizations.map(({ id, locale }) => [locale, id]),
  );
  const missing = folders.filter((locale) => !localizations.has(locale));
  if (missing.length > 0) {
    throw new NotFoundError(
      `${target.label} has no ${missing.join(", ")} localization; the ${target.localesCommand} command lists its locales.`,
    );
  }
  const refData = await readRefData(client);
  const files: PlannedFile[] = [];
  const skipped: string[] = [];
  for (const locale of folders) {
    const names = (await readdir(join(dir, locale), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort(byName);
    for (const file of names) {
      const extension = extname(file).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension) && !isVideo(file)) {
        skipped.push(`${locale}/${file}`);
        continue;
      }
      // The longest type named in the file wins, as for groups below.
      const placementType: PlacementType | undefined = target.placementTypes
        ? target.placementTypes
            .filter((type) => file.toUpperCase().includes(type))
            .sort((a, b) => b.length - a.length)[0]
        : isVideo(file)
          ? "APP_PREVIEW"
          : "APP_SCREENSHOT";
      if (!placementType) {
        throw new InvalidInputError(
          `${locale}/${file}: put where it goes in its file name: ${target.placementTypes?.join(" or ")}.`,
        );
      }
      const path = join(dir, locale, file);
      // The longest group named in the file wins, so IPAD_PRO_3GEN_129 beats a shorter prefix.
      const named = refData
        .groups(placementType)
        .filter((group) => file.toUpperCase().includes(group))
        .sort((a, b) => b.length - a.length)[0];
      let placementGroup = named;
      // A type with a single group, as an in-app event's may have, needs no name.
      const typeGroups = refData.groups(placementType);
      if (!placementGroup && target.placementTypes && typeGroups.length === 1) {
        placementGroup = typeGroups[0];
      }
      // Assumption: Apple's docs name no groups for in-app event types and make
      // placementGroup optional, so an event type with none in the ref data is
      // placed without one.
      const groupless =
        Boolean(target.placementTypes) && typeGroups.length === 0;
      if (!placementGroup && !groupless && !isVideo(file)) {
        const size = imageSize(await readFile(path));
        const groups = size
          ? refData.groupsFor(placementType, size.width, size.height)
          : [];
        if (groups.length > 1) {
          throw new InvalidInputError(
            `${locale}/${file} (${size?.width}x${size?.height}) fits more than one device group: ${groups.join(", ")}. Put the group in the file name.`,
          );
        }
        if (groups.length === 0) {
          throw new InvalidInputError(
            `${locale}/${file} is ${size ? `${size.width}x${size.height}, which is not a size App Store Connect accepts for ${placementType}` : "not a PNG or JPEG image whose size could be read"}. Put the group in the file name, such as ${typeGroups[0] ?? "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE"}.`,
          );
        }
        placementGroup = groups[0];
      }
      if (!placementGroup && !groupless) {
        throw new InvalidInputError(
          placementType === "APP_PREVIEW"
            ? `${locale}/${file}: put the device group of an app preview in its file name, such as IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE-1.mp4.`
            : `${locale}/${file}: put the group of its ${placementType} video in its file name: ${typeGroups.join(", ")}.`,
        );
      }
      files.push({
        locale,
        localizationId: localizations.get(locale) ?? "",
        file,
        path,
        placementType,
        placementGroup,
        fileSize: (await stat(path)).size,
      });
    }
  }
  if (files.length === 0) {
    throw new InvalidInputError(
      `${dir} has no images (.png, .jpg) or videos (.mp4, .m4v, .mov) in its locale folders.`,
    );
  }
  // Apple refuses a placement past a group's limit, so check before writing anything.
  for (const locale of folders) {
    const planned = files.filter((file) => file.locale === locale);
    if (planned.length === 0) continue;
    const existing = await listPlacements(
      client,
      planned[0]?.localizationId ?? "",
      undefined,
      target.localizationType,
      target.placementTypes,
    );
    const checked = new Set<string>();
    for (const { placementType, placementGroup } of planned) {
      const key = `${placementType} ${placementGroup}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const max = refData.maxCount(
        placementType,
        placementGroup,
        target.feature,
      );
      const same = (item: {
        placementType?: string;
        placementGroup?: string;
      }) =>
        item.placementType === placementType &&
        item.placementGroup === placementGroup;
      const there = existing.filter(same).length;
      const adding = planned.filter(same).length;
      if (max !== undefined && there + adding > max) {
        throw new InvalidInputError(
          `${locale} ${placementGroup} has ${there} ${placementType} and the folder adds ${adding}, past App Store Connect's limit of ${max}. ${target.localizationType === "appStoreVersionLocalizations" ? "Remove some with screenshots delete, or take files out of the folder." : "Take files out of the folder."}`,
        );
      }
    }
  }
  return { files, skipped };
}

/** Reserves the file in the app's asset library, sends its parts and commits it. */
async function uploadAsset(
  client: AscClient,
  libraryId: string,
  file: PlannedFile,
): Promise<string> {
  const type = isVideo(file.file)
    ? "appAssetLibraryVideos"
    : "appAssetLibraryImages";
  const bytes = await readFile(file.path);
  if (bytes.length !== file.fileSize) {
    throw new InvalidInputError(
      `${file.locale}/${file.file} changed while it was being uploaded.`,
    );
  }
  const reserved = await client.post<{ data: AscResource<AssetAttributes> }>(
    `/v1/${type}`,
    {
      data: {
        type,
        attributes: {
          fileName: file.file,
          fileSize: file.fileSize,
          category: category(file.placementType),
        },
        relationships: {
          assetLibrary: { data: { type: "appAssetLibraries", id: libraryId } },
        },
      },
    },
  );
  const operations = reserved.data.attributes?.uploadOperations ?? [];
  if (operations.length === 0) {
    throw new UnexpectedResponseError(
      "App Store Connect reserved the file but gave no upload operations.",
    );
  }
  for (const operation of operations) {
    const { offset = 0, length = 0 } = operation;
    if (offset < 0 || length <= 0 || offset + length > bytes.length) {
      throw new UnexpectedResponseError(
        "App Store Connect asked for a part outside the file.",
      );
    }
    await client.upload(operation, bytes.subarray(offset, offset + length));
  }
  await client.patch(`/v1/${type}/${reserved.data.id}`, {
    data: { type, id: reserved.data.id, attributes: { uploaded: true } },
  });
  return reserved.data.id;
}

/** What the dry run and the result say about each planned file. */
export function showPlanned(files: PlannedFile[]) {
  return files.map(
    ({ locale, file, placementType, placementGroup, fileSize }) => ({
      locale,
      file,
      placementType,
      placementGroup,
      fileSize,
    }),
  );
}

/** Uploads each planned file to the app's asset library and places it on its localization, in order. */
export async function placeFiles(
  client: AscClient,
  appId: string,
  target: Pick<UploadTarget, "localizationType" | "relationship">,
  files: PlannedFile[],
) {
  const { data: library } = await client.get<{ data: AscResource }>(
    `/v1/apps/${appId}/assetLibrary`,
  );
  const shown = showPlanned(files);
  const uploaded = [];
  for (const [index, file] of files.entries()) {
    try {
      const assetId = await uploadAsset(client, library.id, file);
      const assetRelationship = isVideo(file.file)
        ? { video: { data: { type: "appAssetLibraryVideos", id: assetId } } }
        : { image: { data: { type: "appAssetLibraryImages", id: assetId } } };
      const placement = await client.post<{ data: AscResource }>(
        "/v1/appAssetLibraryPlacements",
        {
          data: {
            type: "appAssetLibraryPlacements",
            attributes: {
              placementType: file.placementType,
              placementGroup: file.placementGroup,
            },
            relationships: {
              ...assetRelationship,
              [target.relationship]: {
                data: {
                  type: target.localizationType,
                  id: file.localizationId,
                },
              },
            },
          },
        },
      );
      uploaded.push({
        ...shown[index],
        assetId,
        placementId: placement.data.id,
      });
    } catch (error) {
      // A rerun adds every file again, so say which ones are already placed.
      const placed = uploaded.map(
        ({ locale, file: name, placementId }) =>
          `${locale}/${name} (${placementId})`,
      );
      throw new UploadIncompleteError(
        `Stopped at ${file.locale}/${file.file}, whose file may be left in the app's asset library without a placement. ${placed.length > 0 ? `Already placed, so leave them out of a rerun: ${placed.join(", ")}.` : "Nothing was placed before it."}`,
        { cause: error },
      );
    }
  }
  return uploaded;
}

/**
 * Uploads a folder of screenshots and app previews to a version: one
 * subfolder per locale, each file placed in the device group its name names
 * or, for a screenshot, the one its pixel size fits. Files are added after
 * those already there, in file name order. Without `yes`, shows where each
 * file would go.
 */
export async function uploadScreenshots(
  client: AscClient,
  input: z.output<typeof uploadInput>,
) {
  const version = await editableVersion(client, input.versionId);
  const target = {
    localizationType: "appStoreVersionLocalizations",
    relationship: "appStoreVersionLocalization",
    feature: "APP_STORE_VERSIONS",
    label: `Version ${version.version}`,
    localesCommand: "metadata",
    localizations: await listLocalizations(client, input.versionId),
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
  const { data: versionData } = await client.get<{ data: AscResource }>(
    `/v1/appStoreVersions/${input.versionId}`,
    { "fields[appStoreVersions]": ["app"], include: "app" },
  );
  const appId = versionData.relationships?.app?.data?.id;
  if (!appId) {
    throw new UnexpectedResponseError(
      "App Store Connect did not say which app the version belongs to.",
    );
  }
  return {
    dryRun: false,
    action: "upload",
    versionId: input.versionId,
    uploaded: await placeFiles(client, appId, target, files),
    skipped,
  };
}

const placementGroupSchema = z
  .string({ error: "Give the device group with --group." })
  .trim()
  .regex(
    /^[A-Z0-9_]{1,100}$/,
    "Must be a device group from the screenshots command, such as IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE.",
  );

export const reorderInput = z.object({
  versionId: versionIdSchema,
  locale: localeSchema,
  group: placementGroupSchema,
  placements: z
    .array(placementIdSchema)
    .min(1, "Give the placement ids in their new order with --placement.")
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Give each placement id once.",
    }),
  yes: z.boolean().default(false),
});

/**
 * Sets the display order of one locale's screenshots, or previews, in one
 * device group. The ids must be all of that group's screenshots, or all of
 * its previews. Without `yes`, shows the current and new order.
 */
export async function reorderScreenshots(
  client: AscClient,
  input: z.output<typeof reorderInput>,
) {
  const version = await editableVersion(client, input.versionId);
  const localization = (
    await listLocalizations(client, input.versionId, input.locale)
  )[0];
  if (!localization) {
    throw new NotFoundError(
      `Version ${version.version} has no ${input.locale} localization; the metadata command lists its locales.`,
    );
  }
  const inGroup = await listPlacements(client, localization.id, input.group);
  const byId = new Map(inGroup.map((placement) => [placement.id, placement]));
  const unknown = input.placements.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new NotFoundError(
      `${input.locale} has no ${unknown.join(", ")} in ${input.group}; the screenshots command lists them.`,
    );
  }
  const placementType = byId.get(input.placements[0] ?? "")?.placementType;
  const current = inGroup.filter(
    (placement) => placement.placementType === placementType,
  );
  if (
    current.length !== input.placements.length ||
    input.placements.some((id) => byId.get(id)?.placementType !== placementType)
  ) {
    throw new InvalidInputError(
      `Give every ${placementType} in ${input.group} exactly once, and nothing else: ${current.map(({ id }) => id).join(", ")}.`,
    );
  }
  const show = ({ id, fileName }: { id: string; fileName?: string }) => ({
    id,
    fileName,
  });
  const order = input.placements.map((id) => show(byId.get(id) ?? { id }));
  const changes = current.some(
    ({ id }, index) => input.placements[index] !== id,
  );
  if (!input.yes) {
    return {
      dryRun: true,
      action: "reorder",
      version,
      locale: input.locale,
      placementGroup: input.group,
      placementType,
      current: current.map(show),
      order,
      changes,
    };
  }
  if (changes) {
    await client.post("/v1/appAssetLibraryPlacementOrderingRequests", {
      data: {
        type: "appAssetLibraryPlacementOrderingRequests",
        attributes: { placementGroup: input.group },
        relationships: {
          orderedPlacements: {
            data: input.placements.map((id) => ({
              type: "appAssetLibraryPlacements",
              id,
            })),
          },
          appStoreVersionLocalization: {
            data: { type: "appStoreVersionLocalizations", id: localization.id },
          },
        },
      },
    });
  }
  return {
    dryRun: false,
    action: "reorder",
    versionId: input.versionId,
    locale: input.locale,
    placementGroup: input.group,
    order: input.placements,
    changed: changes,
  };
}

export const deleteInput = z.object({
  placements: z
    .array(placementIdSchema)
    .min(1, "Give at least one placement id from the screenshots command.")
    .max(50),
  yes: z.boolean().default(false),
});

/**
 * Removes screenshots and previews from a version that can still be edited.
 * The files stay in the app's asset library. Without `yes`, shows each one
 * with its version and locale.
 */
export async function deleteScreenshots(
  client: AscClient,
  input: z.output<typeof deleteInput>,
) {
  const placements = [];
  const versions = new Map<
    string,
    { versionId: string; version?: string; locale?: string }
  >();
  for (const id of new Set(input.placements)) {
    const response = await client.get<{
      data: AscResource<PlacementAttributes>;
      included?: AscResource[];
    }>(`/v1/appAssetLibraryPlacements/${id}`, {
      ...PLACEMENT_FIELDS,
      "fields[appAssetLibraryPlacements]": [
        ...PLACEMENT_FIELDS["fields[appAssetLibraryPlacements]"],
        "appStoreVersionLocalization",
      ],
      include: [...PLACEMENT_FIELDS.include, "appStoreVersionLocalization"],
    });
    const placement = shapePlacement(response, response.data);
    if (
      !(PLACEMENT_TYPES as readonly string[]).includes(
        placement.placementType ?? "",
      )
    ) {
      throw new InvalidInputError(
        `${id} is a ${placement.placementType} placement, not a screenshot or app preview.`,
      );
    }
    // Custom product pages and experiments have placements of the same types.
    const localizationId =
      response.data.relationships?.appStoreVersionLocalization?.data?.id;
    if (!localizationId) {
      throw new InvalidInputError(
        `${id} is not on an App Store version localization, so this command does not remove it.`,
      );
    }
    let parent = versions.get(localizationId);
    if (!parent) {
      const { data: localization } = await client.get<{
        data: AscResource<{ locale?: string }>;
      }>(`/v1/appStoreVersionLocalizations/${localizationId}`, {
        "fields[appStoreVersionLocalizations]": ["locale", "appStoreVersion"],
        include: "appStoreVersion",
      });
      const versionId = localization.relationships?.appStoreVersion?.data?.id;
      if (!versionId) {
        throw new UnexpectedResponseError(
          "App Store Connect did not say which version the placement belongs to.",
        );
      }
      const version = await editableVersion(client, versionId);
      parent = {
        versionId,
        version: version.version,
        locale: localization.attributes?.locale,
      };
      versions.set(localizationId, parent);
    }
    placements.push({ ...placement, ...parent });
  }
  if (!input.yes) {
    return { dryRun: true, action: "delete", placements };
  }
  for (const { id } of placements) {
    await client.delete(`/v1/appAssetLibraryPlacements/${id}`);
  }
  return {
    dryRun: false,
    action: "delete",
    deleted: placements.map(({ id }) => id),
  };
}
