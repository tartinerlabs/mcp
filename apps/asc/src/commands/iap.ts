import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscQuery,
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
} from "../schemas/common.ts";
import { AscApiError } from "../utils/errors.ts";
import { allPages } from "./pricing.ts";

/**
 * In-app purchases and auto-renewable subscriptions, read only: each
 * product's type or period, review state, localizations, availability,
 * current prices by territory and offers. Creating or changing products,
 * prices and offers stays in App Store Connect; submitting them is part of
 * the release flow.
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

/** Today as YYYY-MM-DD, the form of Apple's price and offer dates. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
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
async function readSubscriptionPrices(
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
