import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient, AscQuery } from "../src/asc/client.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";

const PAST = "2000-01-01";
const FUTURE = "2999-01-01";

/** A read-only client answering each path from `routes`; an unknown path is a 404. */
function routed(routes: Record<string, unknown>) {
  const fail = () => Promise.reject(new Error("unexpected write"));
  const client: AscClient = {
    get: vi.fn((path: string, _query?: AscQuery) =>
      path in routes
        ? Promise.resolve(routes[path])
        : Promise.reject(new AscApiError(404, { errors: [] })),
    ) as AscClient["get"],
    post: vi.fn(fail) as AscClient["post"],
    patch: vi.fn(fail) as AscClient["patch"],
    delete: vi.fn(fail) as AscClient["delete"],
    upload: vi.fn(fail) as AscClient["upload"],
    download: vi.fn(fail) as AscClient["download"],
    downloadSigned: vi.fn(fail) as AscClient["downloadSigned"],
  };
  const provider = vi.fn<AscClientProvider>(() => client);
  return { client, provider };
}

async function run(args: string[], provider: AscClientProvider) {
  let stderr = "";
  const program = createProgram(provider);
  const all = (command: Command): Command[] => [
    command,
    ...command.commands.flatMap(all),
  ];
  for (const command of all(program)) {
    command.exitOverride().configureOutput({
      writeErr: (text) => {
        stderr += text;
      },
    });
  }
  const exitCode = await program
    .parseAsync(args, { from: "user" })
    .then(() => 0)
    .catch((error: { exitCode?: number }) => error.exitCode ?? 1);
  const stdout = vi
    .mocked(console.log)
    .mock.calls.map(([text]) => text)
    .join("\n");
  return { exitCode, stdout, stderr };
}

const list = (data: unknown[], included: unknown[] = []) => ({
  data,
  included,
  links: { self: "x" },
});

const territory = (id: string, currency: string) => ({
  type: "territories",
  id,
  attributes: { currency },
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("iap", () => {
  it("should pass filters and shape each in-app purchase", async () => {
    const { client, provider } = routed({
      "/v1/apps/123/inAppPurchasesV2": {
        data: [
          {
            type: "inAppPurchases",
            id: "IAP1",
            attributes: {
              name: "Coins",
              productId: "com.example.coins",
              inAppPurchaseType: "CONSUMABLE",
              state: "READY_TO_SUBMIT",
              familySharable: false,
            },
          },
        ],
        links: {
          self: "x",
          next: "https://api.appstoreconnect.apple.com/v1/x?cursor=NEXT",
        },
        meta: { paging: { total: 2, limit: 1 } },
      },
    });
    const result = await run(
      [
        "iap",
        "123",
        "--type",
        "CONSUMABLE",
        "--state",
        "READY_TO_SUBMIT,REJECTED",
        "--limit",
        "1",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith("/v1/apps/123/inAppPurchasesV2", {
      "filter[inAppPurchaseType]": ["CONSUMABLE"],
      "filter[state]": ["READY_TO_SUBMIT", "REJECTED"],
      limit: 1,
      cursor: undefined,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      inAppPurchases: [
        {
          id: "IAP1",
          referenceName: "Coins",
          productId: "com.example.coins",
          inAppPurchaseType: "CONSUMABLE",
          state: "READY_TO_SUBMIT",
          familySharable: false,
          contentHosting: null,
          reviewNote: null,
        },
      ],
      total: 2,
      hasMore: true,
      nextCursor: "NEXT",
    });
  });

  it("should reject an unknown type", async () => {
    const { provider } = routed({});
    const result = await run(["iap", "123", "--type", "GEMS"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
  });
});

describe("iap show", () => {
  const price = (
    id: string,
    territoryId: string,
    point: string,
    startDate: string | null,
    endDate: string | null,
  ) => ({
    type: "inAppPurchasePrices",
    id,
    attributes: { startDate, endDate },
    relationships: {
      territory: { data: { type: "territories", id: territoryId } },
      inAppPurchasePricePoint: {
        data: { type: "inAppPurchasePricePoints", id: point },
      },
    },
  });

  const routes = {
    "/v2/inAppPurchases/IAP1": {
      data: {
        type: "inAppPurchases",
        id: "IAP1",
        attributes: {
          name: "Pro",
          productId: "com.example.pro",
          inAppPurchaseType: "NON_CONSUMABLE",
          state: "APPROVED",
        },
      },
    },
    "/v2/inAppPurchases/IAP1/inAppPurchaseLocalizations": list([
      {
        type: "inAppPurchaseLocalizations",
        id: "L1",
        attributes: {
          locale: "en-US",
          name: "Pro",
          description: "Unlock everything",
          state: "APPROVED",
        },
      },
    ]),
    "/v2/inAppPurchases/IAP1/inAppPurchaseAvailability": {
      data: {
        type: "inAppPurchaseAvailabilities",
        id: "AV1",
        attributes: { availableInNewTerritories: true },
      },
    },
    "/v1/inAppPurchaseAvailabilities/AV1/availableTerritories": list([
      territory("USA", "USD"),
      territory("JPN", "JPY"),
    ]),
    "/v2/inAppPurchases/IAP1/iapPriceSchedule": {
      data: {
        type: "inAppPurchasePriceSchedules",
        id: "S1",
        relationships: {
          baseTerritory: { data: { type: "territories", id: "USA" } },
        },
      },
      included: [territory("USA", "USD")],
    },
    "/v1/inAppPurchasePriceSchedules/S1/manualPrices": list(
      [
        price("P1", "USA", "PP1", null, PAST),
        price("P2", "USA", "PP2", PAST, null),
        price("P3", "USA", "PP3", FUTURE, null),
      ],
      [
        territory("USA", "USD"),
        {
          type: "inAppPurchasePricePoints",
          id: "PP2",
          attributes: { customerPrice: "4.99", proceeds: "4.24" },
        },
      ],
    ),
    "/v1/inAppPurchasePriceSchedules/S1/automaticPrices": list(
      [price("P4", "JPN", "PP4", null, null)],
      [
        territory("JPN", "JPY"),
        {
          type: "inAppPurchasePricePoints",
          id: "PP4",
          attributes: { customerPrice: "800", proceeds: "680" },
        },
      ],
    ),
    "/v2/inAppPurchases/IAP1/offerCodes": list([
      {
        type: "inAppPurchaseOfferCodes",
        id: "OC1",
        attributes: {
          name: "Launch",
          active: true,
          customerEligibilities: ["NON_SPENDER"],
          productionCodeCount: 500,
          customCode: "SECRET2026",
        },
      },
    ]),
  };

  it("should print localizations, availability, today's prices and offer code counts", async () => {
    const { client, provider } = routed(routes);
    const result = await run(["iap", "show", "IAP1"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/inAppPurchasePriceSchedules/S1/manualPrices",
      expect.objectContaining({
        include: ["inAppPurchasePricePoint", "territory"],
        limit: 200,
      }),
    );
    const output = JSON.parse(result.stdout);
    expect(output.inAppPurchase).toMatchObject({
      id: "IAP1",
      referenceName: "Pro",
      state: "APPROVED",
    });
    expect(output.localizations).toEqual([
      {
        id: "L1",
        locale: "en-US",
        name: "Pro",
        description: "Unlock everything",
        state: "APPROVED",
      },
    ]);
    expect(output.availability).toEqual({
      availableInNewTerritories: true,
      territoryCount: 2,
      territories: ["USA", "JPN"],
    });
    expect(output.baseTerritory).toEqual({ id: "USA", currency: "USD" });
    expect(output.prices).toEqual([
      {
        territory: "JPN",
        currency: "JPY",
        customerPrice: "800",
        proceeds: "680",
        startDate: null,
        manual: false,
      },
      {
        territory: "USA",
        currency: "USD",
        customerPrice: "4.99",
        proceeds: "4.24",
        startDate: PAST,
        manual: true,
      },
    ]);
    expect(output.offerCodes).toEqual([
      expect.objectContaining({
        id: "OC1",
        name: "Launch",
        active: true,
        productionCodeCount: 500,
      }),
    ]);
    expect(result.stdout).not.toContain("SECRET2026");
  });

  it("should print null availability and no prices when none are set up", async () => {
    const {
      "/v2/inAppPurchases/IAP1/inAppPurchaseAvailability": _availability,
      "/v2/inAppPurchases/IAP1/iapPriceSchedule": _schedule,
      "/v2/inAppPurchases/IAP1/offerCodes": _codes,
      ...rest
    } = routes;
    const { provider } = routed(rest);
    const result = await run(["iap", "show", "IAP1"], provider);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      availability: null,
      baseTerritory: null,
      prices: [],
      offerCodes: [],
    });
  });

  it("should report a missing in-app purchase as not found", async () => {
    const { provider } = routed({});
    const result = await run(["iap", "show", "NOPE"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found]");
  });
});

describe("subscriptions", () => {
  it("should list each group's subscriptions by level", async () => {
    const sub = (id: string, groupLevel: number, period: string) => ({
      type: "subscriptions",
      id,
      attributes: {
        name: id,
        productId: `com.example.${id}`,
        state: "APPROVED",
        subscriptionPeriod: period,
        groupLevel,
      },
    });
    const { client, provider } = routed({
      "/v1/apps/123/subscriptionGroups": list([
        {
          type: "subscriptionGroups",
          id: "G1",
          attributes: { referenceName: "Premium" },
        },
      ]),
      "/v1/subscriptionGroups/G1/subscriptions": list([
        sub("monthly", 2, "ONE_MONTH"),
        sub("yearly", 1, "ONE_YEAR"),
      ]),
    });
    const result = await run(["subscriptions", "123"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/subscriptionGroups/G1/subscriptions",
      expect.objectContaining({ limit: 200 }),
    );
    const output = JSON.parse(result.stdout);
    expect(output.subscriptionGroups[0]).toMatchObject({
      id: "G1",
      referenceName: "Premium",
    });
    expect(
      output.subscriptionGroups[0].subscriptions.map(
        (item: { id: string; subscriptionPeriod: string }) => [
          item.id,
          item.subscriptionPeriod,
        ],
      ),
    ).toEqual([
      ["yearly", "ONE_YEAR"],
      ["monthly", "ONE_MONTH"],
    ]);
  });
});

describe("subscriptions show", () => {
  const point = (id: string, customerPrice: string) => ({
    type: "subscriptionPricePoints",
    id,
    attributes: { customerPrice, proceeds: "0" },
  });
  const price = (
    id: string,
    territoryId: string,
    startDate: string | null,
  ) => ({
    type: "subscriptionPrices",
    id,
    attributes: { startDate, preserved: false },
    relationships: {
      territory: { data: { type: "territories", id: territoryId } },
      subscriptionPricePoint: {
        data: { type: "subscriptionPricePoints", id: `PP-${id}` },
      },
    },
  });

  it("should print today's price per territory, scheduled changes and offers in effect", async () => {
    const base = "/v1/subscriptions/SUB1";
    const { provider } = routed({
      [base]: {
        data: {
          type: "subscriptions",
          id: "SUB1",
          attributes: {
            name: "Yearly",
            productId: "com.example.yearly",
            state: "WAITING_FOR_REVIEW",
            subscriptionPeriod: "ONE_YEAR",
            groupLevel: 1,
          },
        },
      },
      [`${base}/subscriptionLocalizations`]: list([]),
      [`${base}/subscriptionAvailability`]: {
        data: {
          type: "subscriptionAvailabilities",
          id: "SA1",
          attributes: { availableInNewTerritories: false },
        },
      },
      "/v1/subscriptionAvailabilities/SA1/availableTerritories": list([
        territory("USA", "USD"),
      ]),
      [`${base}/prices`]: list(
        [
          price("OLD", "USA", null),
          price("NOW", "USA", PAST),
          price("NEXT", "USA", FUTURE),
        ],
        [
          territory("USA", "USD"),
          point("PP-OLD", "29.99"),
          point("PP-NOW", "39.99"),
          point("PP-NEXT", "49.99"),
        ],
      ),
      [`${base}/introductoryOffers`]: list(
        [
          {
            type: "subscriptionIntroductoryOffers",
            id: "IO1",
            attributes: {
              offerMode: "FREE_TRIAL",
              duration: "ONE_WEEK",
              numberOfPeriods: 1,
              startDate: null,
              endDate: null,
            },
            relationships: {
              territory: { data: { type: "territories", id: "USA" } },
            },
          },
          {
            type: "subscriptionIntroductoryOffers",
            id: "IO-ENDED",
            attributes: { offerMode: "PAY_AS_YOU_GO", endDate: PAST },
          },
        ],
        [territory("USA", "USD")],
      ),
      [`${base}/promotionalOffers`]: list([
        {
          type: "subscriptionPromotionalOffers",
          id: "PO1",
          attributes: {
            name: "Come back",
            offerCode: "comeback",
            offerMode: "PAY_UP_FRONT",
            duration: "ONE_MONTH",
            numberOfPeriods: 1,
          },
        },
      ]),
      [`${base}/offerCodes`]: list([
        {
          type: "subscriptionOfferCodes",
          id: "SOC1",
          attributes: {
            name: "Holiday",
            active: true,
            totalNumberOfCodes: 1000,
            offerMode: "FREE_TRIAL",
          },
        },
      ]),
      [`${base}/winBackOffers`]: list([
        {
          type: "winBackOffers",
          id: "WB1",
          attributes: {
            referenceName: "Lapsed",
            offerId: "lapsed",
            startDate: PAST,
            endDate: FUTURE,
          },
        },
        {
          type: "winBackOffers",
          id: "WB-ENDED",
          attributes: { referenceName: "Old", endDate: PAST },
        },
      ]),
    });
    const result = await run(["subscriptions", "show", "SUB1"], provider);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.subscription).toMatchObject({
      id: "SUB1",
      state: "WAITING_FOR_REVIEW",
      subscriptionPeriod: "ONE_YEAR",
    });
    expect(output.availability).toEqual({
      availableInNewTerritories: false,
      territoryCount: 1,
      territories: ["USA"],
    });
    expect(output.prices).toEqual([
      {
        territory: "USA",
        currency: "USD",
        customerPrice: "39.99",
        proceeds: "0",
        startDate: PAST,
      },
    ]);
    expect(output.scheduledPrices).toEqual([
      expect.objectContaining({ customerPrice: "49.99", startDate: FUTURE }),
    ]);
    expect(output.introductoryOffers).toEqual([
      expect.objectContaining({
        id: "IO1",
        territory: "USA",
        offerMode: "FREE_TRIAL",
      }),
    ]);
    expect(output.promotionalOffers[0]).toMatchObject({
      id: "PO1",
      offerCode: "comeback",
    });
    expect(output.offerCodes).toEqual([
      expect.objectContaining({ id: "SOC1", totalNumberOfCodes: 1000 }),
    ]);
    expect(
      output.winBackOffers.map((offer: { id: string }) => offer.id),
    ).toEqual(["WB1"]);
  });

  it("should reject an id that is not one path segment", async () => {
    const { client, provider } = routed({});
    const result = await run(["subscriptions", "show", "../apps"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });
});
