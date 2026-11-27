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
} from "../schemas/common.ts";
import { InvalidInputError, NotEditableError } from "../utils/errors.ts";

/**
 * Featuring nominations: asking Apple's editors to consider a new app, an
 * update or new content for featuring, a few weeks before it goes live.
 * Apple's /v1/nominations is team-wide; a nomination names its apps in
 * relatedApps.
 */

const nominationIdSchema = idSchema("nominations");

export const NOMINATION_STATES = ["DRAFT", "SUBMITTED", "ARCHIVED"] as const;
export const NOMINATION_TYPES = [
  "APP_LAUNCH",
  "APP_ENHANCEMENTS",
  "NEW_CONTENT",
] as const;
export const DEVICE_FAMILIES = [
  "IPHONE",
  "IPAD",
  "APPLE_TV",
  "APPLE_WATCH",
  "MAC",
  "VISION",
] as const;

interface NominationAttributes {
  name?: string;
  type?: string;
  description?: string;
  notes?: string | null;
  state?: string;
  publishStartDate?: string | null;
  publishEndDate?: string | null;
  deviceFamilies?: string[] | null;
  locales?: string[] | null;
  supplementalMaterialsUris?: string[] | null;
  hasInAppEvents?: boolean | null;
  launchInSelectMarketsFirst?: boolean | null;
  preOrderEnabled?: boolean | null;
  createdDate?: string | null;
  lastModifiedDate?: string | null;
  submittedDate?: string | null;
}

const NOMINATION_FIELDS = [
  "name",
  "type",
  "description",
  "notes",
  "state",
  "publishStartDate",
  "publishEndDate",
  "deviceFamilies",
  "locales",
  "supplementalMaterialsUris",
  "hasInAppEvents",
  "launchInSelectMarketsFirst",
  "preOrderEnabled",
  "createdDate",
  "lastModifiedDate",
  "submittedDate",
  "relatedApps",
  "inAppEvents",
];

/** The fields a nomination's create and update take, as the CLI names them. */
const EDITABLE_FIELDS = [
  "name",
  "type",
  "description",
  "notes",
  "publishStartDate",
  "publishEndDate",
  "deviceFamilies",
  "locales",
  "supplementalMaterialsUris",
  "hasInAppEvents",
  "launchInSelectMarketsFirst",
  "preOrderEnabled",
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

function shapeNomination({
  id,
  attributes: a,
  relationships,
}: AscResource<NominationAttributes>) {
  const ids = (name: string) => {
    const data = (
      relationships?.[name] as { data?: { id: string }[] } | undefined
    )?.data;
    return Array.isArray(data) ? data.map((item) => item.id) : undefined;
  };
  return {
    id,
    name: a?.name,
    type: a?.type,
    state: a?.state,
    description: a?.description,
    notes: a?.notes ?? null,
    publishStartDate: a?.publishStartDate ?? null,
    publishEndDate: a?.publishEndDate ?? null,
    deviceFamilies: a?.deviceFamilies ?? [],
    locales: a?.locales ?? [],
    supplementalMaterialsUris: a?.supplementalMaterialsUris ?? [],
    hasInAppEvents: a?.hasInAppEvents ?? null,
    launchInSelectMarketsFirst: a?.launchInSelectMarketsFirst ?? null,
    preOrderEnabled: a?.preOrderEnabled ?? null,
    appIds: ids("relatedApps"),
    eventIds: ids("inAppEvents"),
    createdDate: a?.createdDate ?? null,
    lastModifiedDate: a?.lastModifiedDate ?? null,
    submittedDate: a?.submittedDate ?? null,
  };
}
type Nomination = ReturnType<typeof shapeNomination>;

const QUERY = {
  "fields[nominations]": NOMINATION_FIELDS,
  include: ["relatedApps", "inAppEvents"],
  "fields[apps]": ["name"],
  "fields[appEvents]": ["referenceName"],
  "limit[relatedApps]": 50,
  "limit[inAppEvents]": 50,
};

async function readNomination(client: AscClient, nominationId: string) {
  const { data } = await client.get<{
    data: AscResource<NominationAttributes>;
  }>(`/v1/nominations/${nominationId}`, QUERY);
  return shapeNomination(data);
}

/** Only a draft accepts changes or submission. */
function draft(nomination: Nomination, what: string) {
  if (nomination.state !== "DRAFT") {
    throw new NotEditableError(
      `Nomination ${nomination.name ?? nomination.id} is ${nomination.state}, so it can no longer be ${what}; only a DRAFT can.`,
    );
  }
}

export const nominationsInput = z.object({
  app: commaList(appIdSchema),
  // Apple requires a state filter; drafts and submitted ones are the useful default.
  state: commaList(z.enum(NOMINATION_STATES)),
  type: commaList(z.enum(NOMINATION_TYPES)),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** The team's nominations, latest change first. */
export async function listNominations(
  client: AscClient,
  input: z.output<typeof nominationsInput>,
) {
  const response = await client.get<AscDocument<NominationAttributes>>(
    "/v1/nominations",
    {
      "filter[state]": input.state ?? ["DRAFT", "SUBMITTED"],
      "filter[type]": input.type,
      "filter[relatedApps]": input.app,
      sort: "-lastModifiedDate",
      limit: input.limit,
      cursor: input.cursor,
      ...QUERY,
    },
  );
  return {
    nominations: response.data.map(shapeNomination),
    ...pageInfo(response),
  };
}

/** An ISO 8601 date-time, such as 2026-12-01T00:00:00Z. */
const dateTime = (option: string) =>
  z.iso.datetime({
    offset: true,
    error: `${option} must be an ISO 8601 date-time such as 2026-12-01T00:00:00Z.`,
  });

const flag = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true")
  .optional();

const fieldsSchema = {
  name: z.string().trim().min(1).max(200).optional(),
  type: z.enum(NOMINATION_TYPES).optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  notes: z.string().trim().max(4000).optional(),
  publishStartDate: dateTime("--publish-date").optional(),
  publishEndDate: dateTime("--publish-end-date").optional(),
  deviceFamilies: commaList(z.enum(DEVICE_FAMILIES)),
  locales: commaList(localeSchema),
  supplementalMaterialsUris: commaList(z.url()),
  hasInAppEvents: flag,
  launchInSelectMarketsFirst: flag,
  preOrderEnabled: flag,
  events: commaList(idSchema("events")),
};

/** The attributes the input sets, leaving out those not given. */
function attributesOf(input: Partial<Record<EditableField, unknown>>) {
  const attributes: Partial<Record<EditableField, unknown>> = {};
  for (const field of EDITABLE_FIELDS) {
    if (input[field] !== undefined) attributes[field] = input[field];
  }
  return attributes;
}

const eventsRelationship = (events: string[]) => ({
  inAppEvents: {
    data: events.map((id) => ({ type: "appEvents", id })),
  },
});

export const createNominationInput = z.object({
  ...fieldsSchema,
  app: z
    .array(appIdSchema)
    .min(1, "Give the app with --app; repeat it for more than one."),
  name: z
    .string({ error: "Give the nomination's name with --name." })
    .trim()
    .min(1)
    .max(200),
  type: z.enum(NOMINATION_TYPES, {
    error: `Give --type: ${NOMINATION_TYPES.join(", ")}.`,
  }),
  description: z
    .string({ error: "Give what is being nominated with --description." })
    .trim()
    .min(1)
    .max(4000),
  publishStartDate: dateTime("--publish-date"),
  yes: z.boolean().default(false),
});

/** Creates a draft nomination; `nominations submit` sends it to Apple. */
export async function createNomination(
  client: AscClient,
  input: z.output<typeof createNominationInput>,
) {
  if (
    input.publishEndDate &&
    Date.parse(input.publishEndDate) < Date.parse(input.publishStartDate)
  ) {
    throw new InvalidInputError(
      "--publish-end-date must be after --publish-date.",
    );
  }
  const apps = [];
  for (const appId of input.app) {
    const { data } = await client.get<{
      data: AscResource<{ name?: string }>;
    }>(`/v1/apps/${appId}`, { "fields[apps]": ["name"] });
    apps.push({ id: data.id, name: data.attributes?.name });
  }
  const attributes = attributesOf(input);
  if (!input.yes) {
    return {
      dryRun: true,
      action: "create",
      apps,
      nomination: attributes,
      eventIds: input.events ?? [],
    };
  }
  const { data } = await client.post<{
    data: AscResource<NominationAttributes>;
  }>("/v1/nominations", {
    data: {
      type: "nominations",
      attributes: { ...attributes, submitted: false },
      relationships: {
        relatedApps: {
          data: input.app.map((id) => ({ type: "apps", id })),
        },
        ...(input.events ? eventsRelationship(input.events) : {}),
      },
    },
  });
  return {
    dryRun: false,
    action: "create",
    nomination: shapeNomination(data),
  };
}

export const setNominationInput = z.object({
  nominationId: nominationIdSchema,
  ...fieldsSchema,
  yes: z.boolean().default(false),
});

/** Changes a draft nomination's fields. */
export async function setNomination(
  client: AscClient,
  input: z.output<typeof setNominationInput>,
) {
  const nomination = await readNomination(client, input.nominationId);
  draft(nomination, "changed");
  const update = attributesOf(input);
  if (Object.keys(update).length === 0 && !input.events) {
    throw new InvalidInputError(
      "Give at least one field to change, such as --name or --publish-date.",
    );
  }
  const changed = (Object.keys(update) as EditableField[]).filter(
    (field) =>
      JSON.stringify(nomination[field]) !== JSON.stringify(update[field]),
  );
  const eventsChanged =
    input.events !== undefined &&
    JSON.stringify([...input.events].sort()) !==
      JSON.stringify([...(nomination.eventIds ?? [])].sort());
  if (!input.yes) {
    return {
      dryRun: true,
      action: "set",
      nomination,
      update: {
        ...update,
        ...(input.events ? { eventIds: input.events } : {}),
      },
      changes: changed.length > 0 || eventsChanged,
    };
  }
  if (changed.length > 0 || eventsChanged) {
    await client.patch(`/v1/nominations/${input.nominationId}`, {
      data: {
        type: "nominations",
        id: input.nominationId,
        attributes: Object.fromEntries(
          changed.map((field) => [field, update[field]]),
        ),
        ...(eventsChanged && input.events
          ? { relationships: eventsRelationship(input.events) }
          : {}),
      },
    });
  }
  return {
    dryRun: false,
    action: "set",
    nominationId: input.nominationId,
    changed: [...changed, ...(eventsChanged ? ["eventIds"] : [])],
  };
}

export const submitNominationInput = z.object({
  nominationId: nominationIdSchema,
  yes: z.boolean().default(false),
});

/**
 * Sends a draft nomination to Apple.
 *
 * Assumption: Apple's docs list `submitted` on the update request without
 * describing it; setting it to true is taken to submit the nomination.
 */
export async function submitNomination(
  client: AscClient,
  input: z.output<typeof submitNominationInput>,
) {
  const nomination = await readNomination(client, input.nominationId);
  draft(nomination, "submitted");
  const start = Date.parse(nomination.publishStartDate ?? "");
  if (Number.isFinite(start) && start < Date.now()) {
    throw new InvalidInputError(
      `Nomination ${nomination.name ?? nomination.id} has a publish date in the past (${nomination.publishStartDate}); change it with nominations set first.`,
    );
  }
  if (!input.yes) return { dryRun: true, action: "submit", nomination };
  const { data } = await client.patch<{
    data: AscResource<NominationAttributes>;
  }>(`/v1/nominations/${input.nominationId}`, {
    data: {
      type: "nominations",
      id: input.nominationId,
      attributes: { submitted: true },
    },
  });
  return {
    dryRun: false,
    action: "submit",
    nominationId: input.nominationId,
    state: data?.attributes?.state,
  };
}
