import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import * as z from "zod";
import type {
  AscClient,
  AscDocument,
  AscResource,
  UploadOperation,
} from "../asc/client.ts";
import { appIdSchema, commaList, idSchema } from "../schemas/common.ts";
import {
  AscApiError,
  classifyError,
  InvalidInputError,
  NotEditableError,
  NotFoundError,
  UnexpectedResponseError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import { imageSize } from "./screenshots.ts";

/**
 * Game Center leaderboards, leaderboard sets and achievements, through
 * Apple's v2 resources (the v1 ones are deprecated). Each is a resource with
 * numbered versions; a version holds one localization per locale, and each
 * localization at most one image. A version that is live cannot change, so
 * changing a live item's names or images starts a new version, which goes
 * live after App Review. An app in a Game Center group shares the group's
 * leaderboards, sets and achievements, so they are read and created there.
 */

export const FORMATTERS = [
  "INTEGER",
  "DECIMAL_POINT_1_PLACE",
  "DECIMAL_POINT_2_PLACE",
  "DECIMAL_POINT_3_PLACE",
  "ELAPSED_TIME_CENTISECOND",
  "ELAPSED_TIME_MINUTE",
  "ELAPSED_TIME_SECOND",
  "MONEY_POUND_DECIMAL",
  "MONEY_POUND",
  "MONEY_DOLLAR_DECIMAL",
  "MONEY_DOLLAR",
  "MONEY_EURO_DECIMAL",
  "MONEY_EURO",
  "MONEY_FRANC_DECIMAL",
  "MONEY_FRANC",
  "MONEY_KRONER_DECIMAL",
  "MONEY_KRONER",
  "MONEY_YEN",
] as const;

export const SORT_TYPES = ["ASC", "DESC"] as const;
export const SUBMISSION_TYPES = ["BEST_SCORE", "MOST_RECENT_SCORE"] as const;
export const VISIBILITIES = ["SHOW_FOR_ALL", "HIDE_FOR_ALL"] as const;

/**
 * Version states whose names and images can change.
 *
 * Assumption: Apple's API lists the states but not which accept changes;
 * this follows App Store Connect, where an item is edited before review or
 * after a rejection.
 */
const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
]);

/**
 * Version states after which changes need a new version.
 *
 * Assumption: Apple's docs do not say whether a new version starts from the
 * live version's localizations and images; App Store Connect does, so the
 * commands read the new version's localizations after creating it.
 */
const RELEASED_STATES = new Set(["LIVE", "REPLACED_WITH_NEW_VERSION"]);

/** Local id for a version created inline with its leaderboard, set or achievement. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: Apple's syntax for an id local to one request.
const NEW_VERSION = "${new-version}";

/** What differs between leaderboards, leaderboard sets and achievements. */
export interface GameCenterKind {
  /** What messages call one, such as "leaderboard". */
  label: string;
  /** The command that lists and shows them. */
  command: string;
  type: string;
  /** The V2 relationship on gameCenterDetails and gameCenterGroups. */
  listRelation: string;
  fields: readonly string[];
  versionType: string;
  /** The version's relationship to its item. */
  versionParent: string;
  localizationType: string;
  localizationFields: readonly string[];
  /** Localization fields Apple needs to create one. */
  requiredFields: readonly string[];
  imageType: string;
  /** Whether a live item can be archived instead of deleted. */
  archivable: boolean;
}

export const LEADERBOARD: GameCenterKind = {
  label: "leaderboard",
  command: "game-center leaderboards",
  type: "gameCenterLeaderboards",
  listRelation: "gameCenterLeaderboardsV2",
  fields: [
    "referenceName",
    "vendorIdentifier",
    "defaultFormatter",
    "submissionType",
    "scoreSortType",
    "scoreRangeStart",
    "scoreRangeEnd",
    "recurrenceStartDate",
    "recurrenceDuration",
    "recurrenceRule",
    "visibility",
    "archived",
  ],
  versionType: "gameCenterLeaderboardVersions",
  versionParent: "leaderboard",
  localizationType: "gameCenterLeaderboardLocalizations",
  localizationFields: [
    "name",
    "description",
    "formatterOverride",
    "formatterSuffix",
    "formatterSuffixSingular",
  ],
  requiredFields: ["name"],
  imageType: "gameCenterLeaderboardImages",
  archivable: true,
};

export const LEADERBOARD_SET: GameCenterKind = {
  label: "leaderboard set",
  command: "game-center leaderboard-sets",
  type: "gameCenterLeaderboardSets",
  listRelation: "gameCenterLeaderboardSetsV2",
  fields: ["referenceName", "vendorIdentifier"],
  versionType: "gameCenterLeaderboardSetVersions",
  versionParent: "leaderboardSet",
  localizationType: "gameCenterLeaderboardSetLocalizations",
  localizationFields: ["name"],
  requiredFields: ["name"],
  imageType: "gameCenterLeaderboardSetImages",
  archivable: false,
};

export const ACHIEVEMENT: GameCenterKind = {
  label: "achievement",
  command: "game-center achievements",
  type: "gameCenterAchievements",
  listRelation: "gameCenterAchievementsV2",
  fields: [
    "referenceName",
    "vendorIdentifier",
    "points",
    "showBeforeEarned",
    "repeatable",
    "archived",
  ],
  versionType: "gameCenterAchievementVersions",
  versionParent: "achievement",
  localizationType: "gameCenterAchievementLocalizations",
  localizationFields: [
    "name",
    "beforeEarnedDescription",
    "afterEarnedDescription",
  ],
  requiredFields: ["name", "beforeEarnedDescription", "afterEarnedDescription"],
  imageType: "gameCenterAchievementImages",
  archivable: true,
};

type Attributes = Record<string, unknown>;
type Text = Record<string, string | undefined>;

type Ref = { type: string; id: string };

/** A resource whose relationships may be to-many, as a response carries them. */
interface Resource {
  type: string;
  id: string;
  attributes?: Attributes;
  relationships?: Record<string, { data?: Ref | Ref[] | null } | undefined>;
}

/** An item's id and the attributes its kind lists. */
type Item = { id: string } & Record<string, unknown>;

interface Version {
  id: string;
  version: number | null;
  state: string | null;
}

/** Copies only the named attributes, so nothing unexpected reaches the output. */
function pick(attributes: Attributes | undefined, fields: readonly string[]) {
  return Object.fromEntries(
    fields.map((field) => [field, attributes?.[field] ?? null]),
  );
}

function shapeItem(kind: GameCenterKind, { id, attributes }: Resource): Item {
  return { id, ...pick(attributes, kind.fields) };
}

function shapeVersion({ id, attributes }: AscResource<Attributes>): Version {
  return {
    id,
    version:
      typeof attributes?.version === "number" ? attributes.version : null,
    state: typeof attributes?.state === "string" ? attributes.state : null,
  };
}

/** Newest first. */
const byVersion = (a: Version, b: Version) =>
  (b.version ?? 0) - (a.version ?? 0);

/** Where an app's Game Center items live: its own Game Center detail, or its group's. */
interface Owner {
  detailId: string;
  arcadeEnabled: boolean | null;
  group: { id: string; referenceName: string | null } | null;
  path: string;
  relationship: { name: string; type: string; id: string };
}

async function readOwner(
  client: AscClient,
  appId: string,
): Promise<Owner | null> {
  let response: { data: Resource | null; included?: AscResource<Attributes>[] };
  try {
    response = await client.get(`/v1/apps/${appId}/gameCenterDetail`, {
      "fields[gameCenterDetails]": ["arcadeEnabled", "gameCenterGroup"],
      include: "gameCenterGroup",
      "fields[gameCenterGroups]": ["referenceName"],
    });
  } catch (error) {
    // Assumption: Apple answers 404, or no data, for an app without Game Center.
    if (error instanceof AscApiError && error.status === 404) return null;
    throw error;
  }
  const detail = response.data;
  if (!detail) return null;
  const ref = detail.relationships?.gameCenterGroup?.data;
  const groupRef = ref && !Array.isArray(ref) ? ref : undefined;
  const group = groupRef
    ? {
        id: groupRef.id,
        referenceName:
          (response.included?.find(
            (item) =>
              item.type === "gameCenterGroups" && item.id === groupRef.id,
          )?.attributes?.referenceName as string | undefined) ?? null,
      }
    : null;
  return {
    detailId: detail.id,
    arcadeEnabled:
      typeof detail.attributes?.arcadeEnabled === "boolean"
        ? detail.attributes.arcadeEnabled
        : null,
    group,
    path: group
      ? `/v1/gameCenterGroups/${group.id}`
      : `/v1/gameCenterDetails/${detail.id}`,
    relationship: group
      ? { name: "gameCenterGroup", type: "gameCenterGroups", id: group.id }
      : { name: "gameCenterDetail", type: "gameCenterDetails", id: detail.id },
  };
}

async function requireOwner(client: AscClient, appId: string) {
  const owner = await readOwner(client, appId);
  if (!owner) {
    throw new NotFoundError(
      `App ${appId} does not have Game Center set up; turn it on in App Store Connect first.`,
    );
  }
  return owner;
}

/** One page (up to 200) of the owner's items, each with its newest version. */
async function listItems(
  client: AscClient,
  owner: Owner,
  kind: GameCenterKind,
) {
  const response = await client.get<
    AscDocument<Attributes> & { data: Resource[] }
  >(`${owner.path}/${kind.listRelation}`, {
    [`fields[${kind.type}]`]: [...kind.fields, "versions"],
    include: "versions",
    [`fields[${kind.versionType}]`]: ["version", "state"],
    // Assumption: 50 is the most versions Apple includes per item; the newest is among those included.
    "limit[versions]": 50,
    limit: 200,
  });
  const versions = new Map(
    (response.included ?? [])
      .filter((item) => item.type === kind.versionType)
      .map((item) => [item.id, shapeVersion(item)]),
  );
  return {
    items: response.data.map((item): Item => {
      const refs = item.relationships?.versions?.data;
      const latest = (Array.isArray(refs) ? refs : [])
        .map((ref) => versions.get(ref.id))
        .filter((version): version is Version => version !== undefined)
        .sort(byVersion)[0];
      return {
        ...shapeItem(kind, item),
        latestVersion: latest
          ? { version: latest.version, state: latest.state }
          : null,
      };
    }),
    total: response.meta?.paging?.total ?? response.data.length,
    hasMore: response.links?.next !== undefined,
  };
}

export const gameCenterInput = z.object({ appId: appIdSchema });

/**
 * Whether the app has Game Center, the group it shares items with, and its
 * leaderboards, leaderboard sets and achievements with each one's newest
 * version and state.
 */
export async function getGameCenter(
  client: AscClient,
  input: z.output<typeof gameCenterInput>,
) {
  const owner = await readOwner(client, input.appId);
  if (!owner) return { appId: input.appId, enabled: false };
  return {
    appId: input.appId,
    enabled: true,
    gameCenterDetailId: owner.detailId,
    arcadeEnabled: owner.arcadeEnabled,
    group: owner.group,
    leaderboards: await listItems(client, owner, LEADERBOARD),
    leaderboardSets: await listItems(client, owner, LEADERBOARD_SET),
    achievements: await listItems(client, owner, ACHIEVEMENT),
  };
}

async function readItem(client: AscClient, kind: GameCenterKind, id: string) {
  try {
    const { data } = await client.get<{ data: Resource }>(
      `/v2/${kind.type}/${id}`,
      {
        [`fields[${kind.type}]`]: kind.fields,
      },
    );
    return shapeItem(kind, data);
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) {
      throw new NotFoundError(
        `There is no Game Center ${kind.label} ${id}; game-center <app-id> lists them.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function listVersions(
  client: AscClient,
  kind: GameCenterKind,
  id: string,
) {
  const response = await client.get<AscDocument<Attributes>>(
    `/v2/${kind.type}/${id}/versions`,
    { [`fields[${kind.versionType}]`]: ["version", "state"], limit: 200 },
  );
  return response.data.map(shapeVersion).sort(byVersion);
}

function shapeLocalization(
  kind: GameCenterKind,
  { id, attributes }: AscResource<Attributes>,
) {
  return {
    id,
    locale: typeof attributes?.locale === "string" ? attributes.locale : "",
    ...pick(attributes, kind.localizationFields),
  };
}

type Localization = ReturnType<typeof shapeLocalization>;

async function listLocalizations(
  client: AscClient,
  kind: GameCenterKind,
  versionId: string,
): Promise<Localization[]> {
  // One localization per Game Center locale, fewer than a page of 200.
  const response = await client.get<AscDocument<Attributes>>(
    `/v2/${kind.versionType}/${versionId}/localizations`,
    {
      [`fields[${kind.localizationType}]`]: [
        "locale",
        ...kind.localizationFields,
      ],
      limit: 200,
    },
  );
  return response.data.map((item) => shapeLocalization(kind, item));
}

interface ImageAttributes {
  fileName?: string;
  fileSize?: number;
  imageAsset?: { width?: number; height?: number } | null;
  assetDeliveryState?: { state?: string } | null;
  uploadOperations?: UploadOperation[] | null;
}

async function readImage(
  client: AscClient,
  kind: GameCenterKind,
  localizationId: string,
) {
  let response: { data: AscResource<ImageAttributes> | null };
  try {
    response = await client.get(
      `/v2/${kind.localizationType}/${localizationId}/image`,
      {
        [`fields[${kind.imageType}]`]: [
          "fileName",
          "fileSize",
          "imageAsset",
          "assetDeliveryState",
        ],
      },
    );
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) return null;
    throw error;
  }
  const image = response.data;
  if (!image) return null;
  return {
    id: image.id,
    fileName: image.attributes?.fileName ?? null,
    fileSize: image.attributes?.fileSize ?? null,
    width: image.attributes?.imageAsset?.width ?? null,
    height: image.attributes?.imageAsset?.height ?? null,
    state: image.attributes?.assetDeliveryState?.state ?? null,
  };
}

export const itemInput = z.object({
  id: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9-]{1,100}$/,
      "Must be an id from the game-center command.",
    ),
});

/** One leaderboard, set or achievement: its versions, and the newest version's localizations and images. */
export function showItem(kind: GameCenterKind) {
  return async (client: AscClient, input: z.output<typeof itemInput>) => {
    const item = await readItem(client, kind, input.id);
    const versions = await listVersions(client, kind, input.id);
    const latest = versions[0];
    const localizations = [];
    for (const localization of latest
      ? await listLocalizations(client, kind, latest.id)
      : []) {
      localizations.push({
        ...localization,
        image: await readImage(client, kind, localization.id),
      });
    }
    const members =
      kind === LEADERBOARD_SET
        ? await listMembers(client, input.id)
        : undefined;
    return {
      [camel(kind.label)]: item,
      ...(members ? { leaderboards: members } : {}),
      versions,
      localizations,
    };
  };
}

function camel(label: string) {
  return label.replace(/ (\w)/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * The version that takes a change of names or images: the newest when it is
 * editable, or a new one to create when the newest is live. A version in
 * review or waiting for release takes none.
 */
async function targetVersion(
  client: AscClient,
  kind: GameCenterKind,
  item: { id: string; referenceName?: unknown },
) {
  const versions = await listVersions(client, kind, item.id);
  const latest = versions[0];
  if (latest && EDITABLE_STATES.has(latest.state ?? "")) {
    return { version: latest, create: false };
  }
  if (!latest || RELEASED_STATES.has(latest.state ?? "")) {
    return { version: latest, create: true };
  }
  throw new NotEditableError(
    `Game Center ${kind.label} ${item.referenceName ?? item.id} has version ${latest.version} ${latest.state}, so its names and images cannot change until App Review finishes and it is live.`,
  );
}

/** Creates a new version and returns its id. */
async function createVersion(
  client: AscClient,
  kind: GameCenterKind,
  itemId: string,
) {
  const created = await client.post<{ data: AscResource<Attributes> }>(
    `/v2/${kind.versionType}`,
    {
      data: {
        type: kind.versionType,
        relationships: {
          [kind.versionParent]: { data: { type: kind.type, id: itemId } },
        },
      },
    },
  );
  return shapeVersion(created.data);
}

/** The given localization fields, leaving out those not given. */
function given(kind: GameCenterKind, text: Text) {
  return Object.fromEntries(
    kind.localizationFields
      .filter((field) => text[field] !== undefined)
      .map((field) => [field, text[field] as string]),
  );
}

function missingFields(kind: GameCenterKind, text: Text) {
  return kind.requiredFields.filter((field) => text[field] === undefined);
}

async function saveLocalization(
  client: AscClient,
  kind: GameCenterKind,
  versionId: string,
  locale: string,
  text: Record<string, string>,
  existing: Localization | undefined,
) {
  const response = existing
    ? await client.patch<{ data: AscResource<Attributes> }>(
        `/v2/${kind.localizationType}/${existing.id}`,
        {
          data: {
            type: kind.localizationType,
            id: existing.id,
            attributes: text,
          },
        },
      )
    : await client.post<{ data: AscResource<Attributes> }>(
        `/v2/${kind.localizationType}`,
        {
          data: {
            type: kind.localizationType,
            attributes: { locale, ...text },
            relationships: {
              version: { data: { type: kind.versionType, id: versionId } },
            },
          },
        },
      );
  return shapeLocalization(kind, response.data);
}

interface CreateRequest {
  appId: string;
  attributes: Attributes;
  relationships?: Record<string, unknown>;
  locale?: string;
  text: Text;
  yes: boolean;
}

/**
 * Creates an item with its first version on the app's Game Center detail,
 * or on its group when it has one, then that version's first localization
 * when a locale is given.
 */
async function createItem(
  client: AscClient,
  kind: GameCenterKind,
  request: CreateRequest,
) {
  const owner = await requireOwner(client, request.appId);
  const text = given(kind, request.text);
  if (!request.yes) {
    const existing = await listItems(client, owner, kind);
    const duplicate = existing.items.find(
      (item) => item.vendorIdentifier === request.attributes.vendorIdentifier,
    );
    if (duplicate) {
      throw new InvalidInputError(
        `Game Center ${kind.label} ${duplicate.id} already has the vendor identifier ${String(request.attributes.vendorIdentifier)}.`,
      );
    }
    return {
      dryRun: true,
      action: "create",
      appId: request.appId,
      owner: owner.group
        ? { group: owner.group }
        : { gameCenterDetailId: owner.detailId },
      [camel(kind.label)]: request.attributes,
      localization: request.locale ? { locale: request.locale, ...text } : null,
      existing: existing.total,
    };
  }
  const created = await client.post<{ data: Resource }>(`/v2/${kind.type}`, {
    data: {
      type: kind.type,
      attributes: request.attributes,
      relationships: {
        [owner.relationship.name]: {
          data: { type: owner.relationship.type, id: owner.relationship.id },
        },
        versions: { data: [{ type: kind.versionType, id: NEW_VERSION }] },
        ...request.relationships,
      },
    },
    included: [{ type: kind.versionType, id: NEW_VERSION }],
  });
  const itemId = created.data.id;
  let localization = null;
  if (request.locale) {
    try {
      const [version] = await listVersions(client, kind, itemId);
      if (!version) {
        throw new UnexpectedResponseError(
          `App Store Connect created ${kind.label} ${itemId} without a version.`,
        );
      }
      localization = await saveLocalization(
        client,
        kind,
        version.id,
        request.locale,
        text,
        undefined,
      );
    } catch (error) {
      throw new UploadIncompleteError(
        `Game Center ${kind.label} ${itemId} was created but its ${request.locale} localization was not saved; add it with ${kind.command} set ${itemId} --locale ${request.locale}.`,
        { cause: error },
      );
    }
  }
  return {
    dryRun: false,
    action: "create",
    [camel(kind.label)]: shapeItem(kind, created.data),
    localization,
  };
}

interface SetRequest {
  id: string;
  attributes: Attributes;
  locale?: string;
  text: Text;
  yes: boolean;
}

/**
 * Changes an item's attributes and one locale's localization. A localization
 * change goes to the editable version, or a new version when the newest is
 * live.
 */
async function setItem(
  client: AscClient,
  kind: GameCenterKind,
  request: SetRequest,
) {
  const item = await readItem(client, kind, request.id);
  const attributes = Object.fromEntries(
    Object.entries(request.attributes).filter(
      ([field, value]) => value !== undefined && item[field] !== value,
    ),
  );
  const text = given(kind, request.text);
  let localized: {
    target: Awaited<ReturnType<typeof targetVersion>>;
    current: Localization | undefined;
  } | null = null;
  if (request.locale) {
    const target = await targetVersion(client, kind, item);
    const current = target.version
      ? (await listLocalizations(client, kind, target.version.id)).find(
          (localization) => localization.locale === request.locale,
        )
      : undefined;
    const missing = current ? [] : missingFields(kind, text);
    if (missing.length > 0) {
      throw new InvalidInputError(
        `Game Center ${kind.label} ${item.referenceName} has no ${request.locale} localization yet, so give ${missing.map(flag).join(", ")} to add it.`,
      );
    }
    localized = { target, current };
  }
  const textChanges = localized
    ? Object.fromEntries(
        Object.entries(text).filter(
          ([field, value]) =>
            (localized?.current as Record<string, unknown> | undefined)?.[
              field
            ] !== value,
        ),
      )
    : {};
  const changes =
    Object.keys(attributes).length > 0 || Object.keys(textChanges).length > 0;
  if (!request.yes) {
    return {
      dryRun: true,
      action: "set",
      [camel(kind.label)]: item,
      attributes,
      localization: localized
        ? {
            locale: request.locale,
            newLocale: !localized.current,
            newVersion:
              localized.target.create && Object.keys(textChanges).length > 0,
            current: localized.current
              ? pick(localized.current, Object.keys(text))
              : null,
            update: textChanges,
          }
        : null,
      changes,
    };
  }
  if (Object.keys(attributes).length > 0) {
    await client.patch(`/v2/${kind.type}/${request.id}`, {
      data: { type: kind.type, id: request.id, attributes },
    });
  }
  let localization = null;
  let newVersion = null;
  if (localized && request.locale && Object.keys(textChanges).length > 0) {
    let versionId = localized.target.version?.id;
    let current = localized.current;
    if (localized.target.create) {
      newVersion = await createVersion(client, kind, request.id);
      versionId = newVersion.id;
      current = (await listLocalizations(client, kind, versionId)).find(
        (item) => item.locale === request.locale,
      );
    }
    if (!versionId) {
      throw new UnexpectedResponseError(
        `Game Center ${kind.label} ${request.id} has no version to change.`,
      );
    }
    const missing = current ? [] : missingFields(kind, text);
    if (missing.length > 0) {
      throw new UploadIncompleteError(
        `Created version ${newVersion?.version} of ${kind.label} ${request.id} without a ${request.locale} localization; give ${missing.map(flag).join(", ")} to add it.`,
      );
    }
    localization = await saveLocalization(
      client,
      kind,
      versionId,
      request.locale,
      current ? textChanges : text,
      current,
    );
  }
  return {
    dryRun: false,
    action: "set",
    id: request.id,
    attributes: Object.keys(attributes),
    newVersion,
    localization,
  };
}

/** The command-line flag for a localization field. */
function flag(field: string) {
  return `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/**
 * Deletes a leaderboard, set or achievement. Without `yes`, shows it with
 * its newest version.
 */
export function deleteItem(kind: GameCenterKind) {
  return async (
    client: AscClient,
    input: z.output<typeof itemInput> & { yes: boolean },
  ) => {
    const item = await readItem(client, kind, input.id);
    if (!input.yes) {
      const [latest] = await listVersions(client, kind, input.id);
      return {
        dryRun: true,
        action: "delete",
        [camel(kind.label)]: item,
        latestVersion: latest ?? null,
      };
    }
    await client
      .delete(`/v2/${kind.type}/${input.id}`)
      .catch((error: unknown) => {
        if (
          error instanceof AscApiError &&
          (error.status === 409 || error.status === 422)
        ) {
          const instead = kind.archivable
            ? ` One that has been live can be archived instead with ${kind.command} set ${input.id} --archived true.`
            : "";
          throw new InvalidInputError(
            `App Store Connect would not delete Game Center ${kind.label} ${item.referenceName}.${instead} ${classifyError(error).message}`,
            { cause: error },
          );
        }
        throw error;
      });
    return { dryRun: false, action: "delete", id: input.id };
  };
}

export const itemWriteInput = itemInput.extend({
  yes: z.boolean().default(false),
});

export const deleteLocaleInput = itemWriteInput.extend({
  locale: z
    .string({ error: "Give the language with --locale, such as en-US." })
    .trim()
    .regex(
      /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
      "Must be a locale such as en-US.",
    ),
});

/**
 * Removes one locale's localization, with its image, from the editable
 * version, or from a new version when the newest is live.
 */
export function deleteLocale(kind: GameCenterKind) {
  return async (
    client: AscClient,
    input: z.output<typeof deleteLocaleInput>,
  ) => {
    const item = await readItem(client, kind, input.id);
    const target = await targetVersion(client, kind, item);
    const current = target.version
      ? (await listLocalizations(client, kind, target.version.id)).find(
          (localization) => localization.locale === input.locale,
        )
      : undefined;
    if (!current) {
      throw new NotFoundError(
        `Game Center ${kind.label} ${item.referenceName} has no ${input.locale} localization; ${kind.command} show ${input.id} lists them.`,
      );
    }
    if (!input.yes) {
      return {
        dryRun: true,
        action: "delete-locale",
        [camel(kind.label)]: item,
        newVersion: target.create,
        localization: current,
      };
    }
    let localizationId = current.id;
    let newVersion = null;
    if (target.create) {
      newVersion = await createVersion(client, kind, input.id);
      const copied = (
        await listLocalizations(client, kind, newVersion.id)
      ).find((localization) => localization.locale === input.locale);
      if (!copied) {
        return {
          dryRun: false,
          action: "delete-locale",
          id: input.id,
          newVersion,
        };
      }
      localizationId = copied.id;
    }
    await client.delete(`/v2/${kind.localizationType}/${localizationId}`);
    return {
      dryRun: false,
      action: "delete-locale",
      id: input.id,
      newVersion,
      locale: input.locale,
    };
  };
}

export const uploadImageInput = deleteLocaleInput.extend({
  file: z
    .string({ error: "Give the image with --file." })
    .trim()
    .min(1, "Give the image with --file."),
});

/**
 * Uploads one locale's image, replacing the one it has: the file is
 * reserved, sent in the parts Apple's reservation lists and committed.
 * Without `yes`, shows the file and the image it replaces.
 */
export function uploadImage(kind: GameCenterKind) {
  return async (
    client: AscClient,
    input: z.output<typeof uploadImageInput>,
  ) => {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(await readFile(input.file));
    } catch (error) {
      throw new InvalidInputError(`Could not read the --file ${input.file}.`, {
        cause: error,
      });
    }
    const size = imageSize(bytes);
    if (!size) {
      throw new InvalidInputError(
        `${basename(input.file)} is not a PNG or JPEG image.`,
      );
    }
    const item = await readItem(client, kind, input.id);
    const target = await targetVersion(client, kind, item);
    const current = target.version
      ? (await listLocalizations(client, kind, target.version.id)).find(
          (localization) => localization.locale === input.locale,
        )
      : undefined;
    if (!current) {
      throw new InvalidInputError(
        `Game Center ${kind.label} ${item.referenceName} has no ${input.locale} localization; add it with ${kind.command} set ${input.id} --locale ${input.locale} first.`,
      );
    }
    const existing = await readImage(client, kind, current.id);
    const file = {
      fileName: basename(input.file),
      fileSize: bytes.length,
      width: size.width,
      height: size.height,
    };
    if (!input.yes) {
      return {
        dryRun: true,
        action: "upload-image",
        [camel(kind.label)]: item,
        locale: input.locale,
        newVersion: target.create,
        file,
        replaces: existing,
      };
    }
    let localizationId = current.id;
    let replaced = existing;
    let newVersion = null;
    if (target.create) {
      newVersion = await createVersion(client, kind, input.id);
      const copied = (
        await listLocalizations(client, kind, newVersion.id)
      ).find((localization) => localization.locale === input.locale);
      if (!copied) {
        throw new UploadIncompleteError(
          `Created version ${newVersion.version} of ${kind.label} ${input.id} without a ${input.locale} localization; add it with ${kind.command} set, then upload the image again.`,
        );
      }
      localizationId = copied.id;
      replaced = await readImage(client, kind, localizationId);
    }
    // A localization holds one image, so the old one goes first.
    if (replaced) await client.delete(`/v2/${kind.imageType}/${replaced.id}`);
    const reserved = await client.post<{ data: AscResource<ImageAttributes> }>(
      `/v2/${kind.imageType}`,
      {
        data: {
          type: kind.imageType,
          attributes: { fileName: file.fileName, fileSize: file.fileSize },
          relationships: {
            localization: {
              data: { type: kind.localizationType, id: localizationId },
            },
          },
        },
      },
    );
    try {
      const operations = reserved.data.attributes?.uploadOperations ?? [];
      if (operations.length === 0) {
        throw new UnexpectedResponseError(
          "App Store Connect reserved the image but gave no upload operations.",
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
      await client.patch(`/v2/${kind.imageType}/${reserved.data.id}`, {
        data: {
          type: kind.imageType,
          id: reserved.data.id,
          attributes: { uploaded: true },
        },
      });
    } catch (error) {
      throw new UploadIncompleteError(
        `The ${input.locale} image of ${kind.label} ${input.id} was reserved (${reserved.data.id}) but not uploaded${replaced ? " and the old one was already removed" : ""}; upload it again.`,
        { cause: error },
      );
    }
    return {
      dryRun: false,
      action: "upload-image",
      id: input.id,
      locale: input.locale,
      newVersion,
      imageId: reserved.data.id,
      replaced: replaced?.id ?? null,
    };
  };
}

async function listMembers(client: AscClient, setId: string) {
  const response = await client.get<AscDocument<Attributes>>(
    `/v2/gameCenterLeaderboardSets/${setId}/gameCenterLeaderboards`,
    {
      "fields[gameCenterLeaderboards]": ["referenceName", "vendorIdentifier"],
      limit: 200,
    },
  );
  return response.data.map(({ id, attributes }) => ({
    id,
    referenceName: attributes?.referenceName ?? null,
    vendorIdentifier: attributes?.vendorIdentifier ?? null,
  }));
}

// Inputs shared by the create and set commands.
const text = z.string().trim().min(1).optional();
const booleanText = z
  .enum(["true", "false"], { error: "Must be true or false." })
  .transform((value) => value === "true")
  .optional();
const score = z
  .string()
  .trim()
  .regex(/^-?\d{1,19}$/, "Must be a whole number.")
  .optional();
const referenceName = z.string().trim().min(1).max(64).optional();
const vendorIdentifier = z
  .string({ error: "Give the identifier the game uses with --vendor-id." })
  .trim()
  .min(1, "Give the identifier the game uses with --vendor-id.")
  .max(100);
const requiredReferenceName = z
  .string({
    error: "Give the name in App Store Connect with --reference-name.",
  })
  .trim()
  .min(1, "Give the name in App Store Connect with --reference-name.")
  .max(64);
const optionalLocale = deleteLocaleInput.shape.locale.optional();
const leaderboardIds = commaList(idSchema("game-center"));

/** Localization fields need a locale, and a locale needs a field to set. */
function localeRefinement(kind: GameCenterKind) {
  return (input: Record<string, unknown>, context: z.RefinementCtx) => {
    const hasText = kind.localizationFields.some(
      (field) => input[field] !== undefined,
    );
    if (hasText && input.locale === undefined) {
      context.addIssue({
        code: "custom",
        message: "Give --locale with the localization to set, such as en-US.",
      });
    }
    if (!hasText && input.locale !== undefined) {
      context.addIssue({
        code: "custom",
        message: `Give ${kind.localizationFields.map(flag).join(", ")} or more for --locale.`,
      });
    }
  };
}

function textOf(kind: GameCenterKind, input: Record<string, unknown>): Text {
  return Object.fromEntries(
    kind.localizationFields.map((field) => [
      field,
      input[field] as string | undefined,
    ]),
  );
}

const leaderboardText = {
  locale: optionalLocale,
  name: text,
  description: text,
  formatterOverride: z.enum(FORMATTERS).optional(),
  formatterSuffix: text,
  formatterSuffixSingular: text,
};

const recurrence = {
  recurrenceStart: z.iso
    .datetime({
      offset: true,
      error: "Must be a date and time such as 2026-12-01T00:00:00Z.",
    })
    .optional(),
  recurrenceDuration: z
    .string()
    .trim()
    .regex(/^P[0-9YMWDTHS.]+$/, "Must be an ISO 8601 duration such as P7D.")
    .optional(),
  recurrenceRule: z.string().trim().min(1).optional(),
};

function leaderboardAttributes(input: {
  referenceName?: string;
  formatter?: string;
  sort?: string;
  submissionType?: string;
  scoreRangeStart?: string;
  scoreRangeEnd?: string;
  visibility?: string;
  recurrenceStart?: string;
  recurrenceDuration?: string;
  recurrenceRule?: string;
}) {
  return {
    referenceName: input.referenceName,
    defaultFormatter: input.formatter,
    scoreSortType: input.sort,
    submissionType: input.submissionType,
    scoreRangeStart: input.scoreRangeStart,
    scoreRangeEnd: input.scoreRangeEnd,
    visibility: input.visibility,
    recurrenceStartDate: input.recurrenceStart,
    recurrenceDuration: input.recurrenceDuration,
    recurrenceRule: input.recurrenceRule,
  };
}

export const createLeaderboardInput = z
  .object({
    appId: appIdSchema,
    vendorId: vendorIdentifier,
    referenceName: requiredReferenceName,
    formatter: z.enum(FORMATTERS, {
      error: `Give the score format with --formatter: ${FORMATTERS.join(", ")}.`,
    }),
    sort: z.enum(SORT_TYPES, {
      error:
        "Give the order with --sort: DESC for high scores first, ASC for low.",
    }),
    submissionType: z.enum(SUBMISSION_TYPES).default("BEST_SCORE"),
    scoreRangeStart: score,
    scoreRangeEnd: score,
    visibility: z.enum(VISIBILITIES).optional(),
    ...recurrence,
    ...leaderboardText,
    yes: z.boolean().default(false),
  })
  .superRefine(localeRefinement(LEADERBOARD))
  .superRefine((input, context) => {
    if (input.locale !== undefined && input.name === undefined) {
      context.addIssue({
        code: "custom",
        message: "Give --name for the locale.",
      });
    }
  });

/** Creates a leaderboard, with its first locale when given. */
export async function createLeaderboard(
  client: AscClient,
  input: z.output<typeof createLeaderboardInput>,
) {
  return createItem(client, LEADERBOARD, {
    appId: input.appId,
    attributes: withoutUndefined({
      vendorIdentifier: input.vendorId,
      ...leaderboardAttributes(input),
    }),
    locale: input.locale,
    text: textOf(LEADERBOARD, input),
    yes: input.yes,
  });
}

export const setLeaderboardInput = z
  .object({
    id: itemInput.shape.id,
    referenceName,
    formatter: z.enum(FORMATTERS).optional(),
    sort: z.enum(SORT_TYPES).optional(),
    submissionType: z.enum(SUBMISSION_TYPES).optional(),
    scoreRangeStart: score,
    scoreRangeEnd: score,
    visibility: z.enum(VISIBILITIES).optional(),
    archived: booleanText,
    ...recurrence,
    ...leaderboardText,
    yes: z.boolean().default(false),
  })
  .superRefine(localeRefinement(LEADERBOARD))
  .superRefine(nothingToSet);

/** Changes a leaderboard's attributes and one locale's name, description and score format. */
export async function setLeaderboard(
  client: AscClient,
  input: z.output<typeof setLeaderboardInput>,
) {
  return setItem(client, LEADERBOARD, {
    id: input.id,
    attributes: { ...leaderboardAttributes(input), archived: input.archived },
    locale: input.locale,
    text: textOf(LEADERBOARD, input),
    yes: input.yes,
  });
}

function nothingToSet(
  input: Record<string, unknown>,
  context: z.RefinementCtx,
) {
  const given = Object.entries(input).some(
    ([key, value]) => !["id", "yes"].includes(key) && value !== undefined,
  );
  if (!given) {
    context.addIssue({
      code: "custom",
      message: "Give at least one thing to change.",
    });
  }
}

function withoutUndefined(attributes: Attributes) {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  );
}

export const createLeaderboardSetInput = z
  .object({
    appId: appIdSchema,
    vendorId: vendorIdentifier,
    referenceName: requiredReferenceName,
    leaderboards: leaderboardIds,
    locale: optionalLocale,
    name: text,
    yes: z.boolean().default(false),
  })
  .superRefine(localeRefinement(LEADERBOARD_SET));

/** Creates a leaderboard set, with its leaderboards and first locale when given. */
export async function createLeaderboardSet(
  client: AscClient,
  input: z.output<typeof createLeaderboardSetInput>,
) {
  return createItem(client, LEADERBOARD_SET, {
    appId: input.appId,
    attributes: {
      vendorIdentifier: input.vendorId,
      referenceName: input.referenceName,
    },
    relationships: input.leaderboards
      ? {
          gameCenterLeaderboards: {
            data: input.leaderboards.map((id) => ({
              type: "gameCenterLeaderboards",
              id,
            })),
          },
        }
      : undefined,
    locale: input.locale,
    text: { name: input.name },
    yes: input.yes,
  });
}

export const setLeaderboardSetInput = z
  .object({
    id: itemInput.shape.id,
    referenceName,
    locale: optionalLocale,
    name: text,
    yes: z.boolean().default(false),
  })
  .superRefine(localeRefinement(LEADERBOARD_SET))
  .superRefine(nothingToSet);

/** Changes a leaderboard set's reference name and one locale's name. */
export async function setLeaderboardSet(
  client: AscClient,
  input: z.output<typeof setLeaderboardSetInput>,
) {
  return setItem(client, LEADERBOARD_SET, {
    id: input.id,
    attributes: { referenceName: input.referenceName },
    locale: input.locale,
    text: { name: input.name },
    yes: input.yes,
  });
}

export const membersInput = itemWriteInput.extend({
  leaderboards: commaList(idSchema("game-center")).refine(
    (value) => value !== undefined,
    "Give the leaderboard ids with --leaderboards.",
  ),
});

/**
 * Adds leaderboards to a set, or removes them. Without `yes`, shows the set's
 * leaderboards and which would change.
 */
export function changeMembers(action: "add" | "remove") {
  return async (client: AscClient, input: z.output<typeof membersInput>) => {
    const set = await readItem(client, LEADERBOARD_SET, input.id);
    const members = await listMembers(client, input.id);
    const present = new Set(members.map((member) => member.id));
    const ids = [...new Set(input.leaderboards ?? [])].filter((id) =>
      action === "add" ? !present.has(id) : present.has(id),
    );
    if (!input.yes) {
      return {
        dryRun: true,
        action,
        leaderboardSet: set,
        leaderboards: members,
        [action === "add" ? "adding" : "removing"]: ids,
      };
    }
    if (ids.length > 0) {
      const path = `/v2/gameCenterLeaderboardSets/${input.id}/relationships/gameCenterLeaderboards`;
      const body = {
        data: ids.map((id) => ({ type: "gameCenterLeaderboards", id })),
      };
      if (action === "add") await client.post(path, body);
      else await client.delete(path, body);
    }
    return {
      dryRun: false,
      action,
      id: input.id,
      [action === "add" ? "added" : "removed"]: ids,
    };
  };
}

const points = z
  .number()
  .int()
  .min(1, "Must be 1 to 100 points.")
  .max(100, "Must be 1 to 100 points.");

const achievementText = {
  locale: optionalLocale,
  name: text,
  beforeEarnedDescription: text,
  afterEarnedDescription: text,
};

export const createAchievementInput = z
  .object({
    appId: appIdSchema,
    vendorId: vendorIdentifier,
    referenceName: requiredReferenceName,
    points: z.coerce.number({ error: "Give --points, 1 to 100." }).pipe(points),
    showBeforeEarned: booleanText.default(true),
    repeatable: booleanText.default(false),
    ...achievementText,
    yes: z.boolean().default(false),
  })
  .superRefine(localeRefinement(ACHIEVEMENT))
  .superRefine((input, context) => {
    if (input.locale === undefined) return;
    const missing = missingFields(ACHIEVEMENT, textOf(ACHIEVEMENT, input));
    if (missing.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Give ${missing.map(flag).join(", ")} for the locale.`,
      });
    }
  });

/** Creates an achievement, with its first locale when given. */
export async function createAchievement(
  client: AscClient,
  input: z.output<typeof createAchievementInput>,
) {
  return createItem(client, ACHIEVEMENT, {
    appId: input.appId,
    attributes: {
      vendorIdentifier: input.vendorId,
      referenceName: input.referenceName,
      points: input.points,
      showBeforeEarned: input.showBeforeEarned,
      repeatable: input.repeatable,
    },
    locale: input.locale,
    text: textOf(ACHIEVEMENT, input),
    yes: input.yes,
  });
}

export const setAchievementInput = z
  .object({
    id: itemInput.shape.id,
    referenceName,
    points: z.coerce.number().pipe(points).optional(),
    showBeforeEarned: booleanText,
    repeatable: booleanText,
    archived: booleanText,
    ...achievementText,
    yes: z.boolean().default(false),
  })
  .superRefine(localeRefinement(ACHIEVEMENT))
  .superRefine(nothingToSet);

/** Changes an achievement's attributes and one locale's name and descriptions. */
export async function setAchievement(
  client: AscClient,
  input: z.output<typeof setAchievementInput>,
) {
  return setItem(client, ACHIEVEMENT, {
    id: input.id,
    attributes: {
      referenceName: input.referenceName,
      points: input.points,
      showBeforeEarned: input.showBeforeEarned,
      repeatable: input.repeatable,
      archived: input.archived,
    },
    locale: input.locale,
    text: textOf(ACHIEVEMENT, input),
    yes: input.yes,
  });
}
