import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscQuery,
  type AscResource,
  pageInfo,
  related,
  type UploadOperation,
} from "../asc/client.ts";
import {
  appIdSchema,
  commaList,
  cursorSchema,
  idSchema,
  limitSchema,
  localeSchema,
} from "../schemas/common.ts";
import {
  AscApiError,
  InvalidInputError,
  NotFoundError,
  UnexpectedResponseError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import {
  allPages,
  dateSchema,
  equalizations,
  inlinePrices,
  overridesSchema,
  type PricePoint,
  planSchedule,
  priceSchema,
  readManualPrices,
  resolvePrices,
  territorySchema,
  today,
} from "./pricing.ts";

/**
 * In-app purchases and auto-renewable subscriptions: reading each
 * product's type or period, review state, localizations, availability,
 * current prices by territory and offers, and creating products and
 * subscription groups with their localizations, prices, availability and
 * review screenshots, then submitting them. Offers are in
 * `subscription-offers.ts`.
 *
 * Attributes are copied from Apple's responses through an allowlist rather
 * than asked for with sparse fieldsets, so an attribute Apple renames or
 * drops leaves a gap instead of failing the request. Offer code redemption
 * codes are never read: offer codes are listed with their counts only.
 */

export const IAP_TYPES = [
  "CONSUMABLE",
  "NON_CONSUMABLE",
  "NON_RENEWING_SUBSCRIPTION",
] as const;

/** Review states of in-app purchases and subscriptions, as Apple lists them. */
export const PRODUCT_STATES = [
  "MISSING_METADATA",
  "WAITING_FOR_UPLOAD",
  "PROCESSING_CONTENT",
  "READY_TO_SUBMIT",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "DEVELOPER_ACTION_NEEDED",
  "PENDING_BINARY_APPROVAL",
  "APPROVED",
  "DEVELOPER_REMOVED_FROM_SALE",
  "REMOVED_FROM_SALE",
  "REJECTED",
] as const;

type Attributes = Record<string, unknown>;

/** The listed attributes of a resource, with those Apple left out as null. */
function pick<Key extends string>(
  resource: AscResource<Attributes>,
  keys: readonly Key[],
): Record<Key, unknown> {
  return Object.fromEntries(
    keys.map((key) => [key, resource.attributes?.[key] ?? null]),
  ) as Record<Key, unknown>;
}

const IAP_KEYS = [
  "name",
  "productId",
  "inAppPurchaseType",
  "state",
  "familySharable",
  "contentHosting",
  "reviewNote",
] as const;

const SUBSCRIPTION_KEYS = [
  "name",
  "productId",
  "state",
  "subscriptionPeriod",
  "groupLevel",
  "familySharable",
  "reviewNote",
] as const;

const LOCALIZATION_KEYS = ["locale", "name", "description", "state"] as const;

/** Offer code settings and counts; never the codes. */
const OFFER_CODE_KEYS = [
  "name",
  "active",
  "customerEligibilities",
  "offerEligibility",
  "offerMode",
  "duration",
  "numberOfPeriods",
  "autoRenewEnabled",
  "totalNumberOfCodes",
  "productionCodeCount",
  "sandboxCodeCount",
] as const;

const PROMOTIONAL_OFFER_KEYS = [
  "name",
  "offerCode",
  "offerMode",
  "duration",
  "numberOfPeriods",
] as const;

const WIN_BACK_KEYS = [
  "referenceName",
  "offerId",
  "offerMode",
  "duration",
  "periodCount",
  "startDate",
  "endDate",
  "priority",
  "promotionIntent",
  "customerEligibilityPaidSubscriptionDurationInMonths",
  "customerEligibilityTimeSinceLastSubscribedInMonths",
  "customerEligibilityWaitBetweenOffersInMonths",
] as const;

function shapeIap(resource: AscResource<Attributes>) {
  const { name, ...rest } = pick(resource, IAP_KEYS);
  return { id: resource.id, referenceName: name, ...rest };
}

function shapeSubscription(resource: AscResource<Attributes>) {
  const { name, ...rest } = pick(resource, SUBSCRIPTION_KEYS);
  return { id: resource.id, referenceName: name, ...rest };
}

/** Whether a date range holds today; a missing end is open. */
function inEffect(startDate: unknown, endDate: unknown, on: string): boolean {
  const start = typeof startDate === "string" ? startDate.slice(0, 10) : null;
  const end = typeof endDate === "string" ? endDate.slice(0, 10) : null;
  return (start === null || start <= on) && (end === null || end > on);
}

/** Resolves undefined when Apple answers 404, as it does for something never set up. */
async function unlessMissing<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) return undefined;
    throw error;
  }
}

async function readList(
  client: AscClient,
  path: string,
  query: AscQuery = {},
): Promise<AscDocument<Attributes>> {
  return allPages<Attributes>(client, path, { limit: 200, ...query });
}

/** Whether new territories are added automatically, and the territories the product is sold in. */
async function readAvailability(
  client: AscClient,
  path: string,
  territoriesPath: (id: string) => string,
) {
  const availability = await unlessMissing(
    client.get<{ data: AscResource<Attributes> }>(path),
  );
  if (!availability) return null;
  const territories = await readList(
    client,
    territoriesPath(availability.data.id),
  );
  return {
    availableInNewTerritories:
      availability.data.attributes?.availableInNewTerritories ?? null,
    territoryCount: territories.data.length,
    territories: territories.data.map((territory) => territory.id),
  };
}

export const iapListInput = z.object({
  appId: appIdSchema,
  type: commaList(z.enum(IAP_TYPES)),
  state: commaList(z.enum(PRODUCT_STATES)),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** An app's in-app purchases: reference name, product ID, type and review state. */
export async function listIaps(
  client: AscClient,
  input: z.output<typeof iapListInput>,
) {
  const response = await client.get<AscDocument<Attributes>>(
    `/v1/apps/${input.appId}/inAppPurchasesV2`,
    {
      "filter[inAppPurchaseType]": input.type,
      "filter[state]": input.state,
      limit: input.limit,
      cursor: input.cursor,
    },
  );
  return {
    inAppPurchases: response.data.map(shapeIap),
    ...pageInfo(response),
  };
}

export const iapInput = z.object({ iapId: idSchema("iap") });

/**
 * One in-app purchase with its localizations, availability, the prices in
 * effect today in each territory, the base territory, and its offer codes
 * with their counts.
 */
export async function getIap(
  client: AscClient,
  input: z.output<typeof iapInput>,
) {
  const base = `/v2/inAppPurchases/${input.iapId}`;
  const { data } = await client.get<{ data: AscResource<Attributes> }>(base);
  const localizations = await readList(
    client,
    `${base}/inAppPurchaseLocalizations`,
  );
  const availability = await readAvailability(
    client,
    `${base}/inAppPurchaseAvailability`,
    (id) => `/v1/inAppPurchaseAvailabilities/${id}/availableTerritories`,
  );
  const prices = await readIapPrices(client, base);
  const offerCodes = await unlessMissing(
    readList(client, `${base}/offerCodes`),
  );
  return {
    inAppPurchase: shapeIap(data),
    localizations: localizations.data.map((item) => ({
      id: item.id,
      ...pick(item, LOCALIZATION_KEYS),
    })),
    availability,
    ...prices,
    offerCodes: (offerCodes?.data ?? []).map((item) => ({
      id: item.id,
      ...pick(item, OFFER_CODE_KEYS),
    })),
  };
}

/** The price schedule's base territory and the prices in effect today, set by hand or derived by Apple. */
async function readIapPrices(client: AscClient, base: string) {
  const schedule = await unlessMissing(
    client.get<{ data: AscResource; included?: AscResource[] }>(
      `${base}/iapPriceSchedule`,
      { include: ["baseTerritory"] },
    ),
  );
  if (!schedule) return { baseTerritory: null, prices: [] };
  const query = { include: ["inAppPurchasePricePoint", "territory"] };
  const id = schedule.data.id;
  const on = today();
  const prices = [];
  for (const [kind, manual] of [
    ["manualPrices", true],
    ["automaticPrices", false],
  ] as const) {
    const document = await readList(
      client,
      `/v1/inAppPurchasePriceSchedules/${id}/${kind}`,
      query,
    );
    for (const price of document.data) {
      if (!inEffect(price.attributes?.startDate, price.attributes?.endDate, on))
        continue;
      prices.push({
        ...shapePrice(document, price, "inAppPurchasePricePoint"),
        manual,
      });
    }
  }
  return {
    baseTerritory: {
      id: schedule.data.relationships?.baseTerritory?.data?.id ?? null,
      currency:
        related<{ currency?: string }>(schedule, schedule.data, "baseTerritory")
          ?.currency ?? null,
    },
    prices: sortByTerritory(prices),
  };
}

function shapePrice(
  document: AscDocument<Attributes>,
  price: AscResource<Attributes>,
  pricePoint: string,
) {
  const point = related<{ customerPrice?: string; proceeds?: string }>(
    document,
    price,
    pricePoint,
  );
  return {
    territory: price.relationships?.territory?.data?.id ?? null,
    currency:
      related<{ currency?: string }>(document, price, "territory")?.currency ??
      null,
    customerPrice: point?.customerPrice ?? null,
    proceeds: point?.proceeds ?? null,
    startDate: (price.attributes?.startDate as string | null) ?? null,
  };
}

function sortByTerritory<T extends { territory: string | null }>(
  items: T[],
): T[] {
  return items.sort((a, b) =>
    (a.territory ?? "").localeCompare(b.territory ?? ""),
  );
}

export const subscriptionsInput = z.object({ appId: appIdSchema });

/** An app's subscription groups, each with its subscriptions' product ID, period, level and review state. */
export async function listSubscriptions(
  client: AscClient,
  input: z.output<typeof subscriptionsInput>,
) {
  const groups = await readList(
    client,
    `/v1/apps/${input.appId}/subscriptionGroups`,
  );
  const result = [];
  for (const group of groups.data) {
    const subscriptions = await readList(
      client,
      `/v1/subscriptionGroups/${group.id}/subscriptions`,
    );
    result.push({
      id: group.id,
      referenceName: group.attributes?.referenceName ?? null,
      subscriptions: subscriptions.data
        .map(shapeSubscription)
        .sort(
          (a, b) =>
            Number(a.groupLevel ?? Infinity) - Number(b.groupLevel ?? Infinity),
        ),
    });
  }
  return { appId: input.appId, subscriptionGroups: result };
}

export const subscriptionInput = z.object({
  subscriptionId: idSchema("subscriptions"),
});

/**
 * One subscription with its localizations, availability, the price in effect
 * today and any scheduled change in each territory, introductory offers in
 * effect or scheduled, promotional offers, offer codes with their counts and
 * win-back offers that have not ended.
 */
export async function getSubscription(
  client: AscClient,
  input: z.output<typeof subscriptionInput>,
) {
  const base = `/v1/subscriptions/${input.subscriptionId}`;
  const on = today();
  const { data } = await client.get<{ data: AscResource<Attributes> }>(base);
  const localizations = await readList(
    client,
    `${base}/subscriptionLocalizations`,
  );
  const availability = await readAvailability(
    client,
    `${base}/subscriptionAvailability`,
    (id) => `/v1/subscriptionAvailabilities/${id}/availableTerritories`,
  );
  const prices = await readSubscriptionPrices(client, base, on);
  const introductory = await readList(client, `${base}/introductoryOffers`, {
    include: ["subscriptionPricePoint", "territory"],
  });
  const promotional = await readList(client, `${base}/promotionalOffers`);
  const offerCodes = await readList(client, `${base}/offerCodes`);
  const winBack = await unlessMissing(
    readList(client, `${base}/winBackOffers`),
  );
  return {
    subscription: shapeSubscription(data),
    localizations: localizations.data.map((item) => ({
      id: item.id,
      ...pick(item, LOCALIZATION_KEYS),
    })),
    availability,
    ...prices,
    introductoryOffers: sortByTerritory(
      introductory.data
        .filter((offer) =>
          // Scheduled offers are kept with those in effect; only ended ones are left out.
          inEffect(null, offer.attributes?.endDate, on),
        )
        .map((offer) => ({
          id: offer.id,
          territory: offer.relationships?.territory?.data?.id ?? null,
          offerMode: offer.attributes?.offerMode ?? null,
          duration: offer.attributes?.duration ?? null,
          numberOfPeriods: offer.attributes?.numberOfPeriods ?? null,
          customerPrice:
            related<{ customerPrice?: string }>(
              introductory,
              offer,
              "subscriptionPricePoint",
            )?.customerPrice ?? null,
          startDate: offer.attributes?.startDate ?? null,
          endDate: offer.attributes?.endDate ?? null,
        })),
    ),
    promotionalOffers: promotional.data.map((item) => ({
      id: item.id,
      ...pick(item, PROMOTIONAL_OFFER_KEYS),
    })),
    offerCodes: offerCodes.data.map((item) => ({
      id: item.id,
      ...pick(item, OFFER_CODE_KEYS),
    })),
    winBackOffers: (winBack?.data ?? [])
      .filter((item) => inEffect(null, item.attributes?.endDate, on))
      .map((item) => ({ id: item.id, ...pick(item, WIN_BACK_KEYS) })),
  };
}

/**
 * Each territory's price in effect today (the latest start on or before
 * today) and its scheduled changes. Apple keeps a subscription's past
 * prices in the same list.
 */
export async function readSubscriptionPrices(
  client: AscClient,
  base: string,
  on: string,
) {
  const document = await readList(client, `${base}/prices`, {
    include: ["subscriptionPricePoint", "territory"],
  });
  const current = new Map<string, ReturnType<typeof shapePrice>>();
  const scheduled = [];
  for (const price of document.data) {
    const shaped = shapePrice(document, price, "subscriptionPricePoint");
    const start = shaped.startDate?.slice(0, 10) ?? null;
    if (start !== null && start > on) {
      scheduled.push(shaped);
      continue;
    }
    const key = shaped.territory ?? "";
    const held = current.get(key);
    if (!held || (held.startDate ?? "") < (shaped.startDate ?? "")) {
      current.set(key, shaped);
    }
  }
  return {
    prices: sortByTerritory([...current.values()]),
    scheduledPrices: sortByTerritory(scheduled),
  };
}

// ---------------------------------------------------------------------------
// Writes: creating products, their localizations, prices, availability,
// review screenshots and submissions. Each reads what it changes first and,
// without `yes`, returns that with the planned change.

export const SUBSCRIPTION_PERIODS = [
  "ONE_WEEK",
  "ONE_MONTH",
  "TWO_MONTHS",
  "THREE_MONTHS",
  "SIX_MONTHS",
  "ONE_YEAR",
] as const;

/** Monthly plans pay an annual subscription in instalments; UPFRONT is the usual plan. */
export const PLAN_TYPES = ["UPFRONT", "MONTHLY"] as const;

const productIdSchema = z
  .string({ error: "Give the product ID with --product-id." })
  .trim()
  .regex(
    /^[A-Za-z0-9._-]{1,100}$/,
    "A product ID uses letters, digits, periods, hyphens and underscores, such as com.example.coins.",
  );

const referenceNameSchema = z
  .string({ error: "Give the reference name with --reference-name." })
  .trim()
  .min(1)
  .max(64, "Apple limits reference names to 64 characters.");

const reviewNoteSchema = z
  .string()
  .max(4000, "Apple limits review notes to 4000 characters.");

const territoriesInput = {
  territories: z.array(territorySchema).max(200).default([]),
  all: z.boolean().default(false),
  availableInNewTerritories: z.boolean().optional(),
};

function relationship(type: string, id: string) {
  return { data: { type, id } };
}

/** Attributes whose new value differs from the current one; at least one change is required. */
function changes(
  current: Attributes,
  wanted: Record<string, unknown>,
): Record<string, unknown> {
  const given = Object.entries(wanted).filter(
    ([, value]) => value !== undefined,
  );
  if (given.length === 0) {
    throw new InvalidInputError("Give at least one value to change.");
  }
  return Object.fromEntries(
    given.filter(([key, value]) => current[key] !== value),
  );
}

export const createIapInput = z.object({
  appId: appIdSchema,
  type: z.enum(IAP_TYPES, {
    error: `Give the type with --type: ${IAP_TYPES.join(", ")}.`,
  }),
  productId: productIdSchema,
  referenceName: referenceNameSchema,
  familySharable: z.boolean().optional(),
  reviewNote: reviewNoteSchema.optional(),
  yes: z.boolean().default(false),
});

/** Creates an in-app purchase; localize, price and make it available before submitting it. */
export async function createIap(
  client: AscClient,
  input: z.output<typeof createIapInput>,
) {
  const attributes = {
    name: input.referenceName,
    productId: input.productId,
    inAppPurchaseType: input.type,
    familySharable: input.familySharable,
    reviewNote: input.reviewNote,
  };
  if (!input.yes) return { dryRun: true, appId: input.appId, attributes };
  const { data } = await client.post<{ data: AscResource<Attributes> }>(
    "/v2/inAppPurchases",
    {
      data: {
        type: "inAppPurchases",
        attributes,
        relationships: { app: relationship("apps", input.appId) },
      },
    },
  );
  return { dryRun: false, inAppPurchase: shapeIap(data) };
}

export const setIapInput = z.object({
  iapId: idSchema("iap"),
  referenceName: referenceNameSchema.optional(),
  reviewNote: reviewNoteSchema.optional(),
  familySharable: z.boolean().optional(),
  yes: z.boolean().default(false),
});

/** Changes an in-app purchase's reference name, review note or family sharing. */
export async function setIap(
  client: AscClient,
  input: z.output<typeof setIapInput>,
) {
  const path = `/v2/inAppPurchases/${input.iapId}`;
  const { data } = await client.get<{ data: AscResource<Attributes> }>(path);
  const changed = changes(data.attributes ?? {}, {
    name: input.referenceName,
    reviewNote: input.reviewNote,
    familySharable: input.familySharable,
  });
  const plan = { inAppPurchase: shapeIap(data), changes: changed };
  if (!input.yes || Object.keys(changed).length === 0) {
    return { dryRun: !input.yes, ...plan };
  }
  const updated = await client.patch<{ data: AscResource<Attributes> }>(path, {
    data: { type: "inAppPurchases", id: input.iapId, attributes: changed },
  });
  return { dryRun: false, ...plan, inAppPurchase: shapeIap(updated.data) };
}

interface LocalizeTarget {
  listPath: string;
  type: string;
  parent: { relationship: string; type: string; id: string };
  locale: string;
  values: Record<string, string | undefined>;
  yes: boolean;
}

/** Creates the locale's localization, or changes the one that exists. */
async function localize(client: AscClient, target: LocalizeTarget) {
  const list = await readList(client, target.listPath);
  const existing = list.data.find(
    (item) => item.attributes?.locale === target.locale,
  );
  const values = Object.fromEntries(
    Object.entries(target.values).filter(([, value]) => value !== undefined),
  );
  const changed = existing
    ? changes(existing.attributes ?? {}, values)
    : values;
  const plan = {
    locale: target.locale,
    action: existing ? "update" : "create",
    current: existing
      ? { id: existing.id, ...(existing.attributes ?? {}) }
      : null,
    changes: changed,
  };
  if (!target.yes || Object.keys(changed).length === 0) {
    return { dryRun: !target.yes, ...plan };
  }
  if (existing) {
    await client.patch(`/v1/${target.type}/${existing.id}`, {
      data: { type: target.type, id: existing.id, attributes: changed },
    });
    return { dryRun: false, ...plan, id: existing.id };
  }
  const { data } = await client.post<{ data: AscResource }>(
    `/v1/${target.type}`,
    {
      data: {
        type: target.type,
        attributes: { locale: target.locale, ...changed },
        relationships: {
          [target.parent.relationship]: relationship(
            target.parent.type,
            target.parent.id,
          ),
        },
      },
    },
  );
  return { dryRun: false, ...plan, id: data.id };
}

const nameSchema = z
  .string({ error: "Give the display name with --name." })
  .trim()
  .min(1)
  .max(35, "Apple limits display names to 35 characters.");

const descriptionSchema = z
  .string()
  .max(55, "Apple limits descriptions to 55 characters.");

export const localizeIapInput = z.object({
  iapId: idSchema("iap"),
  locale: localeSchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  yes: z.boolean().default(false),
});

/** Sets one locale's display name and description of an in-app purchase. */
export async function localizeIap(
  client: AscClient,
  input: z.output<typeof localizeIapInput>,
) {
  return {
    iapId: input.iapId,
    ...(await localize(client, {
      listPath: `/v2/inAppPurchases/${input.iapId}/inAppPurchaseLocalizations`,
      type: "inAppPurchaseLocalizations",
      parent: {
        relationship: "inAppPurchaseV2",
        type: "inAppPurchases",
        id: input.iapId,
      },
      locale: input.locale,
      values: { name: input.name, description: input.description },
      yes: input.yes,
    })),
  };
}

export const priceIapInput = z.object({
  iapId: idSchema("iap"),
  baseTerritory: territorySchema,
  price: priceSchema,
  override: overridesSchema,
  startDate: dateSchema.optional(),
  dropScheduled: z.boolean().default(false),
  yes: z.boolean().default(false),
});

/**
 * Replaces an in-app purchase's price schedule: the base territory's price,
 * which Apple equalizes to every other territory, and territories priced by
 * hand. Old scheduled changes are kept unless `dropScheduled`.
 */
export async function priceIap(
  client: AscClient,
  input: z.output<typeof priceIapInput>,
) {
  const base = `/v2/inAppPurchases/${input.iapId}`;
  const schedule = await unlessMissing(
    client.get<{ data: AscResource }>(`${base}/iapPriceSchedule`),
  );
  const existing = schedule
    ? await readManualPrices(
        client,
        `/v1/inAppPurchasePriceSchedules/${schedule.data.id}/manualPrices`,
        "inAppPurchasePricePoint",
      )
    : [];
  const points = await resolvePrices(
    client,
    `${base}/pricePoints`,
    input.baseTerritory,
    input.price,
    input.override,
  );
  const planned = planSchedule(
    existing,
    points.map((point) => ({
      territory: point.territory,
      pricePointId: point.id,
      customerPrice: point.customerPrice,
    })),
    input.startDate ?? null,
    input.dropScheduled,
    today(),
  );
  const plan = {
    iapId: input.iapId,
    baseTerritory: {
      current: schedule?.data.relationships?.baseTerritory?.data?.id ?? null,
      new: input.baseTerritory,
    },
    matchedPrices: points,
    currentManualPrices: existing,
    newManualPrices: planned,
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const iap = relationship("inAppPurchases", input.iapId);
  await client.post("/v1/inAppPurchasePriceSchedules", {
    data: {
      type: "inAppPurchasePriceSchedules",
      relationships: {
        inAppPurchase: iap,
        baseTerritory: relationship("territories", input.baseTerritory),
        manualPrices: {
          data: planned.map((_, index) => ({
            type: "inAppPurchasePrices",
            id: `\${price-${index}}`,
          })),
        },
      },
    },
    included: inlinePrices(
      "inAppPurchasePrices",
      {
        relationship: "inAppPurchasePricePoint",
        type: "inAppPurchasePricePoints",
      },
      planned,
      { inAppPurchaseV2: iap },
    ),
  });
  return { dryRun: false, ...plan };
}

/** The territories asked for, or every App Store territory for `all`. */
async function chooseTerritories(
  client: AscClient,
  input: { territories: string[]; all: boolean },
): Promise<string[]> {
  if (input.all === input.territories.length > 0) {
    throw new InvalidInputError(
      "Give the territories with --territory, such as USA,GBR, or --all for every territory.",
    );
  }
  if (!input.all) return [...new Set(input.territories)].sort();
  const all = await readList(client, "/v1/territories");
  return all.data.map((item) => item.id).sort();
}

function territoryChanges(current: string[], wanted: string[]) {
  const before = new Set(current);
  const after = new Set(wanted);
  return {
    adding: wanted.filter((code) => !before.has(code)),
    removing: current.filter((code) => !after.has(code)),
  };
}

export const iapAvailabilityInput = z.object({
  iapId: idSchema("iap"),
  ...territoriesInput,
  yes: z.boolean().default(false),
});

/** Sets the territories an in-app purchase is sold in, replacing the current list. */
export async function setIapAvailability(
  client: AscClient,
  input: z.output<typeof iapAvailabilityInput>,
) {
  const current = await readAvailability(
    client,
    `/v2/inAppPurchases/${input.iapId}/inAppPurchaseAvailability`,
    (id) => `/v1/inAppPurchaseAvailabilities/${id}/availableTerritories`,
  );
  const territories = await chooseTerritories(client, input);
  const availableInNewTerritories =
    input.availableInNewTerritories ??
    (current?.availableInNewTerritories as boolean | null) ??
    false;
  const plan = {
    iapId: input.iapId,
    current,
    availableInNewTerritories,
    territoryCount: territories.length,
    ...territoryChanges(current?.territories ?? [], territories),
  };
  if (!input.yes) return { dryRun: true, ...plan };
  await client.post("/v1/inAppPurchaseAvailabilities", {
    data: {
      type: "inAppPurchaseAvailabilities",
      attributes: { availableInNewTerritories },
      relationships: {
        inAppPurchase: relationship("inAppPurchases", input.iapId),
        availableTerritories: {
          data: territories.map((id) => ({ type: "territories", id })),
        },
      },
    },
  });
  return { dryRun: false, ...plan };
}

interface ScreenshotAttributes {
  fileName?: string;
  fileSize?: number;
  uploadOperations?: UploadOperation[];
  assetDeliveryState?: { state?: string } | null;
}

interface ScreenshotTarget {
  type: string;
  parent: { relationship: string; type: string; id: string };
  currentPath: string;
  file: string;
  yes: boolean;
}

/**
 * Replaces the review screenshot: reserves the file, sends the parts Apple
 * lists (only to Apple's URLs), then commits it with its MD5. The old
 * screenshot is deleted first, since a product has one.
 */
async function uploadReviewScreenshot(
  client: AscClient,
  target: ScreenshotTarget,
) {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await readFile(target.file));
  } catch {
    throw new NotFoundError(`Could not read the file ${target.file}.`);
  }
  if (bytes.length === 0) {
    throw new InvalidInputError(`${basename(target.file)} is empty.`);
  }
  const current = await unlessMissing(
    client.get<{ data: AscResource<ScreenshotAttributes> | null }>(
      target.currentPath,
    ),
  );
  const old = current?.data ?? null;
  const plan = {
    file: basename(target.file),
    fileSize: bytes.length,
    replaces: old
      ? {
          id: old.id,
          fileName: old.attributes?.fileName ?? null,
          state: old.attributes?.assetDeliveryState?.state ?? null,
        }
      : null,
  };
  if (!target.yes) return { dryRun: true, ...plan };
  if (old) await client.delete(`/v1/${target.type}/${old.id}`);
  const reserved = await client.post<{
    data: AscResource<ScreenshotAttributes>;
  }>(`/v1/${target.type}`, {
    data: {
      type: target.type,
      attributes: { fileName: plan.file, fileSize: bytes.length },
      relationships: {
        [target.parent.relationship]: relationship(
          target.parent.type,
          target.parent.id,
        ),
      },
    },
  });
  const id = reserved.data.id;
  try {
    const operations = reserved.data.attributes?.uploadOperations ?? [];
    if (operations.length === 0) {
      throw new UnexpectedResponseError(
        "App Store Connect reserved the screenshot but gave no upload operations.",
      );
    }
    for (const operation of operations) {
      const { offset = 0, length = 0 } = operation;
      if (offset < 0 || length <= 0 || offset + length > bytes.length) {
        throw new UnexpectedResponseError(
          "App Store Connect asked for a part outside the file.",
        );
      }
      await client.upload(operation, bytes.slice(offset, offset + length));
    }
    await client.patch(`/v1/${target.type}/${id}`, {
      data: {
        type: target.type,
        id,
        attributes: {
          uploaded: true,
          sourceFileChecksum: createHash("md5").update(bytes).digest("hex"),
        },
      },
    });
  } catch (error) {
    throw new UploadIncompleteError(
      `The screenshot was reserved as ${id} but not committed${old ? ", and the old one was already deleted" : ""}. Run the upload again.`,
      { cause: error },
    );
  }
  return { dryRun: false, ...plan, id };
}

export const reviewScreenshotInput = z.object({
  id: idSchema("iap or subscriptions"),
  file: z.string({ error: "Give the image with --file." }).min(1),
  yes: z.boolean().default(false),
});

/** Uploads the screenshot App Review sees for an in-app purchase, replacing any old one. */
export async function uploadIapReviewScreenshot(
  client: AscClient,
  input: z.output<typeof reviewScreenshotInput>,
) {
  return {
    iapId: input.id,
    ...(await uploadReviewScreenshot(client, {
      type: "inAppPurchaseAppStoreReviewScreenshots",
      parent: {
        relationship: "inAppPurchaseV2",
        type: "inAppPurchases",
        id: input.id,
      },
      currentPath: `/v2/inAppPurchases/${input.id}/appStoreReviewScreenshot`,
      file: input.file,
      yes: input.yes,
    })),
  };
}

/** States from which a product may be sent to App Review. */
const SUBMITTABLE = new Set([
  "READY_TO_SUBMIT",
  "DEVELOPER_ACTION_NEEDED",
  "REJECTED",
]);

export const submitIapInput = z.object({
  iapId: idSchema("iap"),
  yes: z.boolean().default(false),
});

/**
 * Submits an in-app purchase for review. Apple reviews a product's first
 * submission with the next app version submitted, so it waits for one.
 */
export async function submitIap(
  client: AscClient,
  input: z.output<typeof submitIapInput>,
) {
  const { data } = await client.get<{ data: AscResource<Attributes> }>(
    `/v2/inAppPurchases/${input.iapId}`,
  );
  const product = shapeIap(data);
  requireSubmittable(product.state, `In-app purchase ${input.iapId}`);
  if (!input.yes) return { dryRun: true, inAppPurchase: product };
  await client.post("/v1/inAppPurchaseSubmissions", {
    data: {
      type: "inAppPurchaseSubmissions",
      relationships: {
        inAppPurchaseV2: relationship("inAppPurchases", input.iapId),
      },
    },
  });
  return { dryRun: false, inAppPurchase: product };
}

function requireSubmittable(state: unknown, what: string) {
  if (typeof state !== "string" || !SUBMITTABLE.has(state)) {
    throw new InvalidInputError(
      `${what} is ${String(state ?? "in an unknown state")}; only one that is ${[...SUBMITTABLE].join(", ")} can be submitted. MISSING_METADATA means it still needs a localization, price, availability or review screenshot.`,
    );
  }
}

export const createSubscriptionGroupInput = z.object({
  appId: appIdSchema,
  referenceName: referenceNameSchema,
  yes: z.boolean().default(false),
});

/** Creates a subscription group; add subscriptions to it with subscriptions create. */
export async function createSubscriptionGroup(
  client: AscClient,
  input: z.output<typeof createSubscriptionGroupInput>,
) {
  const groups = await readList(
    client,
    `/v1/apps/${input.appId}/subscriptionGroups`,
  );
  if (
    groups.data.some(
      (group) => group.attributes?.referenceName === input.referenceName,
    )
  ) {
    throw new InvalidInputError(
      `App ${input.appId} already has a subscription group named ${input.referenceName}.`,
    );
  }
  const plan = {
    appId: input.appId,
    referenceName: input.referenceName,
    existingGroups: groups.data.length,
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const { data } = await client.post<{ data: AscResource }>(
    "/v1/subscriptionGroups",
    {
      data: {
        type: "subscriptionGroups",
        attributes: { referenceName: input.referenceName },
        relationships: { app: relationship("apps", input.appId) },
      },
    },
  );
  return { dryRun: false, ...plan, id: data.id };
}

export const localizeSubscriptionGroupInput = z.object({
  groupId: idSchema("subscriptions"),
  locale: localeSchema,
  name: nameSchema,
  customAppName: z.string().trim().min(1).max(30).optional(),
  yes: z.boolean().default(false),
});

/** Sets one locale's display name, and optionally the app name shown with it, of a subscription group. */
export async function localizeSubscriptionGroup(
  client: AscClient,
  input: z.output<typeof localizeSubscriptionGroupInput>,
) {
  return {
    groupId: input.groupId,
    ...(await localize(client, {
      listPath: `/v1/subscriptionGroups/${input.groupId}/subscriptionGroupLocalizations`,
      type: "subscriptionGroupLocalizations",
      parent: {
        relationship: "subscriptionGroup",
        type: "subscriptionGroups",
        id: input.groupId,
      },
      locale: input.locale,
      values: { name: input.name, customAppName: input.customAppName },
      yes: input.yes,
    })),
  };
}

const groupLevelSchema = z.coerce.number().int().min(1).max(100);

export const createSubscriptionInput = z.object({
  groupId: idSchema("subscriptions"),
  productId: productIdSchema,
  referenceName: referenceNameSchema,
  period: z.enum(SUBSCRIPTION_PERIODS, {
    error: `Give the period with --period: ${SUBSCRIPTION_PERIODS.join(", ")}.`,
  }),
  groupLevel: groupLevelSchema.optional(),
  familySharable: z.boolean().optional(),
  reviewNote: reviewNoteSchema.optional(),
  yes: z.boolean().default(false),
});

/** Creates an auto-renewable subscription in a group, at a level (1 is the highest). */
export async function createSubscription(
  client: AscClient,
  input: z.output<typeof createSubscriptionInput>,
) {
  const existing = await readList(
    client,
    `/v1/subscriptionGroups/${input.groupId}/subscriptions`,
  );
  const attributes = {
    name: input.referenceName,
    productId: input.productId,
    subscriptionPeriod: input.period,
    groupLevel: input.groupLevel,
    familySharable: input.familySharable,
    reviewNote: input.reviewNote,
  };
  const plan = {
    groupId: input.groupId,
    attributes,
    groupSubscriptions: existing.data.map(shapeSubscription),
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const { data } = await client.post<{ data: AscResource<Attributes> }>(
    "/v1/subscriptions",
    {
      data: {
        type: "subscriptions",
        attributes,
        relationships: {
          group: relationship("subscriptionGroups", input.groupId),
        },
      },
    },
  );
  return { dryRun: false, ...plan, subscription: shapeSubscription(data) };
}

export const setSubscriptionInput = z.object({
  subscriptionId: idSchema("subscriptions"),
  referenceName: referenceNameSchema.optional(),
  period: z.enum(SUBSCRIPTION_PERIODS).optional(),
  groupLevel: groupLevelSchema.optional(),
  familySharable: z.boolean().optional(),
  reviewNote: reviewNoteSchema.optional(),
  yes: z.boolean().default(false),
});

/** Changes a subscription's reference name, period, level, family sharing or review note. */
export async function setSubscription(
  client: AscClient,
  input: z.output<typeof setSubscriptionInput>,
) {
  const path = `/v1/subscriptions/${input.subscriptionId}`;
  const { data } = await client.get<{ data: AscResource<Attributes> }>(path);
  const changed = changes(data.attributes ?? {}, {
    name: input.referenceName,
    subscriptionPeriod: input.period,
    groupLevel: input.groupLevel,
    familySharable: input.familySharable,
    reviewNote: input.reviewNote,
  });
  const plan = { subscription: shapeSubscription(data), changes: changed };
  if (!input.yes || Object.keys(changed).length === 0) {
    return { dryRun: !input.yes, ...plan };
  }
  const updated = await client.patch<{ data: AscResource<Attributes> }>(path, {
    data: {
      type: "subscriptions",
      id: input.subscriptionId,
      attributes: changed,
    },
  });
  return {
    dryRun: false,
    ...plan,
    subscription: shapeSubscription(updated.data),
  };
}

export const localizeSubscriptionInput = z.object({
  subscriptionId: idSchema("subscriptions"),
  locale: localeSchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  yes: z.boolean().default(false),
});

/** Sets one locale's display name and description of a subscription. */
export async function localizeSubscription(
  client: AscClient,
  input: z.output<typeof localizeSubscriptionInput>,
) {
  return {
    subscriptionId: input.subscriptionId,
    ...(await localize(client, {
      listPath: `/v1/subscriptions/${input.subscriptionId}/subscriptionLocalizations`,
      type: "subscriptionLocalizations",
      parent: {
        relationship: "subscription",
        type: "subscriptions",
        id: input.subscriptionId,
      },
      locale: input.locale,
      values: { name: input.name, description: input.description },
      yes: input.yes,
    })),
  };
}

/**
 * A subscription price for every territory: the base territory's nearest
 * price point, Apple's equalized points for the others, and the overrides
 * matched in their own territories. `territories` limits the result.
 */
export async function planSubscriptionPrices(
  client: AscClient,
  subscriptionId: string,
  input: {
    baseTerritory: string;
    price: number;
    override: { territory: string; price: number }[];
  },
  territories?: string[],
): Promise<PricePoint[]> {
  const pointsPath = `/v1/subscriptions/${subscriptionId}/pricePoints`;
  const [base, ...overrides] = await resolvePrices(
    client,
    pointsPath,
    input.baseTerritory,
    input.price,
    input.override,
  );
  if (!base) return [];
  const byTerritory = new Map<string, PricePoint>([[base.territory, base]]);
  for (const point of await equalizations(
    client,
    `/v1/subscriptionPricePoints/${base.id}/equalizations`,
  )) {
    if (!byTerritory.has(point.territory)) {
      byTerritory.set(point.territory, point);
    }
  }
  for (const point of overrides) byTerritory.set(point.territory, point);
  const wanted = territories ? new Set(territories) : undefined;
  return [...byTerritory.values()]
    .filter((point) => !wanted || wanted.has(point.territory))
    .sort((a, b) => a.territory.localeCompare(b.territory));
}

export const priceSubscriptionInput = z.object({
  subscriptionId: idSchema("subscriptions"),
  baseTerritory: territorySchema,
  price: priceSchema,
  override: overridesSchema,
  startDate: dateSchema.optional(),
  preserveCurrentPrice: z.boolean().default(true),
  yes: z.boolean().default(false),
});

/**
 * Prices a subscription in every territory from the base territory's price,
 * one price per territory as Apple's API takes them. For a live
 * subscription, existing subscribers keep their price unless
 * `preserveCurrentPrice` is false; then Apple tells them of the change, and
 * asks for their consent to an increase where the law requires it.
 */
export async function priceSubscription(
  client: AscClient,
  input: z.output<typeof priceSubscriptionInput>,
) {
  const base = `/v1/subscriptions/${input.subscriptionId}`;
  const { data } = await client.get<{ data: AscResource<Attributes> }>(base);
  const current = await readSubscriptionPrices(client, base, today());
  const planned = await planSubscriptionPrices(
    client,
    input.subscriptionId,
    input,
  );
  const plan = {
    subscription: shapeSubscription(data),
    startDate: input.startDate ?? null,
    preserveCurrentPrice: input.preserveCurrentPrice,
    currentPrices: current.prices,
    scheduledPrices: current.scheduledPrices,
    newPrices: planned.map((point) => ({
      territory: point.territory,
      customerPrice: point.customerPrice,
      proceeds: point.proceeds,
      ...(point.requestedPrice === undefined
        ? {}
        : { requestedPrice: point.requestedPrice }),
    })),
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const done: string[] = [];
  try {
    for (const point of planned) {
      await client.post("/v1/subscriptionPrices", {
        data: {
          type: "subscriptionPrices",
          attributes: {
            startDate: input.startDate ?? null,
            preserveCurrentPrice: input.preserveCurrentPrice,
          },
          relationships: {
            subscription: relationship("subscriptions", input.subscriptionId),
            territory: relationship("territories", point.territory),
            subscriptionPricePoint: relationship(
              "subscriptionPricePoints",
              point.id,
            ),
          },
        },
      });
      done.push(point.territory);
    }
  } catch (error) {
    throw new UploadIncompleteError(
      `Pricing stopped partway: ${done.length} of ${planned.length} territories were priced${done.length > 0 ? ` (${done.join(", ")})` : ""}. Run the command again to finish.`,
      { cause: error },
    );
  }
  return { dryRun: false, ...plan };
}

export const subscriptionAvailabilityInput = z.object({
  subscriptionId: idSchema("subscriptions"),
  ...territoriesInput,
  planType: z.enum(PLAN_TYPES).default("UPFRONT"),
  yes: z.boolean().default(false),
});

/**
 * Sets the territories a subscription plan is sold in, replacing the current
 * list, through Apple's subscription plan availabilities (which replaced
 * subscription availabilities).
 */
export async function setSubscriptionAvailability(
  client: AscClient,
  input: z.output<typeof subscriptionAvailabilityInput>,
) {
  const plans = await unlessMissing(
    readList(
      client,
      `/v1/subscriptions/${input.subscriptionId}/planAvailabilities`,
      { include: ["availableTerritories"], "limit[availableTerritories]": 50 },
    ),
  );
  const existing = plans?.data.find(
    (item) => (item.attributes?.planType ?? "UPFRONT") === input.planType,
  );
  const currentTerritories = existing
    ? (
        await readList(
          client,
          `/v1/subscriptionPlanAvailabilities/${existing.id}/availableTerritories`,
        )
      ).data.map((item) => item.id)
    : [];
  const territories = await chooseTerritories(client, input);
  const availableInNewTerritories =
    input.availableInNewTerritories ??
    (existing?.attributes?.availableInNewTerritories as boolean | undefined) ??
    false;
  const plan = {
    subscriptionId: input.subscriptionId,
    planType: input.planType,
    current: existing
      ? {
          id: existing.id,
          availableInNewTerritories:
            existing.attributes?.availableInNewTerritories ?? null,
          territoryCount: currentTerritories.length,
        }
      : null,
    availableInNewTerritories,
    territoryCount: territories.length,
    ...territoryChanges(currentTerritories, territories),
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const availableTerritories = {
    data: territories.map((id) => ({ type: "territories", id })),
  };
  if (existing) {
    await client.patch(`/v1/subscriptionPlanAvailabilities/${existing.id}`, {
      data: {
        type: "subscriptionPlanAvailabilities",
        id: existing.id,
        attributes: { availableInNewTerritories },
        relationships: { availableTerritories },
      },
    });
  } else {
    await client.post("/v1/subscriptionPlanAvailabilities", {
      data: {
        type: "subscriptionPlanAvailabilities",
        attributes: { availableInNewTerritories, planType: input.planType },
        relationships: {
          subscription: relationship("subscriptions", input.subscriptionId),
          availableTerritories,
        },
      },
    });
  }
  return { dryRun: false, ...plan };
}

/** Uploads the screenshot App Review sees for a subscription, replacing any old one. */
export async function uploadSubscriptionReviewScreenshot(
  client: AscClient,
  input: z.output<typeof reviewScreenshotInput>,
) {
  return {
    subscriptionId: input.id,
    ...(await uploadReviewScreenshot(client, {
      type: "subscriptionAppStoreReviewScreenshots",
      parent: {
        relationship: "subscription",
        type: "subscriptions",
        id: input.id,
      },
      currentPath: `/v1/subscriptions/${input.id}/appStoreReviewScreenshot`,
      file: input.file,
      yes: input.yes,
    })),
  };
}

export const submitSubscriptionInput = z.object({
  subscriptionId: idSchema("subscriptions"),
  yes: z.boolean().default(false),
});

/** Submits a subscription for review; a group's first subscription goes with the next app version. */
export async function submitSubscription(
  client: AscClient,
  input: z.output<typeof submitSubscriptionInput>,
) {
  const { data } = await client.get<{ data: AscResource<Attributes> }>(
    `/v1/subscriptions/${input.subscriptionId}`,
  );
  const subscription = shapeSubscription(data);
  requireSubmittable(
    subscription.state,
    `Subscription ${input.subscriptionId}`,
  );
  if (!input.yes) return { dryRun: true, subscription };
  await client.post("/v1/subscriptionSubmissions", {
    data: {
      type: "subscriptionSubmissions",
      relationships: {
        subscription: relationship("subscriptions", input.subscriptionId),
      },
    },
  });
  return { dryRun: false, subscription };
}
