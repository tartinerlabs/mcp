import { gzipSync } from "node:zlib";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AscClient, createAscClient } from "../src/asc/client.ts";
import { parseReport, reportText } from "../src/asc/reports.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";
import { generateP256Pem } from "./helpers.ts";

const ISSUER = "69a6de70-03db-47e3-e053-5b8c7c11a4d1";
const TEAM = ["--issuer-id", ISSUER];

function gzip(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(gzipSync(text));
}

function tsv(rows: string[][]): string {
  return `${rows.map((row) => row.join("\t")).join("\n")}\n`;
}

/** A client whose every method fails unless the test replaces it. */
function mockClient(overrides: Partial<AscClient> = {}) {
  const fail = () => Promise.reject(new Error("unexpected call"));
  const client: AscClient = {
    get: vi.fn(fail) as AscClient["get"],
    post: vi.fn(fail) as AscClient["post"],
    patch: vi.fn(fail) as AscClient["patch"],
    delete: vi.fn(fail) as AscClient["delete"],
    upload: vi.fn(fail) as AscClient["upload"],
    download: vi.fn(fail) as AscClient["download"],
    downloadSigned: vi.fn(fail) as AscClient["downloadSigned"],
    ...overrides,
  };
  return { client, provider: vi.fn<AscClientProvider>(() => client) };
}

/** Runs the CLI, capturing stdout, stderr and the exit code. */
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
  return {
    exitCode,
    stderr,
    json: () => JSON.parse(stdout) as Record<string, unknown>,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("ASC_ISSUER_ID", "");
  vi.stubEnv("ASC_VENDOR_NUMBER", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("report parsing", () => {
  it("should decompress gzip and pass plain text through", () => {
    expect(reportText(gzip("a\tb\tc\n"))).toBe("a\tb\tc\n");
    expect(reportText(new TextEncoder().encode("plain"))).toBe("plain");
  });

  it("should skip blank lines, repeated headers and Total_ lines, and pad short rows", () => {
    const table = parseReport(
      "Title\tQuantity\tExtended Partner Share\tPartner Share Currency\n" +
        "App\t2\t1.40\tUSD\n" +
        "\n" +
        "Title\tQuantity\tExtended Partner Share\tPartner Share Currency\n" +
        "Other\t1\n" +
        "Total_Rows\t2\n" +
        "Total_Amount\t1.40\n",
    );
    expect(table.columns).toEqual([
      "Title",
      "Quantity",
      "Extended Partner Share",
      "Partner Share Currency",
    ]);
    expect(table.rows).toEqual([
      {
        Title: "App",
        Quantity: "2",
        "Extended Partner Share": "1.40",
        "Partner Share Currency": "USD",
      },
      {
        Title: "Other",
        Quantity: "1",
        "Extended Partner Share": "",
        "Partner Share Currency": "",
      },
    ]);
  });

  it("should read a comma-separated report with quoted fields", () => {
    const table = parseReport(
      'Date,App Name,Counts\r\n2026-11-01,"Tea, ""Green""",4\r\n',
    );
    expect(table.rows).toEqual([
      { Date: "2026-11-01", "App Name": 'Tea, "Green"', Counts: "4" },
    ]);
  });
});

const SALES_HEADER = [
  "Provider",
  "SKU",
  "Title",
  "Product Type Identifier",
  "Units",
  "Developer Proceeds",
  "Currency of Proceeds",
  "Country Code",
  "Apple Identifier",
  "Parent Identifier",
];

const SALES = tsv([
  SALES_HEADER,
  ["APPLE", "tea", "Tea", "1F", "10", "0", "USD", "US", "111", ""],
  ["APPLE", "tea", "Tea", "1F", "3", "0", "GBP", "GB", "111", ""],
  [
    "APPLE",
    "tea.pro",
    "Tea Pro",
    "IAY",
    "2",
    "6.99",
    "USD",
    "US",
    "222",
    "tea",
  ],
  [
    "APPLE",
    "tea.pro",
    "Tea Pro",
    "IAY",
    "1",
    "5.49",
    "GBP",
    "GB",
    "222",
    "tea",
  ],
  ["APPLE", "tea", "Tea", "7F", "4", "0", "USD", "US", "111", ""],
]);

describe("sales", () => {
  it("should request the summary report and aggregate units and proceeds", async () => {
    const download = vi.fn(() => Promise.resolve(gzip(SALES)));
    const { provider, client } = mockClient({ download });
    const result = await run(
      [
        ...TEAM,
        "sales",
        "--vendor-number",
        "85012345",
        "--frequency",
        "MONTHLY",
        "--date",
        "2026-09",
      ],
      provider,
    );

    expect(result.exitCode).toBe(0);
    expect(client.download).toHaveBeenCalledWith("/v1/salesReports", {
      "filter[vendorNumber]": "85012345",
      "filter[reportType]": "SALES",
      "filter[reportSubType]": "SUMMARY",
      "filter[frequency]": "MONTHLY",
      "filter[reportDate]": "2026-09",
      "filter[version]": "1_0",
    });
    const output = result.json();
    expect(output.report).toEqual({
      type: "SALES",
      frequency: "MONTHLY",
      date: "2026-09",
    });
    expect(output.rows).toBe(5);
    expect(output.totals).toEqual({
      units: 20,
      proceeds: { USD: 13.98, GBP: 5.49 },
    });
    expect(output.byProductType).toEqual([
      {
        productType: "1F",
        type: "Free or paid app",
        units: 13,
        proceeds: { USD: 0, GBP: 0 },
      },
      { productType: "7F", type: "Update", units: 4, proceeds: { USD: 0 } },
      {
        productType: "IAY",
        type: "Auto-renewable subscription",
        units: 3,
        proceeds: { USD: 13.98, GBP: 5.49 },
      },
    ]);
    expect(output.byCountry).toEqual([
      { country: "US", units: 16, proceeds: { USD: 13.98 } },
      { country: "GB", units: 4, proceeds: { GBP: 5.49 } },
    ]);
    expect(output.byProduct).toEqual([
      {
        appleId: "111",
        title: "Tea",
        sku: "tea",
        productType: "1F",
        units: 17,
        proceeds: { USD: 0, GBP: 0 },
      },
      {
        appleId: "222",
        title: "Tea Pro",
        sku: "tea.pro",
        parentSku: "tea",
        productType: "IAY",
        units: 3,
        proceeds: { USD: 13.98, GBP: 5.49 },
      },
    ]);
  });

  it("should read the vendor number from ASC_VENDOR_NUMBER and fetch the latest daily report", async () => {
    vi.stubEnv("ASC_VENDOR_NUMBER", "85012345");
    const download = vi.fn(() => Promise.resolve(gzip(SALES)));
    const { provider, client } = mockClient({ download });
    const result = await run([...TEAM, "sales"], provider);

    expect(result.exitCode).toBe(0);
    expect(client.download).toHaveBeenCalledWith(
      "/v1/salesReports",
      expect.objectContaining({
        "filter[vendorNumber]": "85012345",
        "filter[frequency]": "DAILY",
        "filter[reportDate]": undefined,
      }),
    );
    expect(result.json().report).toMatchObject({ date: "latest" });
  });

  it("should refuse an individual key as [permission] without calling Apple", async () => {
    const { provider, client } = mockClient();
    const result = await run(
      ["sales", "--vendor-number", "85012345"],
      provider,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[permission]");
    expect(result.stderr).toContain("team API key");
    expect(result.stderr).toContain("Users and Access → Integrations");
    expect(provider).not.toHaveBeenCalled();
    expect(client.download).not.toHaveBeenCalled();
  });

  it("should explain a refused key as [permission] naming the roles", async () => {
    const download = vi.fn(() => Promise.reject(new AscApiError(403, {})));
    const { provider } = mockClient({ download });
    const result = await run(
      [...TEAM, "sales", "--vendor-number", "85012345"],
      provider,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[permission] Sales reports need a team API key",
    );
    expect(result.stderr).toContain("Admin, Finance or Sales and Reports");
  });

  it("should report a missing report as [not_found] saying it may not be out yet", async () => {
    const download = vi.fn(() => Promise.reject(new AscApiError(404, {})));
    const { provider } = mockClient({ download });
    const result = await run(
      [...TEAM, "sales", "--vendor-number", "85012345", "--date", "2026-11-26"],
      provider,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found] There is no sales report");
    expect(result.stderr).toContain("about a day after its period ends");
  });

  it("should require a vendor number and a date in the frequency's format", async () => {
    const { provider } = mockClient();
    const missing = await run([...TEAM, "sales"], provider);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("--vendor-number or ASC_VENDOR_NUMBER");

    const monthly = await run(
      [
        ...TEAM,
        "sales",
        "--vendor-number",
        "85012345",
        "--frequency",
        "MONTHLY",
        "--date",
        "2026-09-01",
      ],
      provider,
    );
    expect(monthly.exitCode).toBe(1);
    expect(monthly.stderr).toContain("needs --date as YYYY-MM");
  });
});

const FINANCE = tsv([
  [
    "Start Date",
    "End Date",
    "Vendor Identifier",
    "Quantity",
    "Partner Share",
    "Extended Partner Share",
    "Partner Share Currency",
    "Apple Identifier",
    "Title",
    "Product Type Identifier",
    "Country Of Sale",
  ],
  [
    "08/31/2026",
    "10/04/2026",
    "tea",
    "5",
    "0.70",
    "3.50",
    "USD",
    "111",
    "Tea",
    "1F",
    "US",
  ],
  [
    "08/31/2026",
    "10/04/2026",
    "tea",
    "-1",
    "0.70",
    "-0.70",
    "USD",
    "111",
    "Tea",
    "1F",
    "US",
  ],
  [
    "08/31/2026",
    "10/04/2026",
    "tea",
    "2",
    "0.60",
    "1.20",
    "EUR",
    "111",
    "Tea",
    "1F",
    "FR",
  ],
]).concat("Total_Rows\t3\nTotal_Amount\t4.00\nTotal_Units\t6\n");

describe("finance", () => {
  it("should fetch the consolidated report and sum the extended partner share", async () => {
    const download = vi.fn(() => Promise.resolve(gzip(FINANCE)));
    const { provider, client } = mockClient({ download });
    const result = await run(
      [...TEAM, "finance", "--vendor-number", "85012345", "--month", "2026-09"],
      provider,
    );

    expect(result.exitCode).toBe(0);
    expect(client.download).toHaveBeenCalledWith("/v1/financeReports", {
      "filter[vendorNumber]": "85012345",
      "filter[reportType]": "FINANCIAL",
      "filter[regionCode]": "ZZ",
      "filter[reportDate]": "2026-09",
    });
    const output = result.json();
    expect(output.rows).toBe(3);
    expect(output.totals).toEqual({
      units: 6,
      proceeds: { USD: 2.8, EUR: 1.2 },
    });
    expect(output.byCountry).toEqual([
      { country: "US", units: 4, proceeds: { USD: 2.8 } },
      { country: "FR", units: 2, proceeds: { EUR: 1.2 } },
    ]);
    expect(output.byProduct).toEqual([
      {
        appleId: "111",
        title: "Tea",
        sku: "tea",
        productType: "1F",
        units: 6,
        proceeds: { USD: 2.8, EUR: 1.2 },
      },
    ]);
  });

  it("should ask for the finance detail report in region Z1", async () => {
    const download = vi.fn(() => Promise.resolve(gzip(FINANCE)));
    const { provider, client } = mockClient({ download });
    const result = await run(
      [
        ...TEAM,
        "finance",
        "--vendor-number",
        "85012345",
        "--month",
        "2026-09",
        "--detail",
      ],
      provider,
    );

    expect(result.exitCode).toBe(0);
    expect(client.download).toHaveBeenCalledWith(
      "/v1/financeReports",
      expect.objectContaining({
        "filter[reportType]": "FINANCE_DETAIL",
        "filter[regionCode]": "Z1",
      }),
    );
  });

  it("should name the Finance roles when the key is refused", async () => {
    const download = vi.fn(() => Promise.reject(new AscApiError(401, {})));
    const { provider } = mockClient({ download });
    const result = await run(
      [...TEAM, "finance", "--vendor-number", "85012345", "--month", "2026-09"],
      provider,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[permission] Finance reports");
    expect(result.stderr).toContain("Admin or Finance");
  });
});

const REQUESTS = {
  data: [
    {
      type: "analyticsReportRequests",
      id: "R1",
      attributes: { accessType: "ONGOING", stoppedDueToInactivity: false },
    },
  ],
  links: { self: "https://api.appstoreconnect.apple.com/v1/x" },
};
const NO_REQUESTS = {
  data: [],
  links: { self: "https://api.appstoreconnect.apple.com/v1/x" },
};

describe("analytics", () => {
  it("should list the app's report requests", async () => {
    const get = vi.fn(() => Promise.resolve(REQUESTS));
    const { provider, client } = mockClient({ get: get as AscClient["get"] });
    const result = await run(["analytics", "123"], provider);

    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/123/analyticsReportRequests",
      expect.objectContaining({ limit: 200 }),
    );
    expect(result.json()).toEqual({
      requests: [
        { id: "R1", accessType: "ONGOING", stoppedDueToInactivity: false },
      ],
    });
  });

  it("should only describe the request it would create without --yes", async () => {
    const get = vi.fn(() => Promise.resolve(NO_REQUESTS));
    const { provider, client } = mockClient({ get: get as AscClient["get"] });
    const result = await run(["analytics", "request", "123"], provider);

    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(result.json()).toMatchObject({
      dryRun: true,
      appId: "123",
      accessType: "ONGOING",
    });
    expect(result.stderr).toContain("Dry run");
  });

  it("should create a one-time request with --yes", async () => {
    const get = vi.fn(() => Promise.resolve(NO_REQUESTS));
    const post = vi.fn(() =>
      Promise.resolve({
        data: {
          type: "analyticsReportRequests",
          id: "R2",
          attributes: { accessType: "ONE_TIME_SNAPSHOT" },
        },
      }),
    );
    const { provider, client } = mockClient({
      get: get as AscClient["get"],
      post: post as AscClient["post"],
    });
    const result = await run(
      ["analytics", "request", "123", "--one-time", "--yes"],
      provider,
    );

    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/analyticsReportRequests", {
      data: {
        type: "analyticsReportRequests",
        attributes: { accessType: "ONE_TIME_SNAPSHOT" },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
    expect(result.json()).toMatchObject({
      dryRun: false,
      created: true,
      request: { id: "R2", accessType: "ONE_TIME_SNAPSHOT" },
    });
  });

  it("should reuse an active request instead of creating another", async () => {
    const get = vi.fn(() => Promise.resolve(REQUESTS));
    const { provider, client } = mockClient({ get: get as AscClient["get"] });
    const result = await run(
      ["analytics", "request", "123", "--yes"],
      provider,
    );

    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(result.json()).toMatchObject({
      created: false,
      request: { id: "R1" },
    });
  });

  it("should list reports of the active requests, filtered by category", async () => {
    const get = vi.fn((path: string) =>
      Promise.resolve(
        path.endsWith("/analyticsReportRequests")
          ? REQUESTS
          : {
              data: [
                {
                  type: "analyticsReports",
                  id: "AR1",
                  attributes: {
                    name: "App Downloads Standard",
                    category: "COMMERCE",
                  },
                },
              ],
              links: { self: "https://api.appstoreconnect.apple.com/v1/x" },
            },
      ),
    );
    const { provider, client } = mockClient({ get: get as AscClient["get"] });
    const result = await run(
      ["analytics", "reports", "123", "--category", "COMMERCE"],
      provider,
    );

    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/analyticsReportRequests/R1/reports",
      expect.objectContaining({ "filter[category]": "COMMERCE" }),
    );
    expect(result.json()).toEqual({
      reports: [
        {
          id: "AR1",
          name: "App Downloads Standard",
          category: "COMMERCE",
          accessType: "ONGOING",
          requestId: "R1",
        },
      ],
    });
  });

  it("should say how to start when the app has no request", async () => {
    const get = vi.fn(() => Promise.resolve(NO_REQUESTS));
    const { provider } = mockClient({ get: get as AscClient["get"] });
    const result = await run(["analytics", "reports", "123"], provider);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found]");
    expect(result.stderr).toContain("asc analytics request <app-id> --yes");
  });

  it("should list instances by granularity and processing date", async () => {
    const get = vi.fn(() =>
      Promise.resolve({
        data: [
          {
            type: "analyticsReportInstances",
            id: "I1",
            attributes: { granularity: "WEEKLY", processingDate: "2026-11-23" },
          },
        ],
        links: { self: "https://api.appstoreconnect.apple.com/v1/x" },
      }),
    );
    const { provider, client } = mockClient({ get: get as AscClient["get"] });
    const result = await run(
      [
        "analytics",
        "instances",
        "AR1",
        "--granularity",
        "WEEKLY",
        "--date",
        "2026-11-23",
      ],
      provider,
    );

    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/analyticsReports/AR1/instances",
      expect.objectContaining({
        "filter[granularity]": "WEEKLY",
        "filter[processingDate]": "2026-11-23",
      }),
    );
    expect(result.json()).toMatchObject({
      instances: [
        { id: "I1", granularity: "WEEKLY", processingDate: "2026-11-23" },
      ],
      hasMore: false,
    });
  });

  describe("summary", () => {
    const SEGMENTS = {
      data: [
        {
          type: "analyticsReportSegments",
          id: "S1",
          attributes: { url: "https://example.apple.com/s1.gz" },
        },
        {
          type: "analyticsReportSegments",
          id: "S2",
          attributes: { url: "https://example.apple.com/s2.gz" },
        },
      ],
      links: { self: "https://api.appstoreconnect.apple.com/v1/x" },
    };
    const header = [
      "Date",
      "App Apple Identifier",
      "Territory",
      "Source Type",
      "Counts",
      "Unique Counts",
    ];
    const files: Record<string, string> = {
      "https://example.apple.com/s1.gz": tsv([
        header,
        ["2026-11-20", "123", "US", "App Store search", "10", "8"],
        ["2026-11-20", "123", "GB", "App Store search", "4", "3"],
      ]),
      "https://example.apple.com/s2.gz": tsv([
        header,
        ["2026-11-21", "123", "US", "Web referrer", "6", "5"],
      ]),
    };

    function summaryClient() {
      return mockClient({
        get: vi.fn(() => Promise.resolve(SEGMENTS)) as AscClient["get"],
        downloadSigned: vi.fn((url: string) =>
          Promise.resolve(gzip(files[url] ?? "")),
        ),
      });
    }

    it("should download every segment and sum the numeric columns", async () => {
      const { provider, client } = summaryClient();
      const result = await run(["analytics", "summary", "I1"], provider);

      expect(result.exitCode).toBe(0);
      expect(client.get).toHaveBeenCalledWith(
        "/v1/analyticsReportInstances/I1/segments",
        expect.anything(),
      );
      expect(client.downloadSigned).toHaveBeenCalledTimes(2);
      expect(result.json()).toEqual({
        segments: 2,
        rows: 3,
        columns: header,
        metrics: ["Counts", "Unique Counts"],
        totals: { Counts: 20, "Unique Counts": 16 },
      });
    });

    it("should group by the named columns, largest first", async () => {
      const { provider } = summaryClient();
      const result = await run(
        ["analytics", "summary", "I1", "--group-by", "Territory"],
        provider,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json()).toMatchObject({
        groupBy: ["Territory"],
        groupCount: 2,
        groups: [
          { Territory: "US", Counts: 16, "Unique Counts": 13 },
          { Territory: "GB", Counts: 4, "Unique Counts": 3 },
        ],
      });
    });

    it("should name the report's columns when --group-by has an unknown one", async () => {
      const { provider } = summaryClient();
      const result = await run(
        ["analytics", "summary", "I1", "--group-by", "Country"],
        provider,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        '[invalid_input] This report has no column "Country"',
      );
      expect(result.stderr).toContain("Territory");
    });
  });
});

describe("createAscClient downloads", () => {
  it("should read a report with a token and return its bytes", async () => {
    const { pem } = await generateP256Pem();
    const body = gzip("a\tb\tc\n");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(body));
    const client = await createAscClient(
      { keyId: "TEAMKEY001", issuerId: ISSUER, privateKey: pem },
      { fetch },
    );
    const bytes = await client.download("/v1/salesReports", {
      "filter[frequency]": "DAILY",
      "filter[reportDate]": undefined,
    });

    expect(bytes).toEqual(body);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.appstoreconnect.apple.com/v1/salesReports?filter%5Bfrequency%5D=DAILY",
    );
    expect((init?.headers as Record<string, string>)?.authorization).toMatch(
      /^Bearer /,
    );
  });

  it("should throw AscApiError when a report download is refused", async () => {
    const { pem } = await generateP256Pem();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ errors: [] }, { status: 404 }));
    const client = await createAscClient(
      { keyId: "TEAMKEY001", issuerId: ISSUER, privateKey: pem },
      { fetch },
    );
    await expect(client.download("/v1/salesReports")).rejects.toMatchObject({
      name: "AscApiError",
      status: 404,
    });
  });

  it("should fetch a signed URL without the token, and refuse one that is not HTTPS", async () => {
    const { pem } = await generateP256Pem();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(gzip("x")));
    const client = await createAscClient(
      { keyId: "TEAMKEY001", issuerId: ISSUER, privateKey: pem },
      { fetch },
    );
    await client.downloadSigned("https://example.apple.com/segment.gz");
    const init = fetch.mock.calls[0]?.[1];
    expect(JSON.stringify(init?.headers ?? {})).not.toContain("Bearer");

    await expect(
      client.downloadSigned("http://example.apple.com/segment.gz"),
    ).rejects.toMatchObject({ name: "UnexpectedResponseError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
