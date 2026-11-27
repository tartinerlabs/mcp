import { open, stat } from "node:fs/promises";
import * as z from "zod";
import type { AscClient, AscResource } from "../asc/client.ts";
import { idSchema } from "../schemas/common.ts";
import { InvalidInputError, UploadIncompleteError } from "../utils/errors.ts";
import {
  getSubscription,
  planSubscriptionPrices,
  readSubscriptionPrices,
} from "./iap.ts";
import {
  dateSchema,
  overridesSchema,
  type PricePoint,
  priceSchema,
  territorySchema,
  today,
} from "./pricing.ts";

/**
 * Subscription offers: introductory offers per territory, promotional
 * offers, offer codes with their one-time and custom codes, and win-back
 * offers. Paid offers are priced from one price in a base territory,
 * equalized by Apple to the other territories the subscription is priced in.
 *
 * One-time codes are vouchers: they are written only to a new file the user
 * names (mode 600), never to stdout, errors or logs.
 */

export const OFFER_MODES = [
  "FREE_TRIAL",
  "PAY_AS_YOU_GO",
  "PAY_UP_FRONT",
] as const;

export const OFFER_DURATIONS = [
  "THREE_DAYS",
  "ONE_WEEK",
  "TWO_WEEKS",
  "ONE_MONTH",
  "TWO_MONTHS",
  "THREE_MONTHS",
  "SIX_MONTHS",
  "ONE_YEAR",
] as const;

export const CUSTOMER_ELIGIBILITIES = ["NEW", "EXISTING", "EXPIRED"] as const;

export const OFFER_ELIGIBILITIES = [
  "STACK_WITH_INTRO_OFFERS",
  "REPLACE_INTRO_OFFERS",
] as const;

const subscriptionId = idSchema("subscriptions");

/** What every offer takes: its mode, the length of a period and how many periods. */
const offerTerms = {
  mode: z.enum(OFFER_MODES, {
    error: `Give the offer type with --mode: ${OFFER_MODES.join(", ")}.`,
  }),
  duration: z.enum(OFFER_DURATIONS, {
    error: `Give the period length with --duration: ${OFFER_DURATIONS.join(", ")}.`,
  }),
  periods: z.coerce.number().int().min(1).max(12).default(1),
  baseTerritory: territorySchema.optional(),
  price: priceSchema.optional(),
  override: overridesSchema,
};

type OfferTerms = {
  mode: (typeof OFFER_MODES)[number];
  baseTerritory?: string;
  price?: number;
  override: { territory: string; price: number }[];
};

/** A territory's offer price: a price point, or none for a free trial. */
interface OfferPrice {
  territory: string;
  pricePointId: string | null;
  customerPrice: string | null;
  requestedPrice?: number;
}

/**
 * The offer's price in each territory the subscription is priced in (or
 * `territories`): none for a free trial, otherwise the base territory's
 * nearest point equalized to the others.
 */
async function offerPrices(
  client: AscClient,
  id: string,
  terms: OfferTerms,
  territories?: string[],
): Promise<OfferPrice[]> {
  const priced = (
    await readSubscriptionPrices(client, `/v1/subscriptions/${id}`, today())
  ).prices.flatMap((price) => price.territory ?? []);
  if (priced.length === 0) {
    throw new InvalidInputError(
      `Subscription ${id} has no prices yet; price it with subscriptions price before adding offers.`,
    );
  }
  const wanted = territories
    ? priced.filter((code) => territories.includes(code))
    : priced;
  const missing = (territories ?? []).filter((code) => !priced.includes(code));
  if (missing.length > 0) {
    throw new InvalidInputError(
      `Subscription ${id} is not priced in ${missing.join(", ")}.`,
    );
  }
  if (terms.mode === "FREE_TRIAL") {
    if (terms.price !== undefined || terms.override.length > 0) {
      throw new InvalidInputError("A free trial takes no --price.");
    }
    return wanted.map((territory) => ({
      territory,
      pricePointId: null,
      customerPrice: null,
    }));
  }
  if (terms.price === undefined || terms.baseTerritory === undefined) {
    throw new InvalidInputError(
      `A ${terms.mode} offer needs --price and --base-territory, such as --base-territory USA --price 0.99.`,
    );
  }
  const points: PricePoint[] = await planSubscriptionPrices(
    client,
    id,
    {
      baseTerritory: terms.baseTerritory,
      price: terms.price,
      override: terms.override,
    },
    wanted,
  );
  return points.map((point) => ({
    territory: point.territory,
    pricePointId: point.id,
    customerPrice: point.customerPrice,
    ...(point.requestedPrice === undefined
      ? {}
      : { requestedPrice: point.requestedPrice }),
  }));
}

function relationship(type: string, id: string) {
  return { data: { type, id } };
}

/** Inline price resources for an offer's create or update request. */
function inlineOfferPrices(type: string, prices: OfferPrice[]) {
  return prices.map((price, index) => ({
    type,
    id: `\${price-${index}}`,
    relationships: {
      territory: relationship("territories", price.territory),
      ...(price.pricePointId
        ? {
            subscriptionPricePoint: relationship(
              "subscriptionPricePoints",
              price.pricePointId,
            ),
          }
        : {}),
    },
  }));
}

function priceLinks(type: string, prices: OfferPrice[]) {
  return {
    data: prices.map((_, index) => ({ type, id: `\${price-${index}}` })),
  };
}

function showPrices(prices: OfferPrice[]) {
  return prices.map(({ pricePointId: _id, ...rest }) => rest);
}

export const offersInput = z.object({ subscriptionId });

/**
 * A subscription's offers: introductory offers not yet ended, promotional
 * offers, offer codes with their one-time code batches and custom codes
 * (counts and dates, never the one-time codes), and win-back offers not yet
 * ended.
 */
export async function listOffers(
  client: AscClient,
  input: z.output<typeof offersInput>,
) {
  const subscription = await getSubscription(client, input);
  const offerCodes = [];
  for (const code of subscription.offerCodes) {
    const batches = await client.get<{ data: AscResource[] }>(
      `/v1/subscriptionOfferCodes/${code.id}/oneTimeUseCodes`,
      { limit: 200 },
    );
    const custom = await client.get<{ data: AscResource[] }>(
      `/v1/subscriptionOfferCodes/${code.id}/customCodes`,
      { limit: 200 },
    );
    offerCodes.push({
      ...code,
      oneTimeUseCodes: batches.data.map(({ id, attributes }) => ({
        id,
        numberOfCodes: attributes?.numberOfCodes ?? null,
        environment: attributes?.environment ?? null,
        createdDate: attributes?.createdDate ?? null,
        expirationDate: attributes?.expirationDate ?? null,
        active: attributes?.active ?? null,
      })),
      customCodes: custom.data.map(({ id, attributes }) => ({
        id,
        customCode: attributes?.customCode ?? null,
        numberOfCodes: attributes?.numberOfCodes ?? null,
        expirationDate: attributes?.expirationDate ?? null,
        active: attributes?.active ?? null,
      })),
    });
  }
  return {
    subscription: subscription.subscription,
    introductoryOffers: subscription.introductoryOffers,
    promotionalOffers: subscription.promotionalOffers,
    offerCodes,
    winBackOffers: subscription.winBackOffers,
  };
}

const territoryList = z.array(territorySchema).max(200).optional();

export const createIntroOfferInput = z.object({
  subscriptionId,
  ...offerTerms,
  territories: territoryList,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  yes: z.boolean().default(false),
});

/**
 * Creates an introductory offer in each territory the subscription is
 * priced in, or the ones given; Apple keeps one introductory offer per
 * territory and period of time, so it refuses an overlapping one.
 */
export async function createIntroOffer(
  client: AscClient,
  input: z.output<typeof createIntroOfferInput>,
) {
  const prices = await offerPrices(
    client,
    input.subscriptionId,
    input,
    input.territories,
  );
  const attributes = {
    offerMode: input.mode,
    duration: input.duration,
    numberOfPeriods: input.periods,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
  };
  const plan = {
    subscriptionId: input.subscriptionId,
    attributes,
    prices: showPrices(prices),
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const created: string[] = [];
  try {
    for (const price of prices) {
      await client.post("/v1/subscriptionIntroductoryOffers", {
        data: {
          type: "subscriptionIntroductoryOffers",
          attributes,
          relationships: {
            subscription: relationship("subscriptions", input.subscriptionId),
            territory: relationship("territories", price.territory),
            ...(price.pricePointId
              ? {
                  subscriptionPricePoint: relationship(
                    "subscriptionPricePoints",
                    price.pricePointId,
                  ),
                }
              : {}),
          },
        },
      });
      created.push(price.territory);
    }
  } catch (error) {
    throw new UploadIncompleteError(
      `Creating introductory offers stopped partway: ${created.length} of ${prices.length} territories were done${created.length > 0 ? ` (${created.join(", ")})` : ""}. Leave those out with --territory and run the command again.`,
      { cause: error },
    );
  }
  return { dryRun: false, ...plan };
}

export const endIntroOfferInput = z.object({
  subscriptionId,
  territories: territoryList,
  endDate: dateSchema.optional(),
  yes: z.boolean().default(false),
});

/**
 * Ends a subscription's introductory offers, in every territory or the ones
 * given: on `endDate`, or at once by deleting them.
 */
export async function endIntroOffers(
  client: AscClient,
  input: z.output<typeof endIntroOfferInput>,
) {
  const { introductoryOffers } = await getSubscription(client, input);
  const offers = introductoryOffers.filter(
    (offer) =>
      !input.territories ||
      (offer.territory !== null && input.territories.includes(offer.territory)),
  );
  if (offers.length === 0) {
    throw new InvalidInputError(
      `Subscription ${input.subscriptionId} has no introductory offers that have not ended${input.territories ? ` in ${input.territories.join(", ")}` : ""}.`,
    );
  }
  const plan = {
    subscriptionId: input.subscriptionId,
    action: input.endDate ? "set-end-date" : "delete",
    endDate: input.endDate ?? null,
    offers,
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const done: string[] = [];
  try {
    for (const offer of offers) {
      const path = `/v1/subscriptionIntroductoryOffers/${offer.id}`;
      if (input.endDate) {
        await client.patch(path, {
          data: {
            type: "subscriptionIntroductoryOffers",
            id: offer.id,
            attributes: { endDate: input.endDate },
          },
        });
      } else {
        await client.delete(path);
      }
      done.push(offer.territory ?? offer.id);
    }
  } catch (error) {
    throw new UploadIncompleteError(
      `Ending introductory offers stopped partway${done.length > 0 ? `; already done: ${done.join(", ")}` : ""}. Run the command again to finish.`,
      { cause: error },
    );
  }
  return { dryRun: false, ...plan };
}

const offerName = z
  .string({ error: "Give the offer's reference name with --name." })
  .trim()
  .min(1)
  .max(64);

export const createPromoOfferInput = z.object({
  subscriptionId,
  name: offerName,
  code: z
    .string({ error: "Give the identifier your app uses with --code." })
    .trim()
    .regex(
      /^[A-Za-z0-9._-]{1,64}$/,
      "The offer identifier uses letters, digits, periods, hyphens and underscores.",
    ),
  ...offerTerms,
  yes: z.boolean().default(false),
});

/** Creates a promotional offer, which the app presents to existing or lapsed subscribers with a signature. */
export async function createPromoOffer(
  client: AscClient,
  input: z.output<typeof createPromoOfferInput>,
) {
  const prices = await offerPrices(client, input.subscriptionId, input);
  const attributes = {
    name: input.name,
    offerCode: input.code,
    offerMode: input.mode,
    duration: input.duration,
    numberOfPeriods: input.periods,
  };
  const plan = {
    subscriptionId: input.subscriptionId,
    attributes,
    prices: showPrices(prices),
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const type = "subscriptionPromotionalOfferPrices";
  const { data } = await client.post<{ data: AscResource }>(
    "/v1/subscriptionPromotionalOffers",
    {
      data: {
        type: "subscriptionPromotionalOffers",
        attributes,
        relationships: {
          subscription: relationship("subscriptions", input.subscriptionId),
          prices: priceLinks(type, prices),
        },
      },
      included: inlineOfferPrices(type, prices),
    },
  );
  return { dryRun: false, ...plan, id: data.id };
}

export const setPromoOfferInput = z.object({
  offerId: idSchema("subscriptions offers"),
  baseTerritory: territorySchema,
  price: priceSchema,
  override: overridesSchema,
  yes: z.boolean().default(false),
});

/** Replaces a paid promotional offer's prices; its other terms cannot change. */
export async function setPromoOffer(
  client: AscClient,
  input: z.output<typeof setPromoOfferInput>,
) {
  const path = `/v1/subscriptionPromotionalOffers/${input.offerId}`;
  const { data } = await client.get<{ data: AscResource }>(path, {
    include: ["subscription"],
  });
  const parent = data.relationships?.subscription?.data?.id;
  const mode = data.attributes?.offerMode as OfferTerms["mode"] | undefined;
  if (!parent || !mode) {
    throw new InvalidInputError(
      `Could not read the subscription or mode of promotional offer ${input.offerId}.`,
    );
  }
  const prices = await offerPrices(client, parent, { ...input, mode });
  const plan = {
    offerId: input.offerId,
    subscriptionId: parent,
    offer: data.attributes ?? {},
    prices: showPrices(prices),
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const type = "subscriptionPromotionalOfferPrices";
  await client.patch(path, {
    data: {
      type: "subscriptionPromotionalOffers",
      id: input.offerId,
      relationships: { prices: priceLinks(type, prices) },
    },
    included: inlineOfferPrices(type, prices),
  });
  return { dryRun: false, ...plan };
}

export const deleteOfferInput = z.object({
  offerId: idSchema("subscriptions offers"),
  yes: z.boolean().default(false),
});

/** Deletes a promotional offer; apps can no longer redeem it. */
export async function deletePromoOffer(
  client: AscClient,
  input: z.output<typeof deleteOfferInput>,
) {
  const path = `/v1/subscriptionPromotionalOffers/${input.offerId}`;
  const { data } = await client.get<{ data: AscResource }>(path);
  const plan = { offerId: input.offerId, offer: data.attributes ?? {} };
  if (!input.yes) return { dryRun: true, ...plan };
  await client.delete(path);
  return { dryRun: false, ...plan };
}

export const createOfferCodeInput = z.object({
  subscriptionId,
  name: offerName,
  eligibility: z
    .array(z.enum(CUSTOMER_ELIGIBILITIES))
    .min(
      1,
      `Give who may redeem it with --eligibility: ${CUSTOMER_ELIGIBILITIES.join(", ")}.`,
    ),
  offerEligibility: z
    .enum(OFFER_ELIGIBILITIES)
    .default("STACK_WITH_INTRO_OFFERS"),
  autoRenew: z.boolean().optional(),
  ...offerTerms,
  yes: z.boolean().default(false),
});

/** Creates an offer code; generate one-time codes or add custom codes to it afterwards. */
export async function createOfferCode(
  client: AscClient,
  input: z.output<typeof createOfferCodeInput>,
) {
  const prices = await offerPrices(client, input.subscriptionId, input);
  const attributes = {
    name: input.name,
    customerEligibilities: input.eligibility,
    offerEligibility: input.offerEligibility,
    offerMode: input.mode,
    duration: input.duration,
    numberOfPeriods: input.periods,
    autoRenewEnabled: input.autoRenew,
  };
  const plan = {
    subscriptionId: input.subscriptionId,
    attributes,
    prices: showPrices(prices),
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const type = "subscriptionOfferCodePrices";
  const { data } = await client.post<{ data: AscResource }>(
    "/v1/subscriptionOfferCodes",
    {
      data: {
        type: "subscriptionOfferCodes",
        attributes,
        relationships: {
          subscription: relationship("subscriptions", input.subscriptionId),
          prices: priceLinks(type, prices),
        },
      },
      included: inlineOfferPrices(type, prices),
    },
  );
  return { dryRun: false, ...plan, id: data.id };
}

const offerCodeId = idSchema("subscriptions offers");

const outSchema = z
  .string({ error: "Give a new file for the codes with --out." })
  .min(1);

/** Opens a new file for codes, refusing one that exists; mode 600 keeps it private. */
async function createCodeFile(path: string) {
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new InvalidInputError(
      code === "EEXIST"
        ? `${path} already exists; name a new file with --out.`
        : `Could not create ${path}.`,
      { cause: error },
    );
  }
}

/** Fetches a batch's codes as Apple's CSV into the file; the codes are never returned. */
async function saveCodes(client: AscClient, batchId: string, out: string) {
  const file = await createCodeFile(out);
  try {
    const csv = await client.download(
      `/v1/subscriptionOfferCodeOneTimeUseCodes/${batchId}/values`,
      {},
      { accept: "text/csv" },
    );
    await file.writeFile(csv);
    // Rows less the header line.
    const lines = new TextDecoder()
      .decode(csv)
      .split("\n")
      .filter((line) => line.trim() !== "");
    return Math.max(lines.length - 1, 0);
  } finally {
    await file.close();
  }
}

export const generateCodesInput = z.object({
  offerCodeId,
  count: z.coerce
    .number({ error: "Give how many codes with --count." })
    .int()
    .min(1)
    .max(25_000),
  expires: dateSchema,
  environment: z.enum(["PRODUCTION", "SANDBOX"]).default("PRODUCTION"),
  out: outSchema,
  yes: z.boolean().default(false),
});

/**
 * Generates a batch of one-time codes and writes them to a new file. The
 * codes never appear in the output: it gives the batch and the file.
 */
export async function generateCodes(
  client: AscClient,
  input: z.output<typeof generateCodesInput>,
) {
  const { data } = await client.get<{ data: AscResource }>(
    `/v1/subscriptionOfferCodes/${input.offerCodeId}`,
  );
  const plan = {
    offerCodeId: input.offerCodeId,
    offerCode: {
      name: data.attributes?.name ?? null,
      active: data.attributes?.active ?? null,
    },
    numberOfCodes: input.count,
    expirationDate: input.expires,
    environment: input.environment,
    out: input.out,
  };
  if (!input.yes) {
    // Say now, rather than after Apple has made the codes, that the file is taken.
    const exists = await stat(input.out).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw new InvalidInputError(
        `${input.out} already exists; name a new file with --out.`,
      );
    }
    return { dryRun: true, ...plan };
  }
  const batch = await client.post<{ data: AscResource }>(
    "/v1/subscriptionOfferCodeOneTimeUseCodes",
    {
      data: {
        type: "subscriptionOfferCodeOneTimeUseCodes",
        attributes: {
          numberOfCodes: input.count,
          expirationDate: input.expires,
          environment: input.environment,
        },
        relationships: {
          offerCode: relationship("subscriptionOfferCodes", input.offerCodeId),
        },
      },
    },
  );
  try {
    const saved = await saveCodes(client, batch.data.id, input.out);
    return { dryRun: false, ...plan, batchId: batch.data.id, saved };
  } catch (error) {
    throw new UploadIncompleteError(
      `Apple made batch ${batch.data.id} but its codes were not saved; fetch them with subscriptions offers codes ${batch.data.id} --out <new file> (Apple may take a moment to make them).`,
      { cause: error },
    );
  }
}

export const saveCodesInput = z.object({
  batchId: idSchema("subscriptions offers"),
  out: outSchema,
});

/** Writes an existing batch's one-time codes to a new file. */
export async function saveCodeBatch(
  client: AscClient,
  input: z.output<typeof saveCodesInput>,
) {
  const saved = await saveCodes(client, input.batchId, input.out);
  return { batchId: input.batchId, out: input.out, saved };
}

export const customCodeInput = z.object({
  offerCodeId,
  code: z
    .string({ error: "Give the code customers type with --code." })
    .trim()
    .regex(/^[A-Za-z0-9]{1,64}$/, "A custom code uses letters and digits."),
  count: z.coerce
    .number({ error: "Give how many redemptions with --count." })
    .int()
    .min(1)
    .max(1_000_000),
  expires: dateSchema.optional(),
  yes: z.boolean().default(false),
});

/** Adds a custom code, such as SUMMER, that customers can redeem up to `count` times. */
export async function createCustomCode(
  client: AscClient,
  input: z.output<typeof customCodeInput>,
) {
  const plan = {
    offerCodeId: input.offerCodeId,
    customCode: input.code,
    numberOfCodes: input.count,
    expirationDate: input.expires ?? null,
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const { data } = await client.post<{ data: AscResource }>(
    "/v1/subscriptionOfferCodeCustomCodes",
    {
      data: {
        type: "subscriptionOfferCodeCustomCodes",
        attributes: {
          customCode: input.code,
          numberOfCodes: input.count,
          expirationDate: input.expires,
        },
        relationships: {
          offerCode: relationship("subscriptionOfferCodes", input.offerCodeId),
        },
      },
    },
  );
  return { dryRun: false, ...plan, id: data.id };
}

export const deactivateCodeInput = z.object({
  offerCodeId,
  yes: z.boolean().default(false),
});

/** Ends an offer code: none of its codes can be redeemed any more. Apple cannot turn it back on. */
export async function deactivateOfferCode(
  client: AscClient,
  input: z.output<typeof deactivateCodeInput>,
) {
  const path = `/v1/subscriptionOfferCodes/${input.offerCodeId}`;
  const { data } = await client.get<{ data: AscResource }>(path);
  const plan = {
    offerCodeId: input.offerCodeId,
    name: data.attributes?.name ?? null,
    active: data.attributes?.active ?? null,
  };
  if (!input.yes || plan.active === false) {
    return { dryRun: !input.yes, ...plan };
  }
  await client.patch(path, {
    data: {
      type: "subscriptionOfferCodes",
      id: input.offerCodeId,
      attributes: { active: false },
    },
  });
  return { dryRun: false, ...plan, active: false };
}

const months = z.coerce.number().int().min(0).max(120);

/** Who a win-back offer reaches and when; shared by create and set. */
const winBackRules = {
  paidMonths: months.optional(),
  sinceMin: months.optional(),
  sinceMax: months.optional(),
  waitMonths: months.optional(),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  priority: z.enum(["HIGH", "NORMAL"]).optional(),
  promotionIntent: z
    .enum(["NOT_PROMOTED", "USE_AUTO_GENERATED_ASSETS"])
    .optional(),
};

function winBackAttributes(input: {
  paidMonths?: number;
  sinceMin?: number;
  sinceMax?: number;
  waitMonths?: number;
  startDate?: string;
  endDate?: string;
  priority?: string;
  promotionIntent?: string;
}) {
  const since =
    input.sinceMin === undefined && input.sinceMax === undefined
      ? undefined
      : { minimum: input.sinceMin, maximum: input.sinceMax };
  const attributes = {
    customerEligibilityPaidSubscriptionDurationInMonths: input.paidMonths,
    customerEligibilityTimeSinceLastSubscribedInMonths: since,
    customerEligibilityWaitBetweenOffersInMonths: input.waitMonths,
    startDate: input.startDate,
    endDate: input.endDate,
    priority: input.priority,
    promotionIntent: input.promotionIntent,
  };
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  );
}

export const createWinBackInput = z.object({
  subscriptionId,
  referenceName: offerName,
  offerId: z
    .string({ error: "Give the offer identifier with --offer-id." })
    .trim()
    .regex(
      /^[A-Za-z0-9._-]{1,64}$/,
      "The offer identifier uses letters, digits, periods, hyphens and underscores.",
    ),
  ...offerTerms,
  ...winBackRules,
  yes: z.boolean().default(false),
});

/**
 * Creates a win-back offer for lapsed subscribers who paid for at least
 * `paidMonths` and lapsed between `sinceMin` and `sinceMax` months ago.
 */
export async function createWinBack(
  client: AscClient,
  input: z.output<typeof createWinBackInput>,
) {
  const missing = [
    ["--paid-months", input.paidMonths],
    ["--since-min", input.sinceMin],
    ["--start-date", input.startDate],
  ].filter(([, value]) => value === undefined);
  if (missing.length > 0) {
    throw new InvalidInputError(
      `A win-back offer needs ${missing.map(([name]) => name).join(", ")}.`,
    );
  }
  const prices = await offerPrices(client, input.subscriptionId, input);
  const attributes = {
    referenceName: input.referenceName,
    offerId: input.offerId,
    offerMode: input.mode,
    duration: input.duration,
    periodCount: input.periods,
    priority: "NORMAL",
    ...winBackAttributes(input),
  };
  const plan = {
    subscriptionId: input.subscriptionId,
    attributes,
    prices: showPrices(prices),
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const type = "winBackOfferPrices";
  const { data } = await client.post<{ data: AscResource }>(
    "/v1/winBackOffers",
    {
      data: {
        type: "winBackOffers",
        attributes,
        relationships: {
          subscription: relationship("subscriptions", input.subscriptionId),
          prices: priceLinks(type, prices),
        },
      },
      included: inlineOfferPrices(type, prices),
    },
  );
  return { dryRun: false, ...plan, id: data.id };
}

export const setWinBackInput = z.object({
  offerId: idSchema("subscriptions offers"),
  ...winBackRules,
  yes: z.boolean().default(false),
});

/** Changes a win-back offer's eligibility, dates, priority or promotion; its price and terms cannot change. */
export async function setWinBack(
  client: AscClient,
  input: z.output<typeof setWinBackInput>,
) {
  const path = `/v1/winBackOffers/${input.offerId}`;
  const { data } = await client.get<{ data: AscResource }>(path);
  const changes = winBackAttributes(input);
  if (Object.keys(changes).length === 0) {
    throw new InvalidInputError("Give at least one value to change.");
  }
  const plan = {
    offerId: input.offerId,
    current: data.attributes ?? {},
    changes,
  };
  if (!input.yes) return { dryRun: true, ...plan };
  await client.patch(path, {
    data: { type: "winBackOffers", id: input.offerId, attributes: changes },
  });
  return { dryRun: false, ...plan };
}

/** Deletes a win-back offer. */
export async function deleteWinBack(
  client: AscClient,
  input: z.output<typeof deleteOfferInput>,
) {
  const path = `/v1/winBackOffers/${input.offerId}`;
  const { data } = await client.get<{ data: AscResource }>(path);
  const plan = { offerId: input.offerId, offer: data.attributes ?? {} };
  if (!input.yes) return { dryRun: true, ...plan };
  await client.delete(path);
  return { dryRun: false, ...plan };
}
