import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient, AscQuery } from "../src/asc/client.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";
import { planSchedule } from "../src/commands/pricing.ts";
import { AscApiError } from "../src/utils/errors.ts";

type Route = unknown | ((query: AscQuery) => unknown);

/**
 * A client answering GETs from `routes` (an unknown path is a 404) and
 * writes from `writes` by "METHOD path", recording each write.
 */
function mock(
  routes: Record<string, Route>,
  writes: Record<string, unknown> = {},
) {
  const answer = (key: string) => {
    const value = writes[key];
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value ?? { data: { id: "NEW" } });
  };
  const client: AscClient = {
    get: vi.fn((path: string, query: AscQuery = {}) => {
      if (!(path in routes)) {
        return Promise.reject(new AscApiError(404, { errors: [] }));
      }
      const route = routes[path];
      return Promise.resolve(
        typeof route === "function" ? route(query) : route,
      );
    }) as AscClient["get"],
    post: vi.fn((path: string) => answer(`POST ${path}`)) as AscClient["post"],
    patch: vi.fn((path: string) =>
      answer(`PATCH ${path}`),
    ) as AscClient["patch"],
    delete: vi.fn((path: string) =>
      answer(`DELETE ${path}`).then(() => undefined),
    ) as AscClient["delete"],
    upload: vi.fn(() => Promise.resolve()) as AscClient["upload"],
    download: vi.fn((path: string) => {
      const value = writes[`DOWNLOAD ${path}`];
      return value instanceof Uint8Array
        ? Promise.resolve(value)
        : Promise.reject(new AscApiError(404, { errors: [] }));
    }) as AscClient["download"],
    downloadSigned: vi.fn(() =>
      Promise.reject(new Error("unexpected")),
    ) as AscClient["downloadSigned"],
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
  return { exitCode, stdout, stderr, json: () => JSON.parse(stdout) };
}

const list = (data: unknown[], included: unknown[] = []) => ({
  data,
  included,
  links: { self: "x" },
});

const point = (id: string, territory: string, customerPrice: string) => ({
  type: "x",
  id,
  attributes: { customerPrice, proceeds: "0" },
  relationships: {
    territory: { data: { type: "territories", id: territory } },
  },
});

const FUTURE = "2999-01-01";
const PAST = "2000-01-01";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("planSchedule", () => {
  const price = (
    territory: string,
    pricePointId: string,
    startDate: string | null,
    endDate: string | null = null,
  ) => ({ territory, pricePointId, customerPrice: null, startDate, endDate });

  it("should replace the current price now and keep later scheduled changes", () => {
    const planned = planSchedule(
      [
        price("USA", "old", PAST, "2026-12-01"),
        price("USA", "later", "2026-12-01"),
        price("GBR", "gb", null),
        price("JPN", "ended", PAST, "2020-01-01"),
      ],
      [{ territory: "USA", pricePointId: "new", customerPrice: "4.99" }],
      null,
      false,
      "2026-11-27",
    );
    expect(
      planned.map((p) => [p.territory, p.pricePointId, p.startDate, p.endDate]),
    ).toEqual([
      ["GBR", "gb", null, null],
      ["USA", "new", null, "2026-12-01"],
      ["USA", "later", "2026-12-01", null],
    ]);
  });

  it("should end the current price when the new one starts, and drop scheduled ones when asked", () => {
    const planned = planSchedule(
      [price("USA", "old", null), price("USA", "later", "2027-06-01")],
      [{ territory: "USA", pricePointId: "new", customerPrice: "4.99" }],
      "2027-01-01",
      true,
      "2026-11-27",
    );
    expect(
      planned.map((p) => [p.pricePointId, p.startDate, p.endDate]),
    ).toEqual([
      ["old", null, "2027-01-01"],
      ["new", "2027-01-01", null],
    ]);
  });
});

describe("iap writes", () => {
  it("should create an in-app purchase only with --yes", async () => {
    const { client, provider } = mock(
      {},
      {
        "POST /v2/inAppPurchases": {
          data: {
            type: "inAppPurchases",
            id: "IAP9",
            attributes: {
              name: "Coins",
              productId: "com.x.coins",
              state: "MISSING_METADATA",
            },
          },
        },
      },
    );
    const args = [
      "iap",
      "create",
      "123",
      "--type",
      "CONSUMABLE",
      "--product-id",
      "com.x.coins",
      "--reference-name",
      "Coins",
    ];
    const dry = await run(args, provider);
    expect(dry.exitCode).toBe(0);
    expect(dry.json()).toMatchObject({ dryRun: true, appId: "123" });
    expect(client.post).not.toHaveBeenCalled();
    vi.mocked(console.log).mockClear();
    const done = await run([...args, "--yes"], provider);
    expect(done.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v2/inAppPurchases", {
      data: {
        type: "inAppPurchases",
        attributes: {
          name: "Coins",
          productId: "com.x.coins",
          inAppPurchaseType: "CONSUMABLE",
        },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
    expect(done.json().inAppPurchase).toMatchObject({
      id: "IAP9",
      state: "MISSING_METADATA",
    });
  });

  it("should refuse a type Apple does not have", async () => {
    const { provider } = mock({});
    const result = await run(
      [
        "iap",
        "create",
        "123",
        "--type",
        "GEMS",
        "--product-id",
        "a",
        "--reference-name",
        "b",
      ],
      provider,
    );
    expect(result.exitCode).toBe(1);
  });

  it("should update an existing locale and create a new one", async () => {
    const { client, provider } = mock({
      "/v2/inAppPurchases/IAP1/inAppPurchaseLocalizations": list([
        {
          type: "inAppPurchaseLocalizations",
          id: "L1",
          attributes: { locale: "en-US", name: "Coins", description: "Old" },
        },
      ]),
    });
    await run(
      [
        "iap",
        "localize",
        "IAP1",
        "--locale",
        "en-US",
        "--name",
        "Coins",
        "--description",
        "New",
        "--yes",
      ],
      provider,
    );
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/inAppPurchaseLocalizations/L1",
      {
        data: {
          type: "inAppPurchaseLocalizations",
          id: "L1",
          attributes: { description: "New" },
        },
      },
    );
    await run(
      [
        "iap",
        "localize",
        "IAP1",
        "--locale",
        "fr-FR",
        "--name",
        "Pièces",
        "--yes",
      ],
      provider,
    );
    expect(client.post).toHaveBeenCalledWith("/v1/inAppPurchaseLocalizations", {
      data: {
        type: "inAppPurchaseLocalizations",
        attributes: { locale: "fr-FR", name: "Pièces" },
        relationships: {
          inAppPurchaseV2: { data: { type: "inAppPurchases", id: "IAP1" } },
        },
      },
    });
  });

  it("should match the nearest price point and send the whole schedule", async () => {
    const { client, provider } = mock({
      "/v2/inAppPurchases/IAP1/iapPriceSchedule": {
        data: {
          type: "inAppPurchasePriceSchedules",
          id: "S1",
          relationships: {
            baseTerritory: { data: { type: "territories", id: "USA" } },
          },
        },
      },
      "/v1/inAppPurchasePriceSchedules/S1/manualPrices": list([
        {
          type: "inAppPurchasePrices",
          id: "M1",
          attributes: { startDate: null, endDate: null },
          relationships: {
            territory: { data: { type: "territories", id: "USA" } },
            inAppPurchasePricePoint: {
              data: { type: "inAppPurchasePricePoints", id: "P-OLD" },
            },
          },
        },
      ]),
      "/v2/inAppPurchases/IAP1/pricePoints": (query: AscQuery) =>
        (query["filter[territory]"] as string[])[0] === "USA"
          ? list([point("P-499", "USA", "4.99"), point("P-599", "USA", "5.99")])
          : list([point("P-GB", "GBR", "3.99")]),
    });
    const result = await run(
      [
        "iap",
        "price",
        "IAP1",
        "--base-territory",
        "usa",
        "--price",
        "5.20",
        "--override",
        "GBR=4",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(result.json().matchedPrices).toEqual([
      {
        id: "P-499",
        territory: "USA",
        customerPrice: "4.99",
        proceeds: "0",
        requestedPrice: 5.2,
      },
      {
        id: "P-GB",
        territory: "GBR",
        customerPrice: "3.99",
        proceeds: "0",
        requestedPrice: 4,
      },
    ]);
    const body = vi.mocked(client.post).mock.calls[0]?.[1] as {
      data: { relationships: { manualPrices: { data: unknown[] } } };
      included: { relationships: Record<string, { data: { id: string } }> }[];
    };
    expect(vi.mocked(client.post).mock.calls[0]?.[0]).toBe(
      "/v1/inAppPurchasePriceSchedules",
    );
    expect(body.data.relationships.manualPrices.data).toHaveLength(2);
    expect(
      body.included.map(
        (item) => item.relationships.inAppPurchasePricePoint?.data.id,
      ),
    ).toEqual(["P-GB", "P-499"]);
  });

  it("should replace the availability with the territories given", async () => {
    const { client, provider } = mock({
      "/v2/inAppPurchases/IAP1/inAppPurchaseAvailability": {
        data: {
          type: "inAppPurchaseAvailabilities",
          id: "AV",
          attributes: { availableInNewTerritories: true },
        },
      },
      "/v1/inAppPurchaseAvailabilities/AV/availableTerritories": list([
        { type: "territories", id: "USA" },
        { type: "territories", id: "JPN" },
      ]),
    });
    const result = await run(
      ["iap", "availability", "IAP1", "--territory", "USA,GBR", "--yes"],
      provider,
    );
    expect(result.json()).toMatchObject({
      adding: ["GBR"],
      removing: ["JPN"],
      availableInNewTerritories: true,
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/inAppPurchaseAvailabilities",
      {
        data: {
          type: "inAppPurchaseAvailabilities",
          attributes: { availableInNewTerritories: true },
          relationships: {
            inAppPurchase: { data: { type: "inAppPurchases", id: "IAP1" } },
            availableTerritories: {
              data: [
                { type: "territories", id: "GBR" },
                { type: "territories", id: "USA" },
              ],
            },
          },
        },
      },
    );
  });

  it("should upload the review screenshot to Apple's URLs and commit its MD5", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-shot-"));
    const file = join(dir, "review.png");
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    await writeFile(file, bytes);
    const operations = [
      {
        method: "PUT",
        url: "https://upload.example/a",
        offset: 0,
        length: 4,
        requestHeaders: [],
      },
      {
        method: "PUT",
        url: "https://upload.example/b",
        offset: 4,
        length: 2,
        requestHeaders: [],
      },
    ];
    const { client, provider } = mock(
      {
        "/v2/inAppPurchases/IAP1/appStoreReviewScreenshot": {
          data: {
            type: "inAppPurchaseAppStoreReviewScreenshots",
            id: "OLD",
            attributes: { fileName: "old.png" },
          },
        },
      },
      {
        "POST /v1/inAppPurchaseAppStoreReviewScreenshots": {
          data: {
            type: "inAppPurchaseAppStoreReviewScreenshots",
            id: "SHOT",
            attributes: { uploadOperations: operations },
          },
        },
      },
    );
    const result = await run(
      ["iap", "review-screenshot", "upload", "IAP1", "--file", file, "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith(
      "/v1/inAppPurchaseAppStoreReviewScreenshots/OLD",
    );
    expect(client.upload).toHaveBeenCalledTimes(2);
    expect(
      Array.from(vi.mocked(client.upload).mock.calls[1]?.[1] ?? []),
    ).toEqual([5, 6]);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/inAppPurchaseAppStoreReviewScreenshots/SHOT",
      {
        data: {
          type: "inAppPurchaseAppStoreReviewScreenshots",
          id: "SHOT",
          attributes: {
            uploaded: true,
            sourceFileChecksum: createHash("md5").update(bytes).digest("hex"),
          },
        },
      },
    );
  });

  it("should refuse to submit a product missing metadata", async () => {
    const { client, provider } = mock({
      "/v2/inAppPurchases/IAP1": {
        data: {
          type: "inAppPurchases",
          id: "IAP1",
          attributes: { state: "MISSING_METADATA" },
        },
      },
    });
    const result = await run(["iap", "submit", "IAP1", "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should submit a product that is ready", async () => {
    const { client, provider } = mock({
      "/v2/inAppPurchases/IAP1": {
        data: {
          type: "inAppPurchases",
          id: "IAP1",
          attributes: { state: "READY_TO_SUBMIT" },
        },
      },
    });
    const result = await run(["iap", "submit", "IAP1", "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/inAppPurchaseSubmissions", {
      data: {
        type: "inAppPurchaseSubmissions",
        relationships: {
          inAppPurchaseV2: { data: { type: "inAppPurchases", id: "IAP1" } },
        },
      },
    });
  });
});

/** A subscription priced in USA and GBR today. */
function subscriptionRoutes(extra: Record<string, Route> = {}) {
  return {
    "/v1/subscriptions/SUB1": {
      data: {
        type: "subscriptions",
        id: "SUB1",
        attributes: { name: "Pro", state: "APPROVED" },
      },
    },
    "/v1/subscriptions/SUB1/prices": list(
      ["USA", "GBR"].map((code) => ({
        type: "subscriptionPrices",
        id: `PR-${code}`,
        attributes: { startDate: PAST },
        relationships: {
          territory: { data: { type: "territories", id: code } },
          subscriptionPricePoint: {
            data: { type: "subscriptionPricePoints", id: `SP-${code}` },
          },
        },
      })),
    ),
    "/v1/subscriptions/SUB1/pricePoints": (query: AscQuery) => {
      const code = (query["filter[territory]"] as string[])[0];
      return code === "USA"
        ? list([
            point("PP-USA-1", "USA", "0.99"),
            point("PP-USA-9", "USA", "9.99"),
          ])
        : list([point(`PP-${code}-X`, code ?? "", "1.49")]);
    },
    "/v1/subscriptionPricePoints/PP-USA-9/equalizations": list([
      point("PP-GBR-9", "GBR", "8.99"),
      point("PP-JPN-9", "JPN", "1500"),
    ]),
    "/v1/subscriptionPricePoints/PP-USA-1/equalizations": list([
      point("PP-GBR-1", "GBR", "0.99"),
      point("PP-JPN-1", "JPN", "160"),
    ]),
    ...extra,
  };
}

describe("subscription writes", () => {
  it("should create a group and refuse a duplicate name", async () => {
    const { client, provider } = mock({
      "/v1/apps/123/subscriptionGroups": list([
        {
          type: "subscriptionGroups",
          id: "G1",
          attributes: { referenceName: "Pro" },
        },
      ]),
    });
    const duplicate = await run(
      [
        "subscriptions",
        "group",
        "create",
        "123",
        "--reference-name",
        "Pro",
        "--yes",
      ],
      provider,
    );
    expect(duplicate.exitCode).toBe(1);
    const created = await run(
      [
        "subscriptions",
        "group",
        "create",
        "123",
        "--reference-name",
        "Plus",
        "--yes",
      ],
      provider,
    );
    expect(created.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith("/v1/subscriptionGroups", {
      data: {
        type: "subscriptionGroups",
        attributes: { referenceName: "Plus" },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
  });

  it("should create a subscription in a group with its period", async () => {
    const { client, provider } = mock({
      "/v1/subscriptionGroups/G1/subscriptions": list([]),
    });
    const result = await run(
      [
        "subscriptions",
        "create",
        "G1",
        "--product-id",
        "com.x.pro.monthly",
        "--reference-name",
        "Pro Monthly",
        "--period",
        "ONE_MONTH",
        "--group-level",
        "1",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/subscriptions", {
      data: {
        type: "subscriptions",
        attributes: {
          name: "Pro Monthly",
          productId: "com.x.pro.monthly",
          subscriptionPeriod: "ONE_MONTH",
          groupLevel: 1,
        },
        relationships: {
          group: { data: { type: "subscriptionGroups", id: "G1" } },
        },
      },
    });
  });

  it("should price every territory from the equalized point, keeping subscribers' prices by default", async () => {
    const { client, provider } = mock(subscriptionRoutes());
    const result = await run(
      [
        "subscriptions",
        "price",
        "SUB1",
        "--base-territory",
        "USA",
        "--price",
        "9.99",
        "--override",
        "JPN=1400",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    const posted = vi.mocked(client.post).mock.calls.map(([, body]) => {
      const data = (
        body as {
          data: {
            attributes: unknown;
            relationships: Record<string, { data: { id: string } }>;
          };
        }
      ).data;
      return [
        data.relationships.territory?.data.id,
        data.relationships.subscriptionPricePoint?.data.id,
        data.attributes,
      ];
    });
    expect(posted).toEqual([
      ["GBR", "PP-GBR-9", { startDate: null, preserveCurrentPrice: true }],
      ["JPN", "PP-JPN-X", { startDate: null, preserveCurrentPrice: true }],
      ["USA", "PP-USA-9", { startDate: null, preserveCurrentPrice: true }],
    ]);
  });

  it("should say which territories were priced when pricing stops partway", async () => {
    let calls = 0;
    const { client, provider } = mock(subscriptionRoutes());
    vi.mocked(client.post).mockImplementation(() => {
      calls += 1;
      return calls === 2
        ? Promise.reject(new AscApiError(500, { errors: [] }))
        : Promise.resolve({ data: { id: "x" } });
    });
    const result = await run(
      [
        "subscriptions",
        "price",
        "SUB1",
        "--base-territory",
        "USA",
        "--price",
        "9.99",
        "--no-preserve-current-price",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("1 of 3 territories were priced (GBR)");
  });

  it("should create a plan availability when the subscription has none", async () => {
    const { client, provider } = mock({
      "/v1/subscriptions/SUB1/planAvailabilities": list([]),
    });
    const result = await run(
      [
        "subscriptions",
        "availability",
        "SUB1",
        "--territory",
        "USA",
        "--available-in-new-territories",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith(
      "/v1/subscriptionPlanAvailabilities",
      {
        data: {
          type: "subscriptionPlanAvailabilities",
          attributes: { availableInNewTerritories: true, planType: "UPFRONT" },
          relationships: {
            subscription: { data: { type: "subscriptions", id: "SUB1" } },
            availableTerritories: {
              data: [{ type: "territories", id: "USA" }],
            },
          },
        },
      },
    );
  });

  it("should ask for --territory or --all, not both", async () => {
    const { provider } = mock({
      "/v1/subscriptions/SUB1/planAvailabilities": list([]),
    });
    const result = await run(
      ["subscriptions", "availability", "SUB1", "--territory", "USA", "--all"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--all");
  });
});

describe("subscriptions offers", () => {
  it("should create a free trial in every priced territory without price points", async () => {
    const { client, provider } = mock(subscriptionRoutes());
    const result = await run(
      [
        "subscriptions",
        "offers",
        "intro",
        "create",
        "SUB1",
        "--mode",
        "FREE_TRIAL",
        "--duration",
        "ONE_WEEK",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(client.post).toHaveBeenCalledWith(
      "/v1/subscriptionIntroductoryOffers",
      {
        data: {
          type: "subscriptionIntroductoryOffers",
          attributes: {
            offerMode: "FREE_TRIAL",
            duration: "ONE_WEEK",
            numberOfPeriods: 1,
            startDate: null,
            endDate: null,
          },
          relationships: {
            subscription: { data: { type: "subscriptions", id: "SUB1" } },
            territory: { data: { type: "territories", id: "GBR" } },
          },
        },
      },
    );
  });

  it("should refuse a paid offer without a price", async () => {
    const { client, provider } = mock(subscriptionRoutes());
    const result = await run(
      [
        "subscriptions",
        "offers",
        "intro",
        "create",
        "SUB1",
        "--mode",
        "PAY_UP_FRONT",
        "--duration",
        "ONE_MONTH",
      ],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--price");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should price a promotional offer only in the territories the subscription is priced in", async () => {
    const { client, provider } = mock(subscriptionRoutes());
    const result = await run(
      [
        "subscriptions",
        "offers",
        "promo",
        "create",
        "SUB1",
        "--name",
        "Comeback",
        "--code",
        "comeback_1",
        "--mode",
        "PAY_AS_YOU_GO",
        "--duration",
        "ONE_MONTH",
        "--periods",
        "3",
        "--base-territory",
        "USA",
        "--price",
        "1",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(result.json().prices).toEqual([
      { territory: "GBR", customerPrice: "0.99" },
      { territory: "USA", customerPrice: "0.99", requestedPrice: 1 },
    ]);
    const [path, body] = vi.mocked(client.post).mock.calls[0] ?? [];
    expect(path).toBe("/v1/subscriptionPromotionalOffers");
    expect(body).toMatchObject({
      data: {
        attributes: {
          name: "Comeback",
          offerCode: "comeback_1",
          offerMode: "PAY_AS_YOU_GO",
          numberOfPeriods: 3,
        },
        relationships: {
          prices: {
            data: [
              { type: "subscriptionPromotionalOfferPrices", id: "${price-0}" },
              { type: "subscriptionPromotionalOfferPrices", id: "${price-1}" },
            ],
          },
        },
      },
      included: [
        {
          id: "${price-0}",
          relationships: {
            territory: { data: { id: "GBR" } },
            subscriptionPricePoint: { data: { id: "PP-GBR-1" } },
          },
        },
        {
          id: "${price-1}",
          relationships: {
            territory: { data: { id: "USA" } },
            subscriptionPricePoint: { data: { id: "PP-USA-1" } },
          },
        },
      ],
    });
  });

  it("should write one-time codes only to a new private file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-codes-"));
    const out = join(dir, "codes.csv");
    const csv =
      "code,expirationDate\nSECRETCODE1,2027-01-01\nSECRETCODE2,2027-01-01\n";
    const { client, provider } = mock(
      {
        "/v1/subscriptionOfferCodes/OC1": {
          data: {
            type: "subscriptionOfferCodes",
            id: "OC1",
            attributes: { name: "Launch", active: true },
          },
        },
      },
      {
        "POST /v1/subscriptionOfferCodeOneTimeUseCodes": {
          data: { type: "subscriptionOfferCodeOneTimeUseCodes", id: "B1" },
        },
        "DOWNLOAD /v1/subscriptionOfferCodeOneTimeUseCodes/B1/values":
          new TextEncoder().encode(csv),
      },
    );
    const args = [
      "subscriptions",
      "offers",
      "offer-codes",
      "generate",
      "OC1",
      "--count",
      "2",
      "--expires",
      "2027-01-01",
      "--out",
      out,
    ];
    const dry = await run(args, provider);
    expect(dry.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    await expect(stat(out)).rejects.toThrow();
    vi.mocked(console.log).mockClear();
    const done = await run([...args, "--yes"], provider);
    expect(done.exitCode).toBe(0);
    expect(done.json()).toMatchObject({ batchId: "B1", saved: 2, out });
    expect(done.stdout + done.stderr).not.toContain("SECRETCODE");
    expect(client.download).toHaveBeenCalledWith(
      "/v1/subscriptionOfferCodeOneTimeUseCodes/B1/values",
      {},
      { accept: "text/csv" },
    );
    expect(await readFile(out, "utf8")).toBe(csv);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    vi.mocked(console.log).mockClear();
    const again = await run(
      ["subscriptions", "offers", "offer-codes", "codes", "B1", "--out", out],
      provider,
    );
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("already exists");
  });

  it("should deactivate an offer code", async () => {
    const { client, provider } = mock({
      "/v1/subscriptionOfferCodes/OC1": {
        data: {
          type: "subscriptionOfferCodes",
          id: "OC1",
          attributes: { name: "Launch", active: true },
        },
      },
    });
    const result = await run(
      ["subscriptions", "offers", "offer-codes", "deactivate", "OC1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/subscriptionOfferCodes/OC1",
      {
        data: {
          type: "subscriptionOfferCodes",
          id: "OC1",
          attributes: { active: false },
        },
      },
    );
  });

  it("should ask a win-back offer for its eligibility and start", async () => {
    const { client, provider } = mock(subscriptionRoutes());
    const result = await run(
      [
        "subscriptions",
        "offers",
        "win-back",
        "create",
        "SUB1",
        "--reference-name",
        "Back",
        "--offer-id",
        "back1",
        "--mode",
        "FREE_TRIAL",
        "--duration",
        "ONE_MONTH",
      ],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--paid-months, --since-min, --start-date");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should change a win-back offer's eligibility", async () => {
    const { client, provider } = mock({
      "/v1/winBackOffers/WB1": {
        data: {
          type: "winBackOffers",
          id: "WB1",
          attributes: { referenceName: "Back" },
        },
      },
    });
    const result = await run(
      [
        "subscriptions",
        "offers",
        "win-back",
        "set",
        "WB1",
        "--since-min",
        "3",
        "--since-max",
        "12",
        "--end-date",
        FUTURE,
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/winBackOffers/WB1", {
      data: {
        type: "winBackOffers",
        id: "WB1",
        attributes: {
          customerEligibilityTimeSinceLastSubscribedInMonths: {
            minimum: 3,
            maximum: 12,
          },
          endDate: FUTURE,
        },
      },
    });
  });
});

describe("pricing set", () => {
  it("should keep a scheduled change and print the plan without --yes", async () => {
    const { client, provider } = mock({
      "/v1/apps/123/appPriceSchedule": {
        data: {
          type: "appPriceSchedules",
          id: "APS",
          relationships: {
            baseTerritory: { data: { type: "territories", id: "USA" } },
          },
        },
      },
      "/v1/appPriceSchedules/APS/manualPrices": list([
        {
          type: "appPrices",
          id: "A1",
          attributes: { startDate: null, endDate: FUTURE },
          relationships: {
            territory: { data: { id: "USA" } },
            appPricePoint: { data: { id: "AP-OLD" } },
          },
        },
        {
          type: "appPrices",
          id: "A2",
          attributes: { startDate: FUTURE, endDate: null },
          relationships: {
            territory: { data: { id: "USA" } },
            appPricePoint: { data: { id: "AP-LATER" } },
          },
        },
      ]),
      "/v1/apps/123/appPricePoints": list([point("AP-299", "USA", "2.99")]),
    });
    const result = await run(
      ["pricing", "set", "123", "--base-territory", "USA", "--price", "2.99"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Dry run");
    expect(client.post).not.toHaveBeenCalled();
    expect(result.json().newManualPrices).toEqual([
      {
        territory: "USA",
        pricePointId: "AP-299",
        customerPrice: "2.99",
        startDate: null,
        endDate: FUTURE,
      },
      {
        territory: "USA",
        pricePointId: "AP-LATER",
        customerPrice: null,
        startDate: FUTURE,
        endDate: null,
      },
    ]);
  });

  it("should create the schedule with --yes", async () => {
    const { client, provider } = mock({
      "/v1/apps/123/appPricePoints": list([point("AP-0", "USA", "0.00")]),
    });
    const result = await run(
      [
        "pricing",
        "set",
        "123",
        "--base-territory",
        "USA",
        "--price",
        "0",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/appPriceSchedules", {
      data: {
        type: "appPriceSchedules",
        relationships: {
          app: { data: { type: "apps", id: "123" } },
          baseTerritory: { data: { type: "territories", id: "USA" } },
          manualPrices: { data: [{ type: "appPrices", id: "${price-0}" }] },
        },
      },
      included: [
        {
          type: "appPrices",
          id: "${price-0}",
          attributes: { startDate: null, endDate: null },
          relationships: {
            appPricePoint: { data: { type: "appPricePoints", id: "AP-0" } },
          },
        },
      ],
    });
  });
});

describe("availability set pre-orders", () => {
  it("should turn on a pre-order with its release date", async () => {
    const { client, provider } = mock({
      "/v1/apps/123/appAvailabilityV2": {
        data: { type: "appAvailabilities", id: "AA", attributes: {} },
      },
      "/v2/appAvailabilities/AA/territoryAvailabilities": list([
        {
          type: "territoryAvailabilities",
          id: "TA-USA",
          attributes: {
            available: true,
            preOrderEnabled: false,
            releaseDate: null,
          },
          relationships: { territory: { data: { id: "USA" } } },
        },
      ]),
    });
    const result = await run(
      [
        "availability",
        "set",
        "123",
        "--territory",
        "USA",
        "--pre-order",
        "--release-date",
        "2027-03-01",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/territoryAvailabilities/TA-USA",
      {
        data: {
          type: "territoryAvailabilities",
          id: "TA-USA",
          attributes: { preOrderEnabled: true, releaseDate: "2027-03-01" },
        },
      },
    );
  });
});

describe("promoted-purchases", () => {
  const promoted = list(
    [
      {
        type: "promotedPurchases",
        id: "PP1",
        attributes: {
          enabled: true,
          visibleForAllUsers: true,
          state: "APPROVED",
        },
        relationships: {
          inAppPurchaseV2: { data: { type: "inAppPurchases", id: "IAP1" } },
        },
      },
      {
        type: "promotedPurchases",
        id: "PP2",
        attributes: {
          enabled: true,
          visibleForAllUsers: true,
          state: "APPROVED",
        },
        relationships: {
          subscription: { data: { type: "subscriptions", id: "SUB1" } },
        },
      },
    ],
    [
      {
        type: "inAppPurchases",
        id: "IAP1",
        attributes: { name: "Coins", productId: "com.x.coins" },
      },
      {
        type: "subscriptions",
        id: "SUB1",
        attributes: { name: "Pro", productId: "com.x.pro" },
      },
    ],
  );

  it("should list promoted purchases in order with their products", async () => {
    const { provider } = mock({ "/v1/apps/123/promotedPurchases": promoted });
    const result = await run(["promoted-purchases", "123"], provider);
    expect(result.json().promotedPurchases[1]).toEqual({
      id: "PP2",
      position: 2,
      enabled: true,
      visibleForAllUsers: true,
      state: "APPROVED",
      product: {
        kind: "subscription",
        id: "SUB1",
        productId: "com.x.pro",
        referenceName: "Pro",
      },
    });
  });

  it("should add a new product first, reorder and remove the others with --only", async () => {
    const { client, provider } = mock(
      {
        "/v1/apps/123/promotedPurchases": promoted,
        "/v1/subscriptions/SUB2": {
          data: { type: "subscriptions", id: "SUB2" },
        },
      },
      {
        "POST /v1/promotedPurchases": {
          data: { type: "promotedPurchases", id: "PP3" },
        },
      },
    );
    const result = await run(
      [
        "promoted-purchases",
        "set",
        "123",
        "--product",
        "SUB2,IAP1",
        "--only",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/promotedPurchases", {
      data: {
        type: "promotedPurchases",
        attributes: { enabled: true, visibleForAllUsers: true },
        relationships: {
          app: { data: { type: "apps", id: "123" } },
          subscription: { data: { type: "subscriptions", id: "SUB2" } },
        },
      },
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/apps/123/relationships/promotedPurchases",
      {
        data: [
          { type: "promotedPurchases", id: "PP3" },
          { type: "promotedPurchases", id: "PP1" },
        ],
      },
    );
    expect(client.delete).toHaveBeenCalledWith("/v1/promotedPurchases/PP2");
  });
});
