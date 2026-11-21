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
