import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscQuery,
  type AscResource,
  pageInfo,
  related,
} from "../asc/client.ts";
import { appIdSchema, commaList } from "../schemas/common.ts";
import {
  AscApiError,
  InvalidInputError,
  NotFoundError,
} from "../utils/errors.ts";

/**
 * An App Store territory code. Assumption: territory resource IDs are
 * ISO 3166-1 alpha-3 codes such as USA, as the customer review territory
 * filter uses; Apple's territory page does not say.
 */
export const territorySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Must be a territory code such as USA, GBR or SGP.");

interface PriceAttributes {
  startDate?: string | null;
  endDate?: string | null;
}

/** Every page of a list, following each page's cursor. */
export async function allPages<Attributes>(
  client: AscClient,
  path: string,
  query: AscQuery,
): Promise<AscDocument<Attributes>> {
  const data: AscResource<Attributes>[] = [];
  const included: AscResource[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.get<AscDocument<Attributes>>(path, {
      ...query,
      cursor,
    });
    data.push(...page.data);
    included.push(...(page.included ?? []));
    cursor = pageInfo(page).nextCursor;
  } while (cursor);
  return { data, included };
}

export const pricingInput = z.object({
  appId: appIdSchema,
  territory: commaList(territorySchema),
});

/**
 * An app's price schedule: its base territory, the prices set by hand
 * (usually the base territory's, current and scheduled) and the prices
 * Apple derives from them for every other territory.
 */
export async function getPricing(
  client: AscClient,
  input: z.output<typeof pricingInput>,
) {
  const schedule = await client.get<{
    data: AscResource;
    included?: AscResource[];
  }>(`/v1/apps/${input.appId}/appPriceSchedule`, {
    include: ["baseTerritory"],
    "fields[territories]": ["currency"],
  });
  const baseTerritory = schedule.data.relationships?.baseTerritory?.data?.id;
  const query: AscQuery = {
    include: ["appPricePoint", "territory"],
    "fields[appPrices]": [
      "manual",
      "startDate",
      "endDate",
      "appPricePoint",
      "territory",
    ],
    "fields[appPricePoints]": ["customerPrice", "proceeds"],
    "fields[territories]": ["currency"],
    "filter[territory]": input.territory,
    limit: 200,
  };
  const shape = (document: AscDocument<PriceAttributes>) =>
    document.data.map((price) => {
      const point = related<{ customerPrice?: string; proceeds?: string }>(
        document,
        price,
        "appPricePoint",
      );
      return {
        territory: price.relationships?.territory?.data?.id,
        currency: related<{ currency?: string }>(document, price, "territory")
          ?.currency,
        customerPrice: point?.customerPrice,
        proceeds: point?.proceeds,
        startDate: price.attributes?.startDate ?? null,
        endDate: price.attributes?.endDate ?? null,
      };
    });
  const scheduleId = schedule.data.id;
  const manual = await allPages<PriceAttributes>(
    client,
    `/v1/appPriceSchedules/${scheduleId}/manualPrices`,
    query,
  );
  const automatic = await allPages<PriceAttributes>(
    client,
    `/v1/appPriceSchedules/${scheduleId}/automaticPrices`,
    query,
  );
  return {
    appId: input.appId,
    baseTerritory: {
      id: baseTerritory,
      currency: related<{ currency?: string }>(
        schedule,
        schedule.data,
        "baseTerritory",
      )?.currency,
    },
    manualPrices: shape(manual),
    automaticPrices: shape(automatic),
  };
}

/** A calendar date such as 2026-12-01, the form of Apple's price and offer dates. */
export const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date such as 2026-12-01.");

/** A customer price in the territory's currency, matched to the nearest of Apple's price points. */
export const priceSchema = z.coerce
  .number({ error: "Give the price with --price, such as 4.99." })
  .min(0, "A price cannot be negative.")
  .max(1_000_000);

/** `--override GBR=3.99`: a territory priced by hand instead of from the base territory. */
export const overridesSchema = z
  .array(
    z
      .string()
      .trim()
      .regex(
        /^[A-Za-z]{3}=\d+(\.\d+)?$/,
        "Each --override must be a territory and price such as GBR=3.99.",
      )
      .transform((value) => {
        const [territory = "", price = ""] = value.split("=");
        return { territory: territory.toUpperCase(), price: Number(price) };
      }),
  )
  .default([]);

/** Today as YYYY-MM-DD. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** One of Apple's price points, with the price asked for when it was matched. */
export interface PricePoint {
  id: string;
  territory: string;
  customerPrice: string | null;
  proceeds: string | null;
  requestedPrice?: number;
}

function shapePoint(
  point: AscResource<{ customerPrice?: string; proceeds?: string }>,
  territory: string,
): PricePoint {
  return {
    id: point.id,
    territory: point.relationships?.territory?.data?.id ?? territory,
    customerPrice: point.attributes?.customerPrice ?? null,
    proceeds: point.attributes?.proceeds ?? null,
  };
}

/**
 * The price point nearest to `price` among a territory's points at `path`
 * (an app's, an in-app purchase's or a subscription's). Prices are Apple's
 * points, not free amounts, so the result says what was asked for and what
 * the point charges; a tie goes to the lower price.
 */
export async function nearestPricePoint(
  client: AscClient,
  path: string,
  territory: string,
  price: number,
): Promise<PricePoint> {
  const points = await allPages<{ customerPrice?: string; proceeds?: string }>(
    client,
    path,
    { "filter[territory]": [territory], include: ["territory"], limit: 200 },
  );
  let best: PricePoint | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const point of points.data) {
    const shaped = shapePoint(point, territory);
    const value = Number(shaped.customerPrice);
    if (!Number.isFinite(value)) continue;
    const gap = Math.abs(value - price);
    if (gap < distance) {
      best = shaped;
      distance = gap;
    }
  }
  if (!best) {
    throw new NotFoundError(
      `App Store Connect has no price points in ${territory}; check the territory code.`,
    );
  }
  return { ...best, requestedPrice: price };
}

/** A price point's equivalents in every other territory, as Apple equalizes them. */
export async function equalizations(
  client: AscClient,
  path: string,
): Promise<PricePoint[]> {
  const points = await allPages<{ customerPrice?: string; proceeds?: string }>(
    client,
    path,
    { include: ["territory"], limit: 200 },
  );
  return points.data.map((point) => shapePoint(point, ""));
}

/** One manual price in a price schedule: a price point from a start date (null: already in effect). */
export interface ScheduledPrice {
  territory: string;
  pricePointId: string;
  customerPrice: string | null;
  startDate: string | null;
  endDate: string | null;
}

/**
 * The manual prices of a new price schedule, which replaces the whole old
 * one: `prices` from `startDate` (null: now), and the old manual prices kept
 * around them. Ended prices are dropped; an old price in effect before the
 * new one ends when it starts; old scheduled changes are kept (later ones
 * still apply after the new price) unless `dropScheduled`. End dates are
 * recomputed so each territory's prices follow one another.
 */
export function planSchedule(
  existing: ScheduledPrice[],
  prices: Omit<ScheduledPrice, "startDate" | "endDate">[],
  startDate: string | null,
  dropScheduled: boolean,
  on: string,
): ScheduledPrice[] {
  const setting = new Set(prices.map((price) => price.territory));
  const kept = existing
    .filter((price) => !(price.endDate !== null && price.endDate <= on))
    .map((price) => ({
      ...price,
      startDate:
        price.startDate !== null && price.startDate > on
          ? price.startDate
          : null,
    }))
    .filter((price) => {
      if (dropScheduled && price.startDate !== null) return false;
      if (!setting.has(price.territory)) return true;
      // A price already in effect gives way to one starting now; others give way only on the same date.
      if (startDate === null) return price.startDate !== null;
      return price.startDate !== startDate;
    });
  const all = [
    ...kept,
    ...prices.map((price) => ({ ...price, startDate, endDate: null })),
  ];
  const byTerritory = new Map<string, ScheduledPrice[]>();
  for (const price of all) {
    byTerritory.set(price.territory, [
      ...(byTerritory.get(price.territory) ?? []),
      price,
    ]);
  }
  const result: ScheduledPrice[] = [];
  for (const [, list] of [...byTerritory].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    list.sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""));
    list.forEach((price, index) => {
      result.push({ ...price, endDate: list[index + 1]?.startDate ?? null });
    });
  }
  return result;
}

/** The inline price resources of a schedule create request, with the temporary IDs Apple's inline creates use. */
export function inlinePrices(
  type: string,
  pricePoint: { relationship: string; type: string },
  prices: ScheduledPrice[],
  extra: Record<string, unknown> = {},
) {
  return prices.map((price, index) => ({
    type,
    id: `\${price-${index}}`,
    attributes: { startDate: price.startDate, endDate: price.endDate },
    relationships: {
      ...extra,
      [pricePoint.relationship]: {
        data: { type: pricePoint.type, id: price.pricePointId },
      },
    },
  }));
}

/** A schedule's manual prices, with the price point each one uses. */
export async function readManualPrices(
  client: AscClient,
  path: string,
  pricePoint: string,
): Promise<ScheduledPrice[]> {
  const document = await allPages<PriceAttributes>(client, path, {
    include: [pricePoint, "territory"],
    limit: 200,
  });
  return document.data.map((price) => ({
    territory: price.relationships?.territory?.data?.id ?? "",
    pricePointId: price.relationships?.[pricePoint]?.data?.id ?? "",
    customerPrice:
      related<{ customerPrice?: string }>(document, price, pricePoint)
        ?.customerPrice ?? null,
    startDate: price.attributes?.startDate?.slice(0, 10) ?? null,
    endDate: price.attributes?.endDate?.slice(0, 10) ?? null,
  }));
}

/** The base territory's price and any overrides, each matched to a price point at `path`. */
export async function resolvePrices(
  client: AscClient,
  path: string,
  baseTerritory: string,
  price: number,
  overrides: { territory: string; price: number }[],
): Promise<PricePoint[]> {
  const result = [await nearestPricePoint(client, path, baseTerritory, price)];
  for (const override of overrides) {
    if (override.territory === baseTerritory) {
      throw new InvalidInputError(
        `--override ${override.territory} is the base territory; give its price with --price.`,
      );
    }
    result.push(
      await nearestPricePoint(client, path, override.territory, override.price),
    );
  }
  return result;
}

export const setPricingInput = z.object({
  appId: appIdSchema,
  baseTerritory: territorySchema,
  price: priceSchema,
  override: overridesSchema,
  startDate: dateSchema.optional(),
  dropScheduled: z.boolean().default(false),
  yes: z.boolean().default(false),
});

/**
 * Replaces an app's price schedule: the base territory's price (Apple
 * derives every other territory's from it) and any territories priced by
 * hand, from a start date or now. Without `yes`, shows the current manual
 * prices and the planned ones, with the price point each price matched.
 */
export async function setPricing(
  client: AscClient,
  input: z.output<typeof setPricingInput>,
) {
  const current = await client
    .get<{ data: AscResource }>(`/v1/apps/${input.appId}/appPriceSchedule`)
    .catch((error: unknown) => {
      // An app never priced has no schedule.
      if (error instanceof AscApiError && error.status === 404) return null;
      throw error;
    });
  const existing = current
    ? await readManualPrices(
        client,
        `/v1/appPriceSchedules/${current.data.id}/manualPrices`,
        "appPricePoint",
      )
    : [];
  const points = await resolvePrices(
    client,
    `/v1/apps/${input.appId}/appPricePoints`,
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
    appId: input.appId,
    baseTerritory: {
      current: current?.data.relationships?.baseTerritory?.data?.id ?? null,
      new: input.baseTerritory,
    },
    matchedPrices: points,
    currentManualPrices: existing,
    newManualPrices: planned,
  };
  if (!input.yes) return { dryRun: true, ...plan };
  await client.post("/v1/appPriceSchedules", {
    data: {
      type: "appPriceSchedules",
      relationships: {
        app: { data: { type: "apps", id: input.appId } },
        baseTerritory: {
          data: { type: "territories", id: input.baseTerritory },
        },
        manualPrices: {
          data: planned.map((_, index) => ({
            type: "appPrices",
            id: `\${price-${index}}`,
          })),
        },
      },
    },
    included: inlinePrices(
      "appPrices",
      { relationship: "appPricePoint", type: "appPricePoints" },
      planned,
    ),
  });
  return { dryRun: false, ...plan };
}
