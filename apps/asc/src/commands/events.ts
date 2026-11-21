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
  AscApiError,
  classifyError,
  InvalidInputError,
  NotEditableError,
  NotFoundError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import { reviewDraft, submitForReview } from "./custom-pages.ts";
import {
  EVENT_PLACEMENT_TYPES,
  listPlacements,
  placeFiles,
  planUpload,
  showPlanned,
} from "./screenshots.ts";

/**
 * In-app events: event cards (a challenge, a live event, a new season) on
 * the product page, in search and in editorial placements, each with a
 * schedule per set of territories and a name and descriptions per locale.
 * Each event is reviewed on its own. Apple's appEvents resource has no app
 * relationship, so commands that need the app take its id and read the
 * event through it.
 */

const eventIdSchema = idSchema("events");

export const EVENT_STATES = [
  "DRAFT",
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "REJECTED",
  "ACCEPTED",
  "APPROVED",
  "PUBLISHED",
  "PAST",
  "ARCHIVED",
] as const;

export const BADGES = [
  "LIVE_EVENT",
  "PREMIERE",
  "CHALLENGE",
  "COMPETITION",
  "NEW_SEASON",
  "MAJOR_UPDATE",
  "SPECIAL_EVENT",
] as const;

export const PURPOSES = [
  "APPROPRIATE_FOR_ALL_USERS",
  "ATTRACT_NEW_USERS",
  "KEEP_ACTIVE_USERS_INFORMED",
  "BRING_BACK_LAPSED_USERS",
] as const;

export const PRIORITIES = ["HIGH", "NORMAL"] as const;

export const PURCHASE_REQUIREMENTS = [
  "NO_COST_ASSOCIATED",
  "IN_APP_PURCHASE",
] as const;

/**
 * Event states that accept changes.
 *
 * Assumption: Apple's API docs list the states but not which accept a PATCH
 * or new placements; this follows App Store Connect, where an event is
 * edited before review or after a rejection.
 */
const EDITABLE_STATES = new Set(["DRAFT", "REJECTED"]);

/** Event states that can go to review; READY_FOR_REVIEW is one already in a draft submission. */
const SUBMITTABLE_STATES = new Set([...EDITABLE_STATES, "READY_FOR_REVIEW"]);

/**
 * States of events that count towards Apple's limit on events at once.
 *
 * Assumption: Apple's API docs do not state the limit or which states count;
 * these are the states past review.
 */
const LIVE_STATES = ["ACCEPTED", "APPROVED", "PUBLISHED"] as const;

interface Schedule {
  territories?: string[];
  publishStart?: string | null;
  eventStart?: string | null;
  eventEnd?: string | null;
}

interface EventAttributes {
  referenceName?: string;
  badge?: string | null;
  eventState?: string;
  deepLink?: string | null;
  purchaseRequirement?: string | null;
  primaryLocale?: string | null;
  priority?: string | null;
  purpose?: string | null;
  territorySchedules?: Schedule[] | null;
}

interface LocalizationAttributes {
  locale?: string;
  name?: string | null;
  shortDescription?: string | null;
  longDescription?: string | null;
}

const EVENT_FIELDS = [
  "referenceName",
  "badge",
  "eventState",
  "deepLink",
  "purchaseRequirement",
  "primaryLocale",
  "priority",
  "purpose",
  "territorySchedules",
];

const TEXT_FIELDS = ["name", "shortDescription", "longDescription"] as const;

function shapeEvent({ id, attributes }: AscResource<EventAttributes>) {
  return {
    id,
    referenceName: attributes?.referenceName,
    badge: attributes?.badge ?? null,
    state: attributes?.eventState,
    priority: attributes?.priority ?? null,
    purpose: attributes?.purpose ?? null,
    purchaseRequirement: attributes?.purchaseRequirement ?? null,
    primaryLocale: attributes?.primaryLocale ?? null,
    deepLink: attributes?.deepLink ?? null,
    territorySchedules: (attributes?.territorySchedules ?? []).map(
      (schedule) => ({
        territories: schedule.territories ?? [],
        publishStart: schedule.publishStart ?? null,
        eventStart: schedule.eventStart ?? null,
        eventEnd: schedule.eventEnd ?? null,
      }),
    ),
  };
}

type Event = ReturnType<typeof shapeEvent>;

function shapeLocalization({
  id,
  attributes,
}: AscResource<LocalizationAttributes>) {
  return {
    id,
    locale: attributes?.locale ?? "",
    name: attributes?.name ?? null,
    shortDescription: attributes?.shortDescription ?? null,
    longDescription: attributes?.longDescription ?? null,
  };
}

async function readEvent(client: AscClient, eventId: string) {
  const { data } = await client.get<{ data: AscResource<EventAttributes> }>(
    `/v1/appEvents/${eventId}`,
    { "fields[appEvents]": EVENT_FIELDS },
  );
  return shapeEvent(data);
}

/** An app's event, read through the app, which also checks it belongs there. */
async function readAppEvent(client: AscClient, appId: string, eventId: string) {
  const response = await client.get<AscDocument<EventAttributes>>(
    `/v1/apps/${appId}/appEvents`,
    { "fields[appEvents]": EVENT_FIELDS, "filter[id]": eventId, limit: 1 },
  );
  const event = response.data[0];
  if (!event) {
    throw new NotFoundError(
      `App ${appId} has no in-app event ${eventId}; the events command lists them.`,
    );
  }
  return shapeEvent(event);
}

async function listLocalizations(client: AscClient, eventId: string) {
  // An event has at most one localization per App Store locale, fewer than one page of 200.
  const response = await client.get<AscDocument<LocalizationAttributes>>(
    `/v1/appEvents/${eventId}/localizations`,
    {
      "fields[appEventLocalizations]": ["locale", ...TEXT_FIELDS],
      limit: 200,
    },
  );
  return response.data.map(shapeLocalization);
}

function editable(event: Event, what: string) {
  if (!EDITABLE_STATES.has(event.state ?? "")) {
    throw new NotEditableError(
      `In-app event ${event.referenceName} is ${event.state}, so its ${what} can no longer be changed. Use an event that is DRAFT or REJECTED.`,
    );
  }
}

export const eventsInput = z.object({
  appId: appIdSchema,
  state: commaList(z.enum(EVENT_STATES)),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** An app's in-app events: reference name, state, badge, and each schedule's territories and dates. */
export async function listEvents(
  client: AscClient,
  input: z.output<typeof eventsInput>,
) {
  const response = await client.get<AscDocument<EventAttributes>>(
    `/v1/apps/${input.appId}/appEvents`,
    {
      "fields[appEvents]": EVENT_FIELDS,
      "filter[eventState]": input.state,
      limit: input.limit,
      cursor: input.cursor,
    },
  );
  return { events: response.data.map(shapeEvent), ...pageInfo(response) };
}

export const eventInput = z.object({ eventId: eventIdSchema });

/** One event with each locale's name, descriptions, and event card and details page images and videos. */
export async function getEvent(
  client: AscClient,
  input: z.output<typeof eventInput>,
) {
  const event = await readEvent(client, input.eventId);
  const localizations = [];
  for (const localization of await listLocalizations(client, input.eventId)) {
    localizations.push({
      ...localization,
      placements: await listPlacements(
        client,
        localization.id,
        undefined,
        "appEventLocalizations",
        EVENT_PLACEMENT_TYPES,
      ),
    });
  }
  return { event, localizations };
}

const textSchema = z.string().trim().min(1).optional();
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "Must be a date and time such as 2026-12-01T09:00:00Z.",
  })
  .optional();

export const createEventInput = z.object({
  appId: appIdSchema,
  referenceName: z
    .string({
      error:
        "Give the event's name in App Store Connect with --reference-name.",
    })
    .trim()
    .min(
      1,
      "Give the event's name in App Store Connect with --reference-name.",
    ),
  locale: localeSchema,
  name: textSchema,
  shortDescription: textSchema,
  longDescription: textSchema,
  badge: z.enum(BADGES).optional(),
  purpose: z.enum(PURPOSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  purchaseRequirement: z.enum(PURCHASE_REQUIREMENTS).optional(),
  deepLink: z.url().optional(),
  territories: commaList(
    z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, "Must be territory codes such as USA,GBR."),
  ),
  publishStart: dateTimeSchema,
  eventStart: dateTimeSchema,
  eventEnd: dateTimeSchema,
  yes: z.boolean().default(false),
});

/**
 * Creates an event in its primary locale, with one schedule when any of the
 * territories and dates are given, and that locale's name and descriptions
 * when given. Without `yes`, shows the event and how many the app has.
 */
export async function createEvent(
  client: AscClient,
  input: z.output<typeof createEventInput>,
) {
  const scheduled =
    input.territories !== undefined ||
    input.publishStart !== undefined ||
    input.eventStart !== undefined ||
    input.eventEnd !== undefined;
  const attributes = {
    referenceName: input.referenceName,
    primaryLocale: input.locale,
    badge: input.badge,
    purpose: input.purpose,
    priority: input.priority,
    purchaseRequirement: input.purchaseRequirement,
    deepLink: input.deepLink,
    territorySchedules: scheduled
      ? [
          {
            territories: input.territories,
            publishStart: input.publishStart,
            eventStart: input.eventStart,
            eventEnd: input.eventEnd,
          },
        ]
      : undefined,
  };
  const text = {
    name: input.name,
    shortDescription: input.shortDescription,
    longDescription: input.longDescription,
  };
  const localized = TEXT_FIELDS.some((field) => text[field] !== undefined);
  if (!input.yes) {
    const existing = await client.get<AscDocument<EventAttributes>>(
      `/v1/apps/${input.appId}/appEvents`,
      { "fields[appEvents]": ["eventState"], limit: 1 },
    );
    return {
      dryRun: true,
      action: "create",
      appId: input.appId,
      event: attributes,
      localization: localized ? { locale: input.locale, ...text } : null,
      existingEvents: existing.meta?.paging?.total,
    };
  }
  const created = await client.post<{ data: AscResource<EventAttributes> }>(
    "/v1/appEvents",
    {
      data: {
        type: "appEvents",
        attributes,
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    },
  );
  const eventId = created.data.id;
  let localization = null;
  if (localized) {
    try {
      localization = await saveLocalization(
        client,
        eventId,
        input.locale,
        text,
      );
    } catch (error) {
      throw new UploadIncompleteError(
        `In-app event ${eventId} was created but its ${input.locale} name and descriptions were not saved; set them with events set ${eventId} --locale ${input.locale}.`,
        { cause: error },
      );
    }
  }
  return {
    dryRun: false,
    action: "create",
    event: shapeEvent(created.data),
    localization,
  };
}

/**
 * Updates the locale's localization, or creates it when the event has none.
 *
 * Assumption: Apple's docs do not say whether creating an event creates its
 * primary locale's localization, so this looks first.
 */
async function saveLocalization(
  client: AscClient,
  eventId: string,
  locale: string,
  text: Partial<Record<(typeof TEXT_FIELDS)[number], string>>,
  existing?: ReturnType<typeof shapeLocalization>,
) {
  const current =
    existing ??
    (await listLocalizations(client, eventId)).find(
      (item) => item.locale === locale,
    );
  const response = current
    ? await client.patch<{ data: AscResource<LocalizationAttributes> }>(
        `/v1/appEventLocalizations/${current.id}`,
        {
          data: {
            type: "appEventLocalizations",
            id: current.id,
            attributes: text,
          },
        },
      )
    : await client.post<{ data: AscResource<LocalizationAttributes> }>(
        "/v1/appEventLocalizations",
        {
          data: {
            type: "appEventLocalizations",
            attributes: { locale, ...text },
            relationships: {
              appEvent: { data: { type: "appEvents", id: eventId } },
            },
          },
        },
      );
  return shapeLocalization(response.data);
}

export const setEventInput = z
  .object({
    eventId: eventIdSchema,
    locale: localeSchema,
    name: textSchema,
    shortDescription: textSchema,
    longDescription: textSchema,
    yes: z.boolean().default(false),
  })
  .refine((input) => TEXT_FIELDS.some((field) => input[field] !== undefined), {
    message: "Give --name, --short-description, --long-description or more.",
  });

/**
 * Sets one locale's event name and descriptions on an event being prepared
 * or rejected, adding the locale when the event has none. Without `yes`,
 * shows the current and new values.
 */
export async function setEvent(
  client: AscClient,
  input: z.output<typeof setEventInput>,
) {
  const event = await readEvent(client, input.eventId);
  editable(event, "name and descriptions");
  const localization = (await listLocalizations(client, input.eventId)).find(
    (item) => item.locale === input.locale,
  );
  const update: Partial<Record<(typeof TEXT_FIELDS)[number], string>> = {};
  for (const field of TEXT_FIELDS) {
    if (input[field] !== undefined) update[field] = input[field];
  }
  const changed = TEXT_FIELDS.filter(
    (field) =>
      update[field] !== undefined &&
      (!localization || localization[field] !== update[field]),
  );
  if (!input.yes) {
    return {
      dryRun: true,
      action: "set",
      event,
      locale: input.locale,
      newLocale: !localization,
      current: localization
        ? Object.fromEntries(
            Object.keys(update).map((field) => [
              field,
              localization[field as keyof typeof update],
            ]),
          )
        : null,
      update,
      changes: changed.length > 0,
    };
  }
  if (changed.length > 0) {
    await saveLocalization(
      client,
      input.eventId,
      input.locale,
      Object.fromEntries(changed.map((field) => [field, update[field]])),
      localization,
    );
  }
  return {
    dryRun: false,
    action: "set",
    eventId: input.eventId,
    locale: input.locale,
    changed,
  };
}

export const uploadEventInput = z.object({
  appId: appIdSchema,
  eventId: eventIdSchema,
  dir: z
    .string({ error: "Give the folder to upload with --dir." })
    .trim()
    .min(1, "Give the folder to upload with --dir."),
  yes: z.boolean().default(false),
});

/**
 * Uploads a folder of event card and details page images and videos to an
 * event, through the same asset library upload as `screenshots upload`: one
 * subfolder per locale, each file naming EVENT_CARD_ASSET or
 * EVENT_DETAILS_PAGE_ASSET. Without `yes`, shows where each file would go.
 */
export async function uploadEventMedia(
  client: AscClient,
  input: z.output<typeof uploadEventInput>,
) {
  const event = await readAppEvent(client, input.appId, input.eventId);
  editable(event, "images and videos");
  const target = {
    localizationType: "appEventLocalizations",
    relationship: "appEventLocalization",
    feature: "IN_APP_EVENTS",
    label: `In-app event ${event.referenceName}`,
    localesCommand: "events show",
    localizations: await listLocalizations(client, input.eventId),
    placementTypes: EVENT_PLACEMENT_TYPES,
  } as const;
  const { files, skipped } = await planUpload(client, input.dir, target);
  if (!input.yes) {
    return {
      dryRun: true,
      action: "upload",
      event,
      files: showPlanned(files),
      skipped,
    };
  }
  return {
    dryRun: false,
    action: "upload",
    eventId: input.eventId,
    uploaded: await placeFiles(client, input.appId, target, files),
    skipped,
  };
}

export const submitEventInput = z.object({
  appId: appIdSchema,
  eventId: eventIdSchema,
  platform: z.enum(PLATFORMS).default("IOS"),
  yes: z.boolean().default(false),
});

/**
 * Submits an event for App Review on its own: it goes into a new review
 * submission, or one being prepared that holds nothing else. Without `yes`,
 * shows the event, the submission it would use and how many of the app's
 * events are past review.
 */
export async function submitEvent(
  client: AscClient,
  input: z.output<typeof submitEventInput>,
) {
  const event = await readAppEvent(client, input.appId, input.eventId);
  if (!SUBMITTABLE_STATES.has(event.state ?? "")) {
    throw new NotEditableError(
      `In-app event ${event.referenceName} is ${event.state}, so it cannot be submitted for review. Submit an event that is DRAFT or REJECTED.`,
    );
  }
  const item = {
    relationship: "appEvent",
    type: "appEvents",
    id: input.eventId,
  } as const;
  const draft = await reviewDraft(client, input.appId, input.platform, item);
  if (!input.yes) {
    const live = await client.get<AscDocument<EventAttributes>>(
      `/v1/apps/${input.appId}/appEvents`,
      {
        "fields[appEvents]": ["eventState"],
        "filter[eventState]": LIVE_STATES,
        limit: 1,
      },
    );
    return {
      dryRun: true,
      action: "submit",
      event,
      platform: input.platform,
      reviewSubmissionId: draft.id ?? null,
      eventsPastReview: live.meta?.paging?.total,
    };
  }
  const submitted = await submitForReview(
    client,
    input.appId,
    input.platform,
    draft,
    item,
  ).catch((error: unknown) => {
    // Apple answers 409 or 422 when it will not take the event; the limit on events at once is one cause.
    if (
      error instanceof AscApiError &&
      (error.status === 409 || error.status === 422)
    ) {
      throw new InvalidInputError(
        `App Store Connect would not submit in-app event ${event.referenceName}: it may be missing a locale's name and descriptions, an event card or a schedule, or the app may be at Apple's limit of events at once (events --state ACCEPTED,APPROVED,PUBLISHED lists those). ${classifyError(error).message}`,
        { cause: error },
      );
    }
    throw error;
  });
  return {
    dryRun: false,
    action: "submit",
    eventId: input.eventId,
    ...submitted,
  };
}
