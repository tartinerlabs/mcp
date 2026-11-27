import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { createProgram } from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";

/** Runs the CLI, capturing stdout, stderr and the exit code. */
async function run(args: string[], client: AscClient) {
  let stderr = "";
  // The metadata lint checks the listing's URLs; answer them without the network.
  const fetch = vi.fn(async () => new Response(null, { status: 200 }));
  const program = createProgram(() => client, { fetch });
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

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const links = { self: "https://api.appstoreconnect.apple.com/v1/x" };

interface Setup {
  state?: string;
  build?: Record<string, unknown> | null;
  released?: boolean;
  localization?: Record<string, unknown>;
  groups?: string[];
  primaryLocale?: string;
  appInfoLocalization?: Record<string, unknown>;
  reviewDetail?: Record<string, unknown> | null;
  noPrice?: boolean;
  available?: boolean;
  contentRights?: string | null;
  primaryCategory?: string | null;
}

/** A client answering every read `versions check` makes for version V1 of app 123. */
function checkClient({
  state = "PREPARE_FOR_SUBMISSION",
  build = {
    version: "42",
    processingState: "VALID",
    expired: false,
    usesNonExemptEncryption: false,
  },
  released = true,
  localization = {
    locale: "en-US",
    description: "An app",
    keywords: "app",
    supportUrl: "https://example.com/help",
    whatsNew: "Fixes",
  },
  groups = ["IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE", "IPAD_PRO_3GEN_129_PROFILE"],
  primaryLocale = "en-US",
  appInfoLocalization = {
    locale: "en-US",
    name: "Example",
    privacyPolicyUrl: "https://example.com/privacy",
  },
  reviewDetail = {
    contactFirstName: "Ada",
    contactLastName: "Lovelace",
    contactPhone: "+44 20 7946 0000",
    contactEmail: "ada@example.com",
    demoAccountRequired: false,
  },
  noPrice = false,
  available = true,
  contentRights = "DOES_NOT_USE_THIRD_PARTY_CONTENT",
  primaryCategory = "UTILITIES",
}: Setup = {}) {
  const page = (data: unknown[]) => Promise.resolve({ data, links });
  const answers: Record<string, () => Promise<unknown>> = {
    "/v1/appStoreVersions/V1": () =>
      Promise.resolve({
        data: {
          type: "appStoreVersions",
          id: "V1",
          attributes: {
            platform: "IOS",
            versionString: "2.0",
            appVersionState: state,
            copyright: `${new Date().getFullYear()} Example Ltd`,
          },
          relationships: {
            app: { data: { type: "apps", id: "123" } },
            build: { data: build ? { type: "builds", id: "B1" } : null },
          },
        },
        included: build
          ? [{ type: "builds", id: "B1", attributes: build }]
          : [],
      }),
    "/v1/reviewSubmissions": () => page([]),
    "/v1/apps/123": () =>
      Promise.resolve({
        data: {
          type: "apps",
          id: "123",
          attributes: {
            primaryLocale,
            contentRightsDeclaration: contentRights,
          },
        },
      }),

    "/v1/apps/123/appStoreVersions": () =>
      page(
        released
          ? [
              {
                type: "appStoreVersions",
                id: "V0",
                attributes: { appVersionState: "READY_FOR_DISTRIBUTION" },
              },
            ]
          : [],
      ),
    "/v1/appStoreVersions/V1/appStoreVersionLocalizations": () =>
      page([
        {
          type: "appStoreVersionLocalizations",
          id: "L1",
          attributes: localization,
        },
      ]),
    "/v1/appStoreVersionLocalizations/L1/placements": () =>
      page(
        groups.map((group, index) => ({
          type: "appAssetLibraryPlacements",
          id: `P${index}`,
          attributes: {
            placementType: "APP_SCREENSHOT",
            placementGroup: group,
            state: "COMPLETE",
          },
        })),
      ),
    "/v1/apps/123/appInfos": () =>
      page([
        {
          type: "appInfos",
          id: "AI2",
          attributes: { state: "PREPARE_FOR_SUBMISSION" },
          relationships: {
            primaryCategory: {
              data: primaryCategory
                ? { type: "appCategories", id: primaryCategory }
                : null,
            },
          },
        },
      ]),
    "/v1/apps/123/inAppPurchasesV2": () => page([]),
    "/v1/appInfos/AI2/appInfoLocalizations": () =>
      page([
        {
          type: "appInfoLocalizations",
          id: "IL1",
          attributes: appInfoLocalization,
        },
      ]),
    "/v1/appInfos/AI2/ageRatingDeclaration": () =>
      Promise.resolve({
        data: {
          type: "ageRatingDeclarations",
          id: "AR2",
          attributes: { gambling: false },
        },
      }),
    "/v1/apps/123/accessibilityDeclarations": () => page([]),
    "/v1/appStoreVersions/V1/appStoreReviewDetail": () =>
      Promise.resolve({
        data: reviewDetail && {
          type: "appStoreReviewDetails",
          id: "RD1",
          attributes: reviewDetail,
        },
      }),
    "/v1/apps/123/appPriceSchedule": () =>
      noPrice
        ? Promise.reject(new AscApiError(404, {}))
        : Promise.resolve({
            data: {
              type: "appPriceSchedules",
              id: "S1",
              relationships: {
                baseTerritory: { data: { type: "territories", id: "USA" } },
              },
            },
          }),
    "/v1/appPriceSchedules/S1/manualPrices": () =>
      page([
        {
          type: "appPrices",
          id: "MP1",
          attributes: { startDate: null },
          relationships: {
            territory: { data: { type: "territories", id: "USA" } },
          },
        },
      ]),
    "/v1/appPriceSchedules/S1/automaticPrices": () => page([]),
    "/v1/apps/123/appAvailabilityV2": () =>
      Promise.resolve({
        data: { type: "appAvailabilities", id: "AV1", attributes: {} },
      }),
    "/v2/appAvailabilities/AV1/territoryAvailabilities": () =>
      page([
        {
          type: "territoryAvailabilities",
          id: "TA1",
          attributes: { available },
          relationships: {
            territory: { data: { type: "territories", id: "USA" } },
          },
        },
      ]),
  };
  const fail = () => Promise.reject(new Error("unexpected write"));
  const client: AscClient = {
    get: vi.fn((path: string) =>
      (
        answers[path] ??
        (() => Promise.reject(new Error(`unexpected GET ${path}`)))
      )(),
    ) as AscClient["get"],
    post: vi.fn(fail) as AscClient["post"],
    patch: vi.fn(fail) as AscClient["patch"],
    delete: vi.fn(fail),
    upload: vi.fn(fail),
    download: vi.fn(() => Promise.reject(new Error("unexpected download"))),
    downloadSigned: vi.fn(() =>
      Promise.reject(new Error("unexpected download")),
    ),
  };
  return client;
}

describe("versions check", () => {
  it("passes a version with everything in place", async () => {
    const client = checkClient();
    const result = await run(["versions", "check", "V1"], client);
    expect(result.exitCode).toBe(0);
    const report = result.json();
    expect(report).toMatchObject({
      version: { versionId: "V1", version: "2.0" },
      ready: true,
      blocking: [],
      warnings: [],
      checks: {
        build: { status: "pass" },
        metadata: { status: "pass" },
        screenshots: { status: "pass" },
        reviewDetails: { status: "pass" },
        pricing: { status: "pass" },
        availability: { status: "pass", availableCount: 1 },
        categories: { status: "pass", primaryCategory: "UTILITIES" },
        contentRights: {
          status: "pass",
          contentRightsDeclaration: "DOES_NOT_USE_THIRD_PARTY_CONTENT",
        },
        metadataLint: { status: "pass", errors: 0, warnings: 0 },
      },
    });
    expect(report.assumptions.length).toBeGreaterThan(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("lists every problem and exits 1", async () => {
    const client = checkClient({
      build: {
        version: "42",
        processingState: "VALID",
        expired: false,
        usesNonExemptEncryption: null,
      },
      localization: { locale: "en-US", description: "An app" },
      groups: [],
      appInfoLocalization: { locale: "en-US", name: "Example" },
      reviewDetail: null,
      noPrice: true,
      available: false,
    });
    const result = await run(["versions", "check", "V1"], client);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("not ready to submit");
    const report = result.json();
    expect(report.ready).toBe(false);
    expect(report.blocking).toEqual([
      "build: build 42 has not answered the export compliance question; use builds compliance B1.",
      "metadata: en-US has no keywords, supportUrl, whatsNew; use metadata set.",
      "appInfo: en-US has no privacyPolicyUrl; use app-info set AI2.",
      "screenshots: en-US has no screenshots; use screenshots upload.",
      "reviewDetails: contactFirstName, contactLastName, contactPhone, contactEmail blank; use review-details set.",
      "pricing: the app has no price set; set one in App Store Connect.",
      "availability: the app is not available in any territory; use availability set.",
    ]);
  });

  it("asks for What's New only once a version has been released", async () => {
    const client = checkClient({
      released: false,
      localization: {
        locale: "en-US",
        description: "An app",
        keywords: "app",
        supportUrl: "https://example.com/help",
      },
    });
    const result = await run(["versions", "check", "V1"], client);
    expect(result.exitCode).toBe(0);
    expect(result.json().checks.metadata.status).toBe("pass");
  });

  it("warns without blocking when a locale has no iPad screenshots", async () => {
    const client = checkClient({
      groups: ["IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE"],
    });
    const result = await run(["versions", "check", "V1"], client);
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      ready: true,
      checks: { screenshots: { status: "warn" } },
    });
    expect(result.json().warnings[0]).toContain("no iPad screenshots");
  });

  it("warns without blocking when a locale other than the primary one has no screenshots", async () => {
    const client = checkClient({ groups: [], primaryLocale: "fr-FR" });
    const result = await run(["versions", "check", "V1"], client);
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      ready: true,
      checks: { screenshots: { status: "warn" } },
    });
    expect(result.json().warnings).toContain(
      "screenshots: en-US has no screenshots; use screenshots upload. The App Store shows the fr-FR screenshots instead.",
    );
  });

  it("blocks a version without a primary category or content rights declaration", async () => {
    const client = checkClient({ primaryCategory: null, contentRights: null });
    const result = await run(["versions", "check", "V1"], client);
    expect(result.exitCode).toBe(1);
    const report = result.json();
    expect(report.checks.categories.status).toBe("fail");
    expect(report.checks.contentRights.status).toBe("fail");
    expect(report.blocking).toContain(
      "categories: app info AI2 has no primary category; use app-info categories AI2 --primary <category>.",
    );
    expect(report.blocking).toContain(
      "contentRights: the app has no content rights declaration; use apps content-rights 123 --uses-third-party-content or --no-third-party-content.",
    );
  });

  it("blocks on metadata lint errors", async () => {
    const client = checkClient({
      localization: {
        locale: "en-US",
        description: "Lorem ipsum dolor sit amet",
        keywords: "habit,tracker",
        supportUrl: "https://example.com/support",
        whatsNew: "Fixes",
      },
    });
    const result = await run(["versions", "check", "V1"], client);
    expect(result.exitCode).toBe(1);
    const report = result.json();
    expect(report.checks.metadataLint.status).toBe("fail");
    expect(
      report.blocking.some((problem: string) =>
        problem.startsWith("metadataLint: en-US description:"),
      ),
    ).toBe(true);
  });

  it("blocks a version already in review", async () => {
    const client = checkClient({ state: "WAITING_FOR_REVIEW" });
    const result = await run(["versions", "check", "V1"], client);
    expect(result.exitCode).toBe(1);
    expect(result.json().checks.state.status).toBe("fail");
  });
});
