import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient, AscQuery } from "../src/asc/client.ts";
import {
  type AscClientProvider,
  createProgram,
  type ProgramOptions,
} from "../src/cli.ts";
import {
  AscApiError,
  CredentialsError,
  UnexpectedResponseError,
} from "../src/utils/errors.ts";

/** Write (and report download) methods for read-only tests: any call fails the test. */
function noWrites(): Pick<
  AscClient,
  "post" | "patch" | "delete" | "upload" | "download" | "downloadSigned"
> {
  const fail = () => Promise.reject(new Error("unexpected write"));
  return {
    post: vi.fn(fail) as AscClient["post"],
    patch: vi.fn(fail) as AscClient["patch"],
    delete: vi.fn(fail) as AscClient["delete"],
    upload: vi.fn(fail) as AscClient["upload"],
    download: vi.fn(fail) as AscClient["download"],
    downloadSigned: vi.fn(fail) as AscClient["downloadSigned"],
  };
}

/** A spied provider and client whose `get` resolves the given body. */
function respond(body: unknown) {
  const client: AscClient = {
    ...noWrites(),
    get: vi.fn(() => Promise.resolve(body)) as AscClient["get"],
  };
  const provider = vi.fn<AscClientProvider>(() => client);
  return { client, provider };
}

/** Runs the CLI, capturing stdout, stderr and the exit code. */
async function run(
  args: string[],
  provider: AscClientProvider,
  options?: ProgramOptions,
) {
  let stderr = "";
  const program = createProgram(provider, options);
  // Subcommands inherit both settings when they are created, so set them on each.
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

const empty = {
  data: [],
  links: { self: "https://api.appstoreconnect.apple.com/v1/x" },
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("apps", () => {
  it("should pass filters, sort and limit and shape each app", async () => {
    const { client, provider } = respond({
      data: [
        {
          type: "apps",
          id: "1234567890",
          attributes: {
            name: "Example",
            bundleId: "com.example.app",
            sku: "EX1",
            primaryLocale: "en-GB",
            isOrEverWasMadeForKids: false,
          },
        },
      ],
      links: {
        self: "x",
        next: "https://api.appstoreconnect.apple.com/v1/apps?cursor=AB",
      },
      meta: { paging: { total: 3, limit: 1 } },
    });
    const result = await run(
      [
        "apps",
        "--bundle-id",
        "com.example.app",
        "--sort=-name",
        "--limit",
        "1",
        "--key-id",
        "ABCDE12345",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(provider).toHaveBeenCalledWith({ keyId: "ABCDE12345" });
    expect(client.get).toHaveBeenCalledWith("/v1/apps", {
      "filter[name]": undefined,
      "filter[bundleId]": "com.example.app",
      sort: "-name",
      "fields[apps]": ["name", "bundleId", "sku", "primaryLocale"],
      limit: 1,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      apps: [
        {
          id: "1234567890",
          name: "Example",
          bundleId: "com.example.app",
          sku: "EX1",
          primaryLocale: "en-GB",
        },
      ],
      total: 3,
      hasMore: true,
      nextCursor: "AB",
    });
  });

  it("should pass --cursor through to read the next page", async () => {
    const { client, provider } = respond(empty);
    const result = await run(["apps", "--cursor", "AB"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps",
      expect.objectContaining({ cursor: "AB" }),
    );
  });

  it("should round-trip an encoded cursor from links.next into the next request", async () => {
    const first = respond({
      data: [],
      links: {
        self: "x",
        next: "https://api.appstoreconnect.apple.com/v1/apps?cursor=A%2BB%2F%3D",
      },
    });
    const page = await run(["apps"], first.provider);
    const { nextCursor } = JSON.parse(page.stdout);
    expect(nextCursor).toBe("A+B/=");

    vi.mocked(console.log).mockClear();
    const second = respond(empty);
    const result = await run(["apps", "--cursor", nextCursor], second.provider);
    expect(result.exitCode).toBe(0);
    expect(second.client.get).toHaveBeenCalledWith(
      "/v1/apps",
      expect.objectContaining({ cursor: "A+B/=" }),
    );
  });

  it("should refuse a URL as the cursor", async () => {
    const { client, provider } = respond(empty);
    const result = await run(
      ["apps", "--cursor", "https://example.com/v1/apps?cursor=AB"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("should default to sorting by name, 50 at a time", async () => {
    const { client, provider } = respond(empty);
    const result = await run(["apps"], provider);
    expect(JSON.parse(result.stdout)).toEqual({ apps: [], hasMore: false });
    expect(provider).toHaveBeenCalledWith({});
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps",
      expect.objectContaining({ sort: "name", limit: 50 }),
    );
  });

  it("should accept the key options before the command", async () => {
    const { provider } = respond(empty);
    await run(
      [
        "--key-id",
        "ABCDE12345",
        "--issuer-id",
        "issuer",
        "--private-key",
        "AuthKey.p8",
        "apps",
      ],
      provider,
    );
    expect(provider).toHaveBeenCalledWith({
      keyId: "ABCDE12345",
      issuerId: "issuer",
      privateKey: "AuthKey.p8",
    });
  });
});

describe("versions", () => {
  it("should include the build, filter by state and sort newest first", async () => {
    const { client, provider } = respond({
      data: [
        {
          type: "appStoreVersions",
          id: "v1",
          attributes: {
            platform: "IOS",
            versionString: "1.0",
            appVersionState: "READY_FOR_DISTRIBUTION",
            appStoreState: "READY_FOR_SALE",
            releaseType: "MANUAL",
            earliestReleaseDate: null,
            createdDate: "2026-01-01T00:00:00.000Z",
          },
          relationships: { build: { data: { type: "builds", id: "b1" } } },
        },
        {
          type: "appStoreVersions",
          id: "v2",
          attributes: {
            platform: "IOS",
            versionString: "1.1",
            appVersionState: "IN_REVIEW",
            appStoreState: "IN_REVIEW",
            releaseType: "AFTER_APPROVAL",
            createdDate: "2026-03-01T00:00:00.000Z",
          },
          relationships: { build: { data: null } },
        },
      ],
      included: [{ type: "builds", id: "b1", attributes: { version: "42" } }],
      links: { self: "x" },
    });
    const result = await run(
      [
        "versions",
        "1234567890",
        "--platform",
        "IOS",
        "--state",
        "IN_REVIEW,READY_FOR_DISTRIBUTION",
      ],
      provider,
    );
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/1234567890/appStoreVersions",
      expect.objectContaining({
        "filter[platform]": "IOS",
        "filter[appVersionState]": ["IN_REVIEW", "READY_FOR_DISTRIBUTION"],
        include: "build",
        "fields[appStoreVersions]": expect.arrayContaining(["build"]),
        "fields[builds]": "version",
        limit: 50,
      }),
    );
    const { versions } = JSON.parse(result.stdout);
    expect(versions.map((v: { id: string }) => v.id)).toEqual(["v2", "v1"]);
    expect(versions[0].build).toBeUndefined();
    expect(versions[1]).toEqual({
      id: "v1",
      platform: "IOS",
      versionString: "1.0",
      appVersionState: "READY_FOR_DISTRIBUTION",
      appStoreState: "READY_FOR_SALE",
      releaseType: "MANUAL",
      earliestReleaseDate: null,
      createdDate: "2026-01-01T00:00:00.000Z",
      build: "42",
    });
  });

  it("should reject an unknown state without calling App Store Connect", async () => {
    const { client, provider } = respond(empty);
    const result = await run(
      ["versions", "1234567890", "--state", "LIVE"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("builds", () => {
  it("should query newest uploads with the pre-release version", async () => {
    const { client, provider } = respond({
      data: [
        {
          type: "builds",
          id: "b1",
          attributes: {
            version: "42",
            uploadedDate: "2026-10-01T00:00:00.000Z",
            expirationDate: "2026-12-30T00:00:00.000Z",
            expired: false,
            minOsVersion: "17.0",
            processingState: "VALID",
            buildAudienceType: "APP_STORE_ELIGIBLE",
            usesNonExemptEncryption: null,
          },
          relationships: {
            preReleaseVersion: {
              data: { type: "preReleaseVersions", id: "p1" },
            },
          },
        },
      ],
      included: [
        {
          type: "preReleaseVersions",
          id: "p1",
          attributes: { version: "1.2.0", platform: "IOS" },
        },
      ],
      links: { self: "x" },
    });
    const result = await run(
      [
        "builds",
        "1234567890",
        "--processing-state",
        "VALID",
        "--no-expired",
        "--build-number",
        "42",
        "--limit",
        "5",
      ],
      provider,
    );
    expect(client.get).toHaveBeenCalledWith(
      "/v1/builds",
      expect.objectContaining({
        "filter[app]": "1234567890",
        "filter[processingState]": ["VALID"],
        "filter[expired]": false,
        "filter[version]": "42",
        sort: "-uploadedDate",
        include: "preReleaseVersion",
        "fields[builds]": expect.arrayContaining([
          "preReleaseVersion",
          "usesNonExemptEncryption",
        ]),
        "fields[preReleaseVersions]": ["version", "platform"],
        limit: 5,
      }),
    );
    expect(JSON.parse(result.stdout).builds).toEqual([
      {
        id: "b1",
        version: "42",
        marketingVersion: "1.2.0",
        platform: "IOS",
        processingState: "VALID",
        uploadedDate: "2026-10-01T00:00:00.000Z",
        expirationDate: "2026-12-30T00:00:00.000Z",
        expired: false,
        buildAudienceType: "APP_STORE_ELIGIBLE",
        minOsVersion: "17.0",
        usesNonExemptEncryption: null,
      },
    ]);
  });

  it("should leave the expired filter out when not given", async () => {
    const { client, provider } = respond(empty);
    await run(["builds", "1"], provider);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/builds",
      expect.objectContaining({ "filter[expired]": undefined }),
    );
  });
});

describe("reviews", () => {
  it("should filter, include the response and join it to each review", async () => {
    const { client, provider } = respond({
      data: [
        {
          type: "customerReviews",
          id: "r1",
          attributes: {
            rating: 1,
            title: "Crashes",
            body: "Crashes on launch.",
            reviewerNickname: "someone",
            createdDate: "2026-10-01T00:00:00.000Z",
            territory: "SGP",
          },
          relationships: {
            response: { data: { type: "customerReviewResponses", id: "c1" } },
          },
        },
        {
          type: "customerReviews",
          id: "r2",
          attributes: { rating: 2, territory: "SGP" },
          relationships: { response: {} },
        },
      ],
      included: [
        {
          type: "customerReviewResponses",
          id: "c1",
          attributes: {
            responseBody: "Fixed in 1.2.",
            state: "PUBLISHED",
            lastModifiedDate: "2026-10-02T00:00:00.000Z",
          },
        },
      ],
      links: { self: "x" },
    });
    const result = await run(
      [
        "reviews",
        "1234567890",
        "--rating",
        "1,2",
        "--territory",
        "SGP",
        "--has-response",
        "--sort",
        "rating",
      ],
      provider,
    );
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/1234567890/customerReviews",
      expect.objectContaining({
        "filter[rating]": ["1", "2"],
        "filter[territory]": "SGP",
        "exists[publishedResponse]": true,
        sort: "rating",
        include: "response",
        "fields[customerReviews]": expect.arrayContaining(["response"]),
      }),
    );
    const { reviews } = JSON.parse(result.stdout);
    expect(reviews[0]).toEqual({
      id: "r1",
      rating: 1,
      title: "Crashes",
      body: "Crashes on launch.",
      reviewerNickname: "someone",
      createdDate: "2026-10-01T00:00:00.000Z",
      territory: "SGP",
      response: {
        responseBody: "Fixed in 1.2.",
        state: "PUBLISHED",
        lastModifiedDate: "2026-10-02T00:00:00.000Z",
      },
    });
    expect(reviews[1].response).toBeUndefined();
  });

  it("should sort newest first and leave the response filter out by default", async () => {
    const { client, provider } = respond(empty);
    await run(["reviews", "1"], provider);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/1/customerReviews",
      expect.objectContaining({
        sort: "-createdDate",
        "exists[publishedResponse]": undefined,
      }),
    );
  });
});

describe("errors", () => {
  it.each([["apps"], ["versions", "1"], ["builds", "1"], ["reviews", "1"]])(
    "should exit with 1 and a classified error from %s",
    async (...args) => {
      const provider: AscClientProvider = () => ({
        ...noWrites(),
        get: () =>
          Promise.reject(
            new AscApiError(404, {
              errors: [
                {
                  status: "404",
                  code: "NOT_FOUND",
                  title: "x",
                  detail: "No app.",
                },
              ],
            }),
          ),
      });
      const result = await run(args, provider);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/\[not_found\]/);
      expect(result.stdout).toBe("");
    },
  );

  it("should report a missing key as an auth error", async () => {
    const result = await run(["apps"], () => {
      throw new CredentialsError("No App Store Connect key ID.");
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[auth] No App Store Connect key ID.");
  });

  it("should reject an app ID that is not numeric", async () => {
    const { client, provider } = respond(empty);
    const result = await run(["builds", "com.example.app"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe.each([
  ["apps", [], "/v1/apps"],
  ["versions", ["1234567890"], "/v1/apps/1234567890/appStoreVersions"],
  ["builds", ["1234567890"], "/v1/builds"],
  ["reviews", ["1234567890"], "/v1/apps/1234567890/customerReviews"],
  ["testflight groups", ["1234567890"], "/v1/betaGroups"],
  ["testflight testers", ["1234567890"], "/v1/betaTesters"],
  [
    "testflight feedback",
    ["1234567890", "--type", "crash"],
    "/v1/apps/1234567890/betaFeedbackCrashSubmissions",
  ],
])("%s --cursor", (command, args, path) => {
  it("should pass the cursor through and print the next one", async () => {
    const { client, provider } = respond({
      data: [],
      links: {
        self: "x",
        next: `https://api.appstoreconnect.apple.com${path}?cursor=NEXT`,
      },
    });
    const result = await run(
      [...command.split(" "), ...args, "--cursor", "AB"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ cursor: "AB" }),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      hasMore: true,
      nextCursor: "NEXT",
    });
  });
});

describe("builds wait", () => {
  /** A builds page holding one build in the given state, or none. */
  function page(processingState?: string) {
    return {
      data: processingState
        ? [
            {
              type: "builds",
              id: "b1",
              attributes: { version: "42", processingState },
            },
          ]
        : [],
      links: { self: "x" },
    };
  }

  /** A client answering each call with the next response; an Error is thrown. */
  function sequence(...responses: unknown[]) {
    const queue = [...responses];
    const client: AscClient = {
      ...noWrites(),
      get: vi.fn(() => {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return next instanceof Error
          ? Promise.reject(next)
          : Promise.resolve(next);
      }) as AscClient["get"],
    };
    return { client, provider: vi.fn<AscClientProvider>(() => client) };
  }

  /** A fake clock that sleep advances, recording each delay. */
  function clock() {
    let time = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      options: {
        now: () => time,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          time += ms;
        },
      } satisfies ProgramOptions,
    };
  }

  const args = ["builds", "wait", "1234567890", "--build-number", "42"];

  it("should poll until the build is VALID and print it", async () => {
    const { client, provider } = sequence(
      page(),
      page("PROCESSING"),
      page("VALID"),
    );
    const { sleeps, options } = clock();
    const result = await run(args, provider, options);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledTimes(3);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/builds",
      expect.objectContaining({
        "filter[app]": "1234567890",
        "filter[version]": "42",
        sort: "-uploadedDate",
        limit: 1,
      }),
    );
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: "b1",
      version: "42",
      processingState: "VALID",
    });
    expect(result.stderr).toContain("Build 42: not visible yet");
    expect(result.stderr).toContain("Build 42: PROCESSING");
  });

  it("should print the build and exit 1 when processing fails", async () => {
    const { provider } = sequence(page("INVALID"));
    const result = await run(args, provider, clock().options);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).processingState).toBe("INVALID");
    expect(result.stderr).toContain("finished processing as INVALID");
  });

  it("should back off on a rate limit instead of failing", async () => {
    const { provider } = sequence(
      new AscApiError(429, undefined),
      new AscApiError(429, undefined),
      page("VALID"),
    );
    const { sleeps, options } = clock();
    const result = await run(args, provider, options);
    expect(result.exitCode).toBe(0);
    expect(sleeps).toEqual([60_000, 120_000]);
    expect(result.stderr).toContain("Rate limited");
  });

  it("should give up after the timeout as [unavailable]", async () => {
    const { client, provider } = sequence(page("PROCESSING"));
    const { options } = clock();
    const result = await run(
      [...args, "--timeout", "1", "--interval", "20"],
      provider,
      options,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[unavailable]");
    expect(result.stderr).toContain("still processing after 1 minute;");
    // Checks at 0s, 20s, 40s and 60s; a fifth at 80s would pass the deadline.
    expect(client.get).toHaveBeenCalledTimes(4);
  });

  it("should fail at once on other errors", async () => {
    const { client, provider } = sequence(new AscApiError(404, undefined));
    const result = await run(args, provider, clock().options);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found]");
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("should require --build-number", async () => {
    const { client, provider } = sequence(page("VALID"));
    const result = await run(
      ["builds", "wait", "1234567890"],
      provider,
      clock().options,
    );
    expect(result.exitCode).toBe(1);
    expect(client.get).not.toHaveBeenCalled();
  });

  it("should still list builds for an app ID", async () => {
    const { client, provider } = sequence(page("VALID"));
    const result = await run(["builds", "1234567890"], provider);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).builds).toHaveLength(1);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/builds",
      expect.objectContaining({ limit: 50 }),
    );
  });
});

describe("status", () => {
  const version = (
    id: string,
    platform: string,
    versionString: string,
    appVersionState: string,
    createdDate: string,
    extra: Record<string, unknown> = {},
  ) => ({
    type: "appStoreVersions",
    id,
    attributes: {
      platform,
      versionString,
      appVersionState,
      releaseType: "MANUAL",
      earliestReleaseDate: null,
      createdDate,
    },
    ...extra,
  });

  const versions = {
    data: [
      // Out of order on purpose: the endpoint has no sort parameter.
      version("v1", "IOS", "1.0.0", "REPLACED_WITH_NEW_VERSION", "2026-01-01"),
      version("v3", "IOS", "1.2.0", "WAITING_FOR_REVIEW", "2026-03-01", {
        relationships: { build: { data: { type: "builds", id: "b3" } } },
      }),
      version("v2", "IOS", "1.1.0", "READY_FOR_DISTRIBUTION", "2026-02-01", {
        relationships: {
          build: { data: { type: "builds", id: "b2" } },
          appStoreVersionPhasedRelease: {
            data: { type: "appStoreVersionPhasedReleases", id: "p2" },
          },
        },
      }),
      version("m1", "MAC_OS", "1.0", "PREPARE_FOR_SUBMISSION", "2026-03-02"),
    ],
    included: [
      { type: "builds", id: "b2", attributes: { version: "20" } },
      { type: "builds", id: "b3", attributes: { version: "30" } },
      {
        type: "appStoreVersionPhasedReleases",
        id: "p2",
        attributes: { phasedReleaseState: "ACTIVE", currentDayNumber: 3 },
      },
    ],
    links: { self: "x" },
  };

  /** Answers the versions request, and builds per platform filter. */
  function router(buildsByPlatform: Record<string, unknown>) {
    const client: AscClient = {
      ...noWrites(),
      get: vi.fn((path: string, query?: Record<string, unknown>) =>
        Promise.resolve(
          path === "/v1/builds"
            ? (buildsByPlatform[
                String(query?.["filter[preReleaseVersion.platform]"])
              ] ?? empty)
            : versions,
        ),
      ) as AscClient["get"],
    };
    return { client, provider: vi.fn<AscClientProvider>(() => client) };
  }

  const iosBuild = {
    data: [
      {
        type: "builds",
        id: "b4",
        attributes: { version: "31", processingState: "PROCESSING" },
      },
    ],
    links: { self: "x" },
  };

  it("should summarise each platform", async () => {
    const { client, provider } = router({ IOS: iosBuild });
    const result = await run(["status", "1234567890"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/1234567890/appStoreVersions",
      expect.objectContaining({
        include: "build,appStoreVersionPhasedRelease",
        limit: 200,
      }),
    );
    expect(client.get).toHaveBeenCalledWith(
      "/v1/builds",
      expect.objectContaining({
        "filter[app]": "1234567890",
        "filter[preReleaseVersion.platform]": "IOS",
        sort: "-uploadedDate",
        limit: 1,
      }),
    );
    expect(client.get).toHaveBeenCalledTimes(3);

    const { appId, platforms } = JSON.parse(result.stdout);
    expect(appId).toBe("1234567890");
    expect(Object.keys(platforms)).toEqual(["IOS", "MAC_OS"]);
    expect(platforms.IOS.live).toMatchObject({
      id: "v2",
      version: "1.1.0",
      state: "READY_FOR_DISTRIBUTION",
      build: "20",
      phasedRelease: { phasedReleaseState: "ACTIVE", currentDayNumber: 3 },
    });
    expect(platforms.IOS.inProgress).toMatchObject({
      id: "v3",
      version: "1.2.0",
      state: "WAITING_FOR_REVIEW",
      build: "30",
      phasedRelease: null,
    });
    expect(platforms.IOS.latestBuild).toMatchObject({
      id: "b4",
      version: "31",
      processingState: "PROCESSING",
    });
    expect(platforms.MAC_OS).toMatchObject({
      live: null,
      inProgress: { id: "m1", state: "PREPARE_FOR_SUBMISSION" },
      latestBuild: null,
    });
  });

  it("should not report a version older than the live one as in progress", async () => {
    const { provider } = respond({
      data: [
        version("v0", "IOS", "0.9.0", "DEVELOPER_REJECTED", "2025-12-01"),
        version("v2", "IOS", "1.1.0", "READY_FOR_DISTRIBUTION", "2026-02-01"),
      ],
      links: { self: "x" },
    });
    const result = await run(["status", "1234567890"], provider);
    const { IOS } = JSON.parse(result.stdout).platforms;
    expect(IOS.live.id).toBe("v2");
    expect(IOS.inProgress).toBeNull();
  });

  it("should order versions by instant across UTC offsets", async () => {
    // 01:10-08:00 (09:10Z) is 40 minutes after 01:30-07:00 (08:30Z), though it sorts earlier as text.
    const { provider } = respond({
      data: [
        version(
          "a",
          "IOS",
          "2.0",
          "READY_FOR_DISTRIBUTION",
          "2026-11-01T01:30:00-07:00",
        ),
        version(
          "b",
          "IOS",
          "2.1",
          "WAITING_FOR_REVIEW",
          "2026-11-01T01:10:00-08:00",
        ),
      ],
      links: { self: "x" },
    });
    const result = await run(["status", "1234567890"], provider);
    const { IOS } = JSON.parse(result.stdout).platforms;
    expect(IOS.live.id).toBe("a");
    expect(IOS.inProgress.id).toBe("b");
  });

  it("should limit to one platform with --platform", async () => {
    const { client, provider } = router({});
    const result = await run(
      ["status", "1234567890", "--platform", "MAC_OS"],
      provider,
    );
    expect(Object.keys(JSON.parse(result.stdout).platforms)).toEqual([
      "MAC_OS",
    ]);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/1234567890/appStoreVersions",
      expect.objectContaining({ "filter[platform]": "MAC_OS" }),
    );
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it("should report an app with no versions as no platforms", async () => {
    const { provider } = respond(empty);
    const result = await run(["status", "1234567890"], provider);
    expect(JSON.parse(result.stdout)).toEqual({
      appId: "1234567890",
      platforms: {},
    });
  });

  it("should refuse an unknown platform", async () => {
    const { client, provider } = router({});
    const result = await run(
      ["status", "1234567890", "--platform", "ANDROID"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("reviews reply and delete-reply", () => {
  /** One review, with a developer response when `responseId` is given. */
  function reviewDocument(responseId?: string) {
    return {
      data: {
        type: "customerReviews",
        id: "R1",
        attributes: {
          rating: 1,
          title: "Crashes",
          body: "Crashes on launch",
          reviewerNickname: "sam",
          createdDate: "2026-11-01T00:00:00-07:00",
          territory: "USA",
        },
        relationships: {
          response: {
            data: responseId
              ? { type: "customerReviewResponses", id: responseId }
              : null,
          },
        },
      },
      included: responseId
        ? [
            {
              type: "customerReviewResponses",
              id: responseId,
              attributes: {
                responseBody: "Old reply",
                state: "PUBLISHED",
                lastModifiedDate: "2026-11-02T00:00:00-07:00",
              },
            },
          ]
        : [],
    };
  }

  /** A client that reads the review and records writes. */
  function writable(responseId?: string, post?: () => Promise<unknown>) {
    const client: AscClient = {
      ...noWrites(),
      get: vi.fn(() =>
        Promise.resolve(reviewDocument(responseId)),
      ) as AscClient["get"],
      post: vi.fn(
        post ??
          (() =>
            Promise.resolve({
              data: {
                type: "customerReviewResponses",
                id: "NEW1",
                attributes: {
                  responseBody: "Fixed in 1.2",
                  state: "PENDING_PUBLISH",
                  lastModifiedDate: "2026-11-21T00:00:00-08:00",
                },
              },
            })),
      ) as AscClient["post"],
      patch: vi.fn(() =>
        Promise.reject(new Error("unexpected patch")),
      ) as AscClient["patch"],
      delete: vi.fn(() => Promise.resolve()) as AscClient["delete"],
    };
    return { client, provider: vi.fn<AscClientProvider>(() => client) };
  }

  it("should only show the reply without --yes", async () => {
    const { client, provider } = writable();
    const result = await run(
      ["reviews", "reply", "R1", "--body", "Fixed in 1.2"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/customerReviews/R1",
      expect.objectContaining({ include: "response" }),
    );
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "reply",
      review: expect.objectContaining({ id: "R1", rating: 1 }),
      replaces: false,
      responseBody: "Fixed in 1.2",
    });
    expect(result.stderr).toContain("Dry run: nothing was changed");
  });

  it("should post the reply with --yes", async () => {
    const { client, provider } = writable();
    const result = await run(
      ["reviews", "reply", "R1", "--body", "Fixed in 1.2", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/customerReviewResponses", {
      data: {
        type: "customerReviewResponses",
        attributes: { responseBody: "Fixed in 1.2" },
        relationships: {
          review: { data: { type: "customerReviews", id: "R1" } },
        },
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "reply",
      reviewId: "R1",
      replaced: false,
      response: {
        id: "NEW1",
        responseBody: "Fixed in 1.2",
        state: "PENDING_PUBLISH",
        lastModifiedDate: "2026-11-21T00:00:00-08:00",
      },
    });
    expect(result.stderr).not.toContain("Dry run");
  });

  it("should say when a reply replaces the existing one", async () => {
    const dry = writable("OLD1");
    const preview = await run(
      ["reviews", "reply", "R1", "--body", "New"],
      dry.provider,
    );
    const shown = JSON.parse(preview.stdout);
    expect(shown.replaces).toBe(true);
    expect(shown.review.response.responseBody).toBe("Old reply");

    vi.mocked(console.log).mockClear();
    const real = writable("OLD1");
    const posted = await run(
      ["reviews", "reply", "R1", "--body", "New", "--yes"],
      real.provider,
    );
    expect(JSON.parse(posted.stdout).replaced).toBe(true);
  });

  it("should read the reply from --body-file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-reply-"));
    const file = join(dir, "reply.txt");
    await writeFile(file, "Thanks, fixed in 1.2\n");
    const { client, provider } = writable();
    const result = await run(
      ["reviews", "reply", "R1", "--body-file", file, "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith(
      "/v1/customerReviewResponses",
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: { responseBody: "Thanks, fixed in 1.2" },
        }),
      }),
    );
  });

  it.each([
    [["--body", "a", "--body-file", "x.txt"], "not both"],
    [[], "--body or --body-file"],
    [["--body", "   "], "The reply is empty"],
    [["--body-file", "/no/such/file.txt"], "Could not read"],
  ])("should refuse %j before any request", async (extra, message) => {
    const { client, provider } = writable();
    const result = await run(["reviews", "reply", "R1", ...extra], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain(message);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should refuse a review id that is not one path segment", async () => {
    const { client, provider } = writable();
    const result = await run(
      ["reviews", "reply", "../apps/1", "--body", "x", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("should report a refused reply as [permission]", async () => {
    const { provider } = writable(undefined, () =>
      Promise.reject(new AscApiError(403, undefined)),
    );
    const result = await run(
      ["reviews", "reply", "R1", "--body", "x", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[permission]");
  });

  it("should only show the response to delete without --yes", async () => {
    const { client, provider } = writable("OLD1");
    const result = await run(["reviews", "delete-reply", "R1"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.delete).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      action: "delete-reply",
      review: { id: "R1", response: { responseBody: "Old reply" } },
    });
    expect(result.stderr).toContain("Dry run");
  });

  it("should delete the response by its own id with --yes", async () => {
    const { client, provider } = writable("OLD1");
    const result = await run(
      ["reviews", "delete-reply", "R1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith(
      "/v1/customerReviewResponses/OLD1",
    );
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "delete-reply",
      reviewId: "R1",
      deletedResponseId: "OLD1",
    });
  });

  it("should fail as [not_found] when there is no response to delete", async () => {
    const { client, provider } = writable();
    const result = await run(
      ["reviews", "delete-reply", "R1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found]");
    expect(result.stderr).toContain("no developer response");
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("should still list reviews for an app ID", async () => {
    const { client, provider } = respond(empty);
    const result = await run(["reviews", "1234567890"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/1234567890/customerReviews",
      expect.objectContaining({ include: "response" }),
    );
  });
});

describe("builds compliance", () => {
  /** One build with the given export compliance answer. */
  function buildDocument(usesNonExemptEncryption: boolean | null) {
    return {
      data: {
        type: "builds",
        id: "B1",
        attributes: {
          version: "42",
          processingState: "VALID",
          usesNonExemptEncryption,
        },
        relationships: {
          preReleaseVersion: {
            data: { type: "preReleaseVersions", id: "p1" },
          },
        },
      },
      included: [
        {
          type: "preReleaseVersions",
          id: "p1",
          attributes: { version: "1.2.0", platform: "IOS" },
        },
      ],
    };
  }

  /** A client that reads the build and records the PATCH. */
  function writable(usesNonExemptEncryption: boolean | null) {
    const client: AscClient = {
      ...noWrites(),
      get: vi.fn(() =>
        Promise.resolve(buildDocument(usesNonExemptEncryption)),
      ) as AscClient["get"],
      patch: vi.fn(() =>
        Promise.resolve(buildDocument(false)),
      ) as AscClient["patch"],
    };
    return { client, provider: vi.fn<AscClientProvider>(() => client) };
  }

  it("should only show the build and its answer without --yes", async () => {
    const { client, provider } = writable(null);
    const result = await run(
      ["builds", "compliance", "B1", "--no-encryption"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/builds/B1",
      expect.objectContaining({
        include: "preReleaseVersion",
        "fields[builds]": expect.arrayContaining(["usesNonExemptEncryption"]),
      }),
    );
    expect(client.patch).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "compliance",
      build: expect.objectContaining({
        id: "B1",
        version: "42",
        marketingVersion: "1.2.0",
        usesNonExemptEncryption: null,
      }),
      usesNonExemptEncryption: false,
      changes: true,
    });
    expect(result.stderr).toContain("Dry run: nothing was changed");
  });

  it("should set the answer with --yes", async () => {
    const { client, provider } = writable(null);
    const result = await run(
      ["builds", "compliance", "B1", "--no-encryption", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/builds/B1", {
      data: {
        type: "builds",
        id: "B1",
        attributes: { usesNonExemptEncryption: false },
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "compliance",
      buildId: "B1",
      usesNonExemptEncryption: false,
      changed: true,
    });
    expect(result.stderr).toBe("");
  });

  it("should send true for --encryption", async () => {
    const { client, provider } = writable(false);
    await run(
      ["builds", "compliance", "B1", "--encryption", "--yes"],
      provider,
    );
    expect(client.patch).toHaveBeenCalledWith("/v1/builds/B1", {
      data: {
        type: "builds",
        id: "B1",
        attributes: { usesNonExemptEncryption: true },
      },
    });
  });

  it("should not write when the build already has that answer", async () => {
    const { client, provider } = writable(false);
    const result = await run(
      ["builds", "compliance", "B1", "--no-encryption", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toMatchObject({ changed: false });
  });

  it("should require an answer, even with --yes", async () => {
    const { client, provider } = writable(null);
    const result = await run(["builds", "compliance", "B1", "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Give --no-encryption or --encryption.");
    expect(client.get).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should reject a build id that is not one path segment", async () => {
    const { client, provider } = writable(null);
    const result = await run(
      ["builds", "compliance", "../apps", "--no-encryption"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("builds --group", () => {
  it("should filter builds by beta group", async () => {
    const { client, provider } = respond(empty);
    await run(["builds", "1", "--group", "G1"], provider);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/builds",
      expect.objectContaining({
        "filter[app]": "1",
        "filter[betaGroups]": "G1",
      }),
    );
  });

  it("should leave the group filter out when not given", async () => {
    const { client, provider } = respond(empty);
    await run(["builds", "1"], provider);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/builds",
      expect.objectContaining({ "filter[betaGroups]": undefined }),
    );
  });
});

describe("testflight groups", () => {
  it("should list an app's groups by name and shape each one", async () => {
    const { client, provider } = respond({
      data: [
        {
          type: "betaGroups",
          id: "G1",
          attributes: {
            name: "Friends",
            createdDate: "2026-01-01T00:00:00.000Z",
            isInternalGroup: false,
            hasAccessToAllBuilds: null,
            feedbackEnabled: true,
            publicLinkEnabled: true,
            publicLink: "https://testflight.apple.com/join/abc",
            publicLinkLimitEnabled: true,
            publicLinkLimit: 100,
          },
        },
        {
          type: "betaGroups",
          id: "G2",
          attributes: {
            name: "Team",
            isInternalGroup: true,
            hasAccessToAllBuilds: true,
            publicLinkLimitEnabled: null,
            publicLinkLimit: null,
          },
        },
      ],
      links: { self: "x" },
      meta: { paging: { total: 2 } },
    });
    const result = await run(
      ["testflight", "groups", "1234567890", "--no-internal"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/betaGroups",
      expect.objectContaining({
        "filter[app]": "1234567890",
        "filter[isInternalGroup]": false,
        sort: "name",
      }),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      groups: [
        {
          id: "G1",
          name: "Friends",
          internal: false,
          hasAccessToAllBuilds: null,
          feedbackEnabled: true,
          publicLinkEnabled: true,
          publicLink: "https://testflight.apple.com/join/abc",
          publicLinkLimit: 100,
          createdDate: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "G2",
          name: "Team",
          internal: true,
          hasAccessToAllBuilds: true,
          publicLinkLimit: null,
        },
      ],
      total: 2,
      hasMore: false,
    });
  });

  it("should leave the internal filter out when not given", async () => {
    const { client, provider } = respond(empty);
    await run(["testflight", "groups", "1"], provider);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/betaGroups",
      expect.objectContaining({ "filter[isInternalGroup]": undefined }),
    );
  });
});

describe("testflight testers", () => {
  const testers = {
    data: [
      {
        type: "betaTesters",
        id: "T1",
        attributes: {
          firstName: "Sam",
          lastName: "Lee",
          email: "sam@example.com",
          inviteType: "EMAIL",
          state: "INSTALLED",
        },
      },
    ],
    links: { self: "x" },
  };

  it("should list an app's testers by last name", async () => {
    const { client, provider } = respond(testers);
    const result = await run(["testflight", "testers", "1234567890"], provider);
    expect(result.exitCode).toBe(0);
    const query = vi.mocked(client.get).mock.calls[0]?.[1];
    expect(query).toMatchObject({
      "filter[apps]": "1234567890",
      sort: "lastName",
    });
    expect(query).not.toHaveProperty("filter[betaGroups]");
    expect(JSON.parse(result.stdout).testers).toEqual([
      {
        id: "T1",
        firstName: "Sam",
        lastName: "Lee",
        email: "sam@example.com",
        inviteType: "EMAIL",
        state: "INSTALLED",
      },
    ]);
  });

  it("should filter by group alone, since Apple allows one relationship filter", async () => {
    const { client, provider } = respond(testers);
    await run(
      [
        "testflight",
        "testers",
        "1",
        "--group",
        "G1",
        "--invite-type",
        "PUBLIC_LINK",
      ],
      provider,
    );
    const query = vi.mocked(client.get).mock.calls[0]?.[1];
    expect(query).toMatchObject({
      "filter[betaGroups]": "G1",
      "filter[inviteType]": "PUBLIC_LINK",
    });
    expect(query).not.toHaveProperty("filter[apps]");
  });

  it("should refuse an unknown invite type", async () => {
    const { client, provider } = respond(testers);
    const result = await run(
      ["testflight", "testers", "1", "--invite-type", "SMS"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("testflight feedback", () => {
  function feedback(extra: Record<string, unknown> = {}) {
    return {
      data: [
        {
          type: "betaFeedbackCrashSubmissions",
          id: "F1",
          attributes: {
            createdDate: "2026-10-23T07:42:28.683Z",
            comment: "Crashed on launch",
            email: "sam@example.com",
            timeZone: "Asia/Singapore",
            deviceModel: "iPhone16_2",
            deviceFamily: "IPHONE",
            devicePlatform: "IOS",
            osVersion: "27.0.1",
            appPlatform: "IOS",
            locale: "en-SG",
            architecture: "arm64e",
            connectionType: "WIFI",
            batteryPercentage: 80,
            appUptimeInMilliseconds: null,
            ...extra,
          },
          relationships: {
            build: { data: { type: "builds", id: "B1" } },
            tester: { data: { type: "betaTesters", id: "T1" } },
          },
        },
      ],
      included: [{ type: "builds", id: "B1", attributes: { version: "193" } }],
      links: { self: "x" },
    };
  }

  it("should list crash feedback newest first with its build and no email", async () => {
    const { client, provider } = respond(feedback());
    const result = await run(
      [
        "testflight",
        "feedback",
        "1234567890",
        "--type",
        "crash",
        "--build",
        "B1",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/1234567890/betaFeedbackCrashSubmissions",
      expect.objectContaining({
        "filter[build]": "B1",
        sort: "-createdDate",
        include: "build",
      }),
    );
    expect(JSON.parse(result.stdout).feedback).toEqual([
      {
        id: "F1",
        type: "crash",
        createdDate: "2026-10-23T07:42:28.683Z",
        comment: "Crashed on launch",
        build: { id: "B1", version: "193" },
        deviceModel: "iPhone16_2",
        deviceFamily: "IPHONE",
        devicePlatform: "IOS",
        osVersion: "27.0.1",
        appPlatform: "IOS",
        locale: "en-SG",
        architecture: "arm64e",
        connectionType: "WIFI",
        batteryPercentage: 80,
        appUptimeInMilliseconds: null,
      },
    ]);
    expect(result.stdout).not.toContain("sam@example.com");
    expect(result.stdout).not.toContain("Asia/Singapore");
  });

  it("should read screenshot feedback and keep its screenshots", async () => {
    const screenshots = [{ url: "https://example.com/s.png", width: 1 }];
    const { client, provider } = respond(feedback({ screenshots }));
    const result = await run(
      ["testflight", "feedback", "1", "--type", "screenshot"],
      provider,
    );
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/1/betaFeedbackScreenshotSubmissions",
      expect.anything(),
    );
    expect(JSON.parse(result.stdout).feedback[0]).toMatchObject({
      type: "screenshot",
      screenshots,
    });
  });

  it("should require --type", async () => {
    const { client, provider } = respond(feedback());
    const result = await run(["testflight", "feedback", "1"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Give --type crash or screenshot.");
    expect(client.get).not.toHaveBeenCalled();
  });
});

/**
 * A client for the TestFlight writes: `get` answers by path, and tester
 * lookups find `members` in the group and `appTesters` in the group's app.
 */
function testflightClient({
  members = {},
  appTesters = {},
  buildInGroup = false,
  notes,
}: {
  members?: Record<string, string>;
  appTesters?: Record<string, string>;
  buildInGroup?: boolean;
  notes?: { id: string; whatsNew: string | null };
} = {}) {
  const get = vi.fn((path: string, query: Record<string, unknown> = {}) => {
    if (path === "/v1/betaGroups/G1") {
      return Promise.resolve({
        data: {
          type: "betaGroups",
          id: "G1",
          attributes: {
            name: "Friends",
            isInternalGroup: false,
            hasAccessToAllBuilds: null,
          },
          relationships: { app: { data: { type: "apps", id: "123" } } },
        },
      });
    }
    if (path === "/v1/builds/B1") {
      return Promise.resolve({
        data: { type: "builds", id: "B1", attributes: { version: "42" } },
      });
    }
    if (path === "/v1/betaTesters") {
      const email = query["filter[email]"] as string;
      const id = query["filter[betaGroups]"]
        ? members[email]
        : appTesters[email];
      return Promise.resolve({
        data: id ? [{ type: "betaTesters", id }] : [],
      });
    }
    if (path === "/v1/builds") {
      return Promise.resolve({
        data: buildInGroup ? [{ type: "builds", id: "B1" }] : [],
      });
    }
    if (path === "/v1/betaBuildLocalizations") {
      return Promise.resolve({
        data: notes
          ? [
              {
                type: "betaBuildLocalizations",
                id: notes.id,
                attributes: { whatsNew: notes.whatsNew, locale: "en-GB" },
              },
            ]
          : [],
      });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  const client: AscClient = {
    ...noWrites(),
    get: get as AscClient["get"],
    post: vi.fn((path: string) =>
      Promise.resolve(
        path === "/v1/betaTesters"
          ? { data: { type: "betaTesters", id: "NEW1" } }
          : undefined,
      ),
    ) as AscClient["post"],
    patch: vi.fn(() => Promise.resolve({ data: {} })) as AscClient["patch"],
    delete: vi.fn(() => Promise.resolve()) as AscClient["delete"],
  };
  return { client, provider: vi.fn<AscClientProvider>(() => client) };
}

describe("testflight testers add", () => {
  const options = {
    members: { "in@example.com": "T1" },
    appTesters: { "app@example.com": "T2" },
  };
  const emails = "in@example.com,app@example.com";

  it("should only show what would happen to each email without --yes", async () => {
    const { client, provider } = testflightClient(options);
    const result = await run(
      [
        "testflight",
        "testers",
        "add",
        "G1",
        "--email",
        emails,
        "--email",
        "new@example.com",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith("/v1/betaTesters", {
      "filter[email]": "app@example.com",
      "filter[apps]": "123",
      "fields[betaTesters]": ["state"],
      limit: 1,
    });
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "add-testers",
      group: {
        id: "G1",
        name: "Friends",
        internal: false,
        hasAccessToAllBuilds: null,
      },
      testers: [
        { email: "in@example.com", testerId: "T1", change: "none" },
        { email: "app@example.com", testerId: "T2", change: "add" },
        { email: "new@example.com", change: "invite" },
      ],
    });
    expect(result.stderr).toContain("Dry run: nothing was changed");
  });

  it("should add app testers to the group and invite new ones with --yes", async () => {
    const { client, provider } = testflightClient(options);
    const result = await run(
      [
        "testflight",
        "testers",
        "add",
        "G1",
        "--email",
        `${emails},new@example.com`,
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(client.post).toHaveBeenCalledWith(
      "/v1/betaGroups/G1/relationships/betaTesters",
      { data: [{ type: "betaTesters", id: "T2" }] },
    );
    expect(client.post).toHaveBeenCalledWith("/v1/betaTesters", {
      data: {
        type: "betaTesters",
        attributes: { email: "new@example.com" },
        relationships: {
          betaGroups: { data: [{ type: "betaGroups", id: "G1" }] },
        },
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "add-testers",
      groupId: "G1",
      testers: [
        { email: "in@example.com", testerId: "T1", change: "none" },
        { email: "app@example.com", testerId: "T2", change: "add" },
        { email: "new@example.com", testerId: "NEW1", change: "invite" },
      ],
    });
  });

  it("should write nothing when everyone is already in the group", async () => {
    const { client, provider } = testflightClient(options);
    const result = await run(
      [
        "testflight",
        "testers",
        "add",
        "G1",
        "--email",
        "in@example.com",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should reject a missing or malformed email before calling Apple", async () => {
    const { client, provider } = testflightClient();
    const missing = await run(["testflight", "testers", "add", "G1"], provider);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("Give at least one tester with --email.");
    const bad = await run(
      ["testflight", "testers", "add", "G1", "--email", "nope"],
      provider,
    );
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("Each --email must be an email address.");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("testflight testers remove", () => {
  const options = { members: { "in@example.com": "T1" } };

  it("should only show which emails are in the group without --yes", async () => {
    const { client, provider } = testflightClient(options);
    const result = await run(
      [
        "testflight",
        "testers",
        "remove",
        "G1",
        "--email",
        "in@example.com,out@example.com",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.delete).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      action: "remove-testers",
      testers: [
        { email: "in@example.com", testerId: "T1", change: "remove" },
        { email: "out@example.com", change: "none" },
      ],
    });
  });

  it("should remove the group's testers with --yes", async () => {
    const { client, provider } = testflightClient(options);
    const result = await run(
      [
        "testflight",
        "testers",
        "remove",
        "G1",
        "--email",
        "in@example.com,out@example.com",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith(
      "/v1/betaGroups/G1/relationships/betaTesters",
      { data: [{ type: "betaTesters", id: "T1" }] },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: false,
      groupId: "G1",
    });
  });

  it("should not call Apple to remove when no email is in the group", async () => {
    const { client, provider } = testflightClient();
    await run(
      [
        "testflight",
        "testers",
        "remove",
        "G1",
        "--email",
        "out@example.com",
        "--yes",
      ],
      provider,
    );
    expect(client.delete).not.toHaveBeenCalled();
  });
});

describe("testflight groups add-build", () => {
  it("should only show the group and the build without --yes", async () => {
    const { client, provider } = testflightClient();
    const result = await run(
      ["testflight", "groups", "add-build", "G1", "B1"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/builds",
      expect.objectContaining({
        "filter[betaGroups]": "G1",
        "filter[id]": "B1",
      }),
    );
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "add-build",
      group: expect.objectContaining({ id: "G1", name: "Friends" }),
      build: { id: "B1", version: "42" },
      changes: true,
    });
  });

  it("should add the build with --yes", async () => {
    const { client, provider } = testflightClient();
    const result = await run(
      ["testflight", "groups", "add-build", "G1", "B1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith(
      "/v1/betaGroups/G1/relationships/builds",
      { data: [{ type: "builds", id: "B1" }] },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "add-build",
      groupId: "G1",
      buildId: "B1",
      changed: true,
    });
  });

  it("should not write when the group already has the build", async () => {
    const { client, provider } = testflightClient({ buildInGroup: true });
    const result = await run(
      ["testflight", "groups", "add-build", "G1", "B1", "--yes"],
      provider,
    );
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toMatchObject({ changed: false });
  });

  it("should surface Apple refusing a build that has not passed beta review", async () => {
    const { client, provider } = testflightClient();
    vi.mocked(client.post).mockRejectedValue(
      new AscApiError(409, {
        errors: [{ code: "ENTITY_ERROR", detail: "Build is not approved." }],
      }),
    );
    const result = await run(
      ["testflight", "groups", "add-build", "G1", "B1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[/);
  });
});

describe("testflight notes", () => {
  it("should show the current and new notes without --yes", async () => {
    const { client, provider } = testflightClient({
      notes: { id: "L1", whatsNew: "Old notes" },
    });
    const result = await run(
      ["testflight", "notes", "B1", "--locale", "en-GB", "--body", "New notes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/betaBuildLocalizations",
      expect.objectContaining({
        "filter[build]": "B1",
        "filter[locale]": "en-GB",
      }),
    );
    expect(client.patch).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "notes",
      build: { id: "B1", version: "42" },
      locale: "en-GB",
      current: "Old notes",
      whatsNew: "New notes",
      creates: false,
      changes: true,
    });
  });

  it("should update existing notes with --yes", async () => {
    const { client, provider } = testflightClient({
      notes: { id: "L1", whatsNew: "Old notes" },
    });
    const result = await run(
      [
        "testflight",
        "notes",
        "B1",
        "--locale",
        "en-GB",
        "--body",
        "New notes",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/betaBuildLocalizations/L1", {
      data: {
        type: "betaBuildLocalizations",
        id: "L1",
        attributes: { whatsNew: "New notes" },
      },
    });
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "notes",
      buildId: "B1",
      locale: "en-GB",
      changed: true,
    });
  });

  it("should create notes for a language the build has none in", async () => {
    const { client, provider } = testflightClient();
    const dir = await mkdtemp(join(tmpdir(), "asc-notes-"));
    const file = join(dir, "notes.txt");
    await writeFile(file, "Try the timeline.\n");
    const result = await run(
      [
        "testflight",
        "notes",
        "B1",
        "--locale",
        "fr-FR",
        "--body-file",
        file,
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/betaBuildLocalizations", {
      data: {
        type: "betaBuildLocalizations",
        attributes: { locale: "fr-FR", whatsNew: "Try the timeline." },
        relationships: { build: { data: { type: "builds", id: "B1" } } },
      },
    });
  });

  it("should not write notes that are unchanged", async () => {
    const { client, provider } = testflightClient({
      notes: { id: "L1", whatsNew: "Same" },
    });
    const result = await run(
      [
        "testflight",
        "notes",
        "B1",
        "--locale",
        "en-GB",
        "--body",
        "Same",
        "--yes",
      ],
      provider,
    );
    expect(client.patch).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toMatchObject({ changed: false });
  });

  it("should require a locale and the notes", async () => {
    const { client, provider } = testflightClient();
    const noLocale = await run(
      ["testflight", "notes", "B1", "--body", "x"],
      provider,
    );
    expect(noLocale.exitCode).toBe(1);
    expect(noLocale.stderr).toContain("--locale");
    const noBody = await run(
      ["testflight", "notes", "B1", "--locale", "en-GB"],
      provider,
    );
    expect(noBody.exitCode).toBe(1);
    expect(noBody.stderr).toContain(
      "Give the notes with --body or --body-file.",
    );
    expect(client.get).not.toHaveBeenCalled();
  });
});

/** A client for the metadata commands: `get` answers by path. */
function metadataClient({
  versionState = "PREPARE_FOR_SUBMISSION",
  appInfoState = "PREPARE_FOR_SUBMISSION",
}: {
  versionState?: string;
  appInfoState?: string;
} = {}) {
  const versionLocalization = {
    type: "appStoreVersionLocalizations",
    id: "VL1",
    attributes: {
      locale: "en-US",
      description: "Old description",
      keywords: "one,two",
      promotionalText: null,
      whatsNew: "Bug fixes",
      supportUrl: "https://example.com/support",
      marketingUrl: null,
    },
  };
  const appInfoLocalization = {
    type: "appInfoLocalizations",
    id: "AL1",
    attributes: {
      locale: "en-US",
      name: "Example",
      subtitle: "Old subtitle",
      privacyPolicyUrl: "https://example.com/privacy",
      privacyChoicesUrl: null,
      privacyPolicyText: null,
    },
  };
  const byLocale = (item: { attributes: { locale: string } }, query = {}) => {
    const locale = (query as Record<string, unknown>)["filter[locale]"];
    return {
      data:
        locale === undefined || locale === item.attributes.locale ? [item] : [],
    };
  };
  const get = vi.fn((path: string, query: Record<string, unknown> = {}) => {
    if (path === "/v1/appStoreVersions/V1") {
      return Promise.resolve({
        data: {
          type: "appStoreVersions",
          id: "V1",
          attributes: {
            platform: "IOS",
            versionString: "2.4",
            appVersionState: versionState,
          },
        },
      });
    }
    if (path === "/v1/appStoreVersions/V1/appStoreVersionLocalizations") {
      return Promise.resolve(byLocale(versionLocalization, query));
    }
    if (path === "/v1/apps/123/appInfos") {
      return Promise.resolve({
        data: [
          {
            type: "appInfos",
            id: "AI1",
            attributes: { state: appInfoState, appStoreAgeRating: "FOUR_PLUS" },
            relationships: {
              primaryCategory: {
                data: { type: "appCategories", id: "PRODUCTIVITY" },
              },
              secondaryCategory: { data: null },
            },
          },
        ],
        included: [{ type: "appCategories", id: "PRODUCTIVITY" }],
      });
    }
    if (path === "/v1/appInfos/AI1") {
      return Promise.resolve({
        data: {
          type: "appInfos",
          id: "AI1",
          attributes: { state: appInfoState },
        },
      });
    }
    if (path === "/v1/appInfos/AI1/appInfoLocalizations") {
      return Promise.resolve(byLocale(appInfoLocalization, query));
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  const client: AscClient = {
    ...noWrites(),
    get: get as AscClient["get"],
    post: vi.fn(() => Promise.reject(new Error("unexpected POST"))),
    patch: vi.fn(() => Promise.resolve({ data: {} })) as AscClient["patch"],
    delete: vi.fn(() => Promise.reject(new Error("unexpected DELETE"))),
  };
  return { client, provider: vi.fn<AscClientProvider>(() => client) };
}

describe("metadata", () => {
  it("should print the version and every locale's metadata", async () => {
    const { client, provider } = metadataClient();
    const result = await run(["metadata", "V1"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/appStoreVersions/V1/appStoreVersionLocalizations",
      expect.objectContaining({ limit: 200 }),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      version: {
        id: "V1",
        version: "2.4",
        platform: "IOS",
        state: "PREPARE_FOR_SUBMISSION",
      },
      localizations: [
        {
          id: "VL1",
          locale: "en-US",
          description: "Old description",
          keywords: "one,two",
          promotionalText: null,
          whatsNew: "Bug fixes",
          supportUrl: "https://example.com/support",
          marketingUrl: null,
        },
      ],
    });
  });

  it("should reject an id that is not one path segment", async () => {
    const { client, provider } = metadataClient();
    const result = await run(["metadata", "../apps"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("metadata set", () => {
  const args = [
    "metadata",
    "set",
    "V1",
    "--locale",
    "en-US",
    "--description",
    "New description",
    "--keywords",
    "one,two",
  ];

  it("should show the current and new values without --yes", async () => {
    const { client, provider } = metadataClient();
    const result = await run(args, provider);
    expect(result.exitCode).toBe(0);
    expect(client.patch).not.toHaveBeenCalled();
    expect(result.stderr).toContain("Dry run");
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "metadata",
      version: {
        id: "V1",
        version: "2.4",
        platform: "IOS",
        state: "PREPARE_FOR_SUBMISSION",
      },
      locale: "en-US",
      current: { description: "Old description", keywords: "one,two" },
      update: { description: "New description", keywords: "one,two" },
      changes: true,
    });
  });

  it("should update only the changed fields with --yes", async () => {
    const { client, provider } = metadataClient();
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appStoreVersionLocalizations/VL1",
      {
        data: {
          type: "appStoreVersionLocalizations",
          id: "VL1",
          attributes: { description: "New description" },
        },
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "metadata",
      versionId: "V1",
      locale: "en-US",
      changed: ["description"],
    });
  });

  it("should refuse a version that is no longer editable", async () => {
    const { client, provider } = metadataClient({
      versionState: "READY_FOR_DISTRIBUTION",
    });
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[invalid_input] Version 2.4 is READY_FOR_DISTRIBUTION",
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should allow promotional text on a version that is live", async () => {
    const { client, provider } = metadataClient({
      versionState: "READY_FOR_DISTRIBUTION",
    });
    const result = await run(
      [
        "metadata",
        "set",
        "V1",
        "--locale",
        "en-US",
        "--promotional-text",
        "Now with widgets",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appStoreVersionLocalizations/VL1",
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: { promotionalText: "Now with widgets" },
        }),
      }),
    );
  });

  it("should report a locale the version does not have", async () => {
    const { client, provider } = metadataClient();
    const result = await run(
      [
        "metadata",
        "set",
        "V1",
        "--locale",
        "fr-FR",
        "--whats-new",
        "x",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[not_found] Version 2.4 has no fr-FR metadata",
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should require a locale, a field and valid URLs", async () => {
    const { client, provider } = metadataClient();
    const noField = await run(
      ["metadata", "set", "V1", "--locale", "en-US"],
      provider,
    );
    expect(noField.exitCode).toBe(1);
    expect(noField.stderr).toContain("Give at least one field to change");
    const noLocale = await run(
      ["metadata", "set", "V1", "--keywords", "a"],
      provider,
    );
    expect(noLocale.exitCode).toBe(1);
    expect(noLocale.stderr).toContain("--locale");
    const badUrl = await run(
      [
        "metadata",
        "set",
        "V1",
        "--locale",
        "en-US",
        "--support-url",
        "javascript:alert(1)",
      ],
      provider,
    );
    expect(badUrl.exitCode).toBe(1);
    expect(badUrl.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("app-info", () => {
  it("should print each app info with its categories and locales", async () => {
    const { client, provider } = metadataClient();
    const result = await run(["app-info", "123"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/123/appInfos",
      expect.objectContaining({
        include: expect.arrayContaining([
          "primaryCategory",
          "secondaryCategory",
        ]),
      }),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      appInfos: [
        {
          id: "AI1",
          state: "PREPARE_FOR_SUBMISSION",
          appStoreAgeRating: "FOUR_PLUS",
          categories: {
            primaryCategory: "PRODUCTIVITY",
            primarySubcategoryOne: null,
            primarySubcategoryTwo: null,
            secondaryCategory: null,
            secondarySubcategoryOne: null,
            secondarySubcategoryTwo: null,
          },
          localizations: [
            {
              id: "AL1",
              locale: "en-US",
              name: "Example",
              subtitle: "Old subtitle",
              privacyPolicyUrl: "https://example.com/privacy",
              privacyChoicesUrl: null,
              privacyPolicyText: null,
            },
          ],
        },
      ],
    });
  });

  it("should reject an app ID that is not numeric", async () => {
    const { client, provider } = metadataClient();
    const result = await run(["app-info", "abc"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("app-info set", () => {
  const args = [
    "app-info",
    "set",
    "AI1",
    "--locale",
    "en-US",
    "--subtitle",
    "New subtitle",
  ];

  it("should show the current and new values without --yes", async () => {
    const { client, provider } = metadataClient();
    const result = await run(args, provider);
    expect(result.exitCode).toBe(0);
    expect(client.patch).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "app-info",
      appInfo: { id: "AI1", state: "PREPARE_FOR_SUBMISSION" },
      locale: "en-US",
      current: { subtitle: "Old subtitle" },
      update: { subtitle: "New subtitle" },
      changes: true,
    });
  });

  it("should update the locale with --yes", async () => {
    const { client, provider } = metadataClient();
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/appInfoLocalizations/AL1", {
      data: {
        type: "appInfoLocalizations",
        id: "AL1",
        attributes: { subtitle: "New subtitle" },
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "app-info",
      appInfoId: "AI1",
      locale: "en-US",
      changed: ["subtitle"],
    });
  });

  it("should refuse an app info that is no longer editable", async () => {
    const { client, provider } = metadataClient({
      appInfoState: "READY_FOR_DISTRIBUTION",
    });
    const result = await run(args, provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[invalid_input] App info AI1 is READY_FOR_DISTRIBUTION",
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should report a locale the app info does not have", async () => {
    const { client, provider } = metadataClient();
    const result = await run(
      ["app-info", "set", "AI1", "--locale", "fr-FR", "--name", "x", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[not_found] App info AI1 has no fr-FR localisation",
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should require a locale, a field, valid URLs and a one-segment id", async () => {
    const { client, provider } = metadataClient();
    const noField = await run(
      ["app-info", "set", "AI1", "--locale", "en-US"],
      provider,
    );
    expect(noField.exitCode).toBe(1);
    expect(noField.stderr).toContain("Give at least one field to change");
    const noLocale = await run(
      ["app-info", "set", "AI1", "--subtitle", "a"],
      provider,
    );
    expect(noLocale.exitCode).toBe(1);
    expect(noLocale.stderr).toContain("--locale");
    const badUrl = await run(
      [
        "app-info",
        "set",
        "AI1",
        "--locale",
        "en-US",
        "--privacy-policy-url",
        "ftp://x",
      ],
      provider,
    );
    expect(badUrl.exitCode).toBe(1);
    expect(badUrl.stderr).toContain("[invalid_input]");
    const badId = await run(
      ["app-info", "set", "../apps", "--locale", "en-US", "--name", "x"],
      provider,
    );
    expect(badId.exitCode).toBe(1);
    expect(badId.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });
});

const IPHONE = "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE";
const IPAD = "IPAD_PRO_3GEN_129_PROFILE";

/** The header of a PNG of this size, which is all `imageSize` reads. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A JPEG with an APP0 segment before its start-of-frame. */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(2 + 18 + 19);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xffd8);
  view.setUint16(2, 0xffe0);
  view.setUint16(4, 16);
  view.setUint16(20, 0xffc0);
  view.setUint16(22, 17);
  bytes[24] = 8;
  view.setUint16(25, height);
  view.setUint16(27, width);
  return bytes;
}

/** A version with en-US (two screenshots and a preview for iPhone) and ja (none). */
function screenshotsClient({
  versionState = "PREPARE_FOR_SUBMISSION",
}: {
  versionState?: string;
} = {}) {
  const onVersion = {
    appStoreVersionLocalization: {
      data: { type: "appStoreVersionLocalizations", id: "VL1" },
    },
  };
  const placement = (
    id: string,
    placementType: string,
    asset: { type: string; id: string },
  ) => ({
    type: "appAssetLibraryPlacements",
    id,
    attributes: {
      placementType,
      placementGroup: IPHONE,
      state: "PARENT_PREPARE_FOR_SUBMISSION",
    },
    relationships: {
      [asset.type === "appAssetLibraryImages" ? "image" : "video"]: {
        data: asset,
      },
      ...onVersion,
    },
  });
  const placements = [
    placement("P1", "APP_SCREENSHOT", {
      type: "appAssetLibraryImages",
      id: "I1",
    }),
    placement("P2", "APP_SCREENSHOT", {
      type: "appAssetLibraryImages",
      id: "I2",
    }),
    placement("P3", "APP_PREVIEW", { type: "appAssetLibraryVideos", id: "V1" }),
  ];
  const included = [
    {
      type: "appAssetLibraryImages",
      id: "I1",
      attributes: { fileName: "1.png", state: "PREPARE_FOR_SUBMISSION" },
    },
    {
      type: "appAssetLibraryImages",
      id: "I2",
      attributes: { fileName: "2.png", state: "PREPARE_FOR_SUBMISSION" },
    },
    {
      type: "appAssetLibraryVideos",
      id: "V1",
      attributes: { fileName: "preview.mp4", state: "UPLOAD_COMPLETE" },
    },
  ];
  const localizations = [
    {
      type: "appStoreVersionLocalizations",
      id: "VL1",
      attributes: { locale: "en-US" },
    },
    {
      type: "appStoreVersionLocalizations",
      id: "VL2",
      attributes: { locale: "ja" },
    },
  ];
  const get = vi.fn((path: string, query: Record<string, unknown> = {}) => {
    if (path === "/v1/appStoreVersions/V1") {
      return Promise.resolve({
        data: {
          type: "appStoreVersions",
          id: "V1",
          attributes: {
            versionString: "2.4",
            platform: "IOS",
            appVersionState: versionState,
          },
          relationships:
            query.include === "app"
              ? { app: { data: { type: "apps", id: "123" } } }
              : undefined,
        },
      });
    }
    if (path === "/v1/appStoreVersions/V1/appStoreVersionLocalizations") {
      const locale = query["filter[locale]"];
      return Promise.resolve({
        data: localizations.filter(
          (item) => locale === undefined || item.attributes.locale === locale,
        ),
      });
    }
    if (path === "/v1/appStoreVersionLocalizations/VL1/placements") {
      const group = query["filter[placementGroup]"];
      return Promise.resolve({
        data: group === undefined || group === IPHONE ? placements : [],
        included,
      });
    }
    if (path === "/v1/appStoreVersionLocalizations/VL2/placements") {
      return Promise.resolve({ data: [] });
    }
    if (path === "/v1/appAssetLibraryRefData") {
      return Promise.resolve({
        data: [
          {
            type: "appAssetLibraryRefData",
            id: "1",
            attributes: {
              imageSpecs: [
                {
                  specId: "S1",
                  dimensions: {
                    minWidth: 1290,
                    maxWidth: 1290,
                    minHeight: 2796,
                    maxHeight: 2796,
                  },
                },
                {
                  specId: "S2",
                  dimensions: {
                    minWidth: 2064,
                    maxWidth: 2064,
                    minHeight: 2752,
                    maxHeight: 2752,
                  },
                },
                {
                  specId: "S4",
                  dimensions: {
                    minWidth: 2048,
                    maxWidth: 2048,
                    minHeight: 2732,
                    maxHeight: 2732,
                  },
                },
              ],
              placementTypes: [
                {
                  placementTypeId: "APP_SCREENSHOT",
                  specMappings: [
                    { placementGroupId: IPHONE, specs: ["S1"] },
                    { placementGroupId: IPAD, specs: ["S2", "S4"] },
                    { placementGroupId: "IPAD_PRO_129_LEGACY", specs: ["S4"] },
                  ],
                },
                {
                  placementTypeId: "APP_PREVIEW",
                  specMappings: [{ placementGroupId: IPHONE, specs: ["S3"] }],
                },
              ],
              features: [
                {
                  featureId: "APP_STORE_VERSIONS",
                  placementPolicies: [
                    {
                      placementType: "APP_SCREENSHOT",
                      groupLimits: [{ groupIds: [IPHONE, IPAD], maxCount: 10 }],
                    },
                    {
                      placementType: "APP_PREVIEW",
                      groupLimits: [{ groupIds: [IPHONE], maxCount: 3 }],
                    },
                  ],
                },
              ],
            },
          },
        ],
      });
    }
    if (path === "/v1/apps/123/assetLibrary") {
      return Promise.resolve({ data: { type: "appAssetLibraries", id: "L1" } });
    }
    if (path === "/v1/appAssetLibraryPlacements/P1") {
      return Promise.resolve({ data: placements[0], included });
    }
    // A product page header, and a screenshot on a custom product page.
    if (path === "/v1/appAssetLibraryPlacements/H1") {
      return Promise.resolve({
        data: {
          ...placements[0],
          id: "H1",
          attributes: { placementType: "PRODUCT_PAGE_HEADER_ASSET" },
        },
        included,
      });
    }
    if (path === "/v1/appAssetLibraryPlacements/C1") {
      return Promise.resolve({
        data: {
          ...placements[0],
          id: "C1",
          relationships: {
            appCustomProductPageLocalization: {
              data: { type: "appCustomProductPageLocalizations", id: "CL1" },
            },
          },
        },
        included,
      });
    }
    if (path === "/v1/appStoreVersionLocalizations/VL1") {
      return Promise.resolve({
        data: {
          ...localizations[0],
          relationships: {
            appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } },
          },
        },
      });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  let assets = 0;
  const post = vi.fn((path: string, body: unknown) => {
    if (
      path === "/v1/appAssetLibraryImages" ||
      path === "/v1/appAssetLibraryVideos"
    ) {
      assets += 1;
      const size = (body as { data: { attributes: { fileSize: number } } }).data
        .attributes.fileSize;
      // Two parts, as Apple sends for a larger file.
      const half = Math.ceil(size / 2);
      return Promise.resolve({
        data: {
          type: path.slice(4),
          id: `A${assets}`,
          attributes: {
            state: "AWAITING_UPLOAD",
            uploadOperations: [
              {
                method: "PUT",
                url: "https://upload.example/1",
                offset: 0,
                length: half,
              },
              {
                method: "PUT",
                url: "https://upload.example/2",
                offset: half,
                length: size - half,
              },
            ],
          },
        },
      });
    }
    if (path === "/v1/appAssetLibraryPlacements") {
      return Promise.resolve({
        data: { type: "appAssetLibraryPlacements", id: `NP${assets}` },
      });
    }
    if (path === "/v1/appAssetLibraryPlacementOrderingRequests") {
      return Promise.resolve({ data: { id: "O1" } });
    }
    return Promise.reject(new Error(`unexpected POST ${path}`));
  });
  const client: AscClient = {
    get: get as AscClient["get"],
    post: post as AscClient["post"],
    patch: vi.fn(() => Promise.resolve({ data: {} })) as AscClient["patch"],
    delete: vi.fn(() => Promise.resolve()),
    upload: vi.fn(() => Promise.resolve()),
    download: vi.fn(() => Promise.reject(new Error("unexpected download"))),
    downloadSigned: vi.fn(() =>
      Promise.reject(new Error("unexpected download")),
    ),
  };
  return { client, provider: vi.fn<AscClientProvider>(() => client) };
}

describe("screenshots", () => {
  it("should print each locale's screenshots and previews by group in order", async () => {
    const { client, provider } = screenshotsClient();
    const result = await run(["screenshots", "V1"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/appStoreVersionLocalizations/VL1/placements",
      expect.objectContaining({
        "filter[placementType]": ["APP_SCREENSHOT", "APP_PREVIEW"],
        sort: "placementGroupPosition",
        include: ["image", "video"],
      }),
    );
    const output = JSON.parse(result.stdout);
    expect(output.localizations).toEqual([
      {
        id: "VL1",
        locale: "en-US",
        groups: [
          {
            placementType: "APP_SCREENSHOT",
            placementGroup: IPHONE,
            placements: [
              {
                id: "P1",
                state: "PARENT_PREPARE_FOR_SUBMISSION",
                fileName: "1.png",
                assetState: "PREPARE_FOR_SUBMISSION",
              },
              {
                id: "P2",
                state: "PARENT_PREPARE_FOR_SUBMISSION",
                fileName: "2.png",
                assetState: "PREPARE_FOR_SUBMISSION",
              },
            ],
          },
          {
            placementType: "APP_PREVIEW",
            placementGroup: IPHONE,
            placements: [
              {
                id: "P3",
                state: "PARENT_PREPARE_FOR_SUBMISSION",
                fileName: "preview.mp4",
                assetState: "UPLOAD_COMPLETE",
              },
            ],
          },
        ],
      },
      { id: "VL2", locale: "ja", groups: [] },
    ]);
  });

  it("should report a locale the version does not have", async () => {
    const { provider } = screenshotsClient();
    const result = await run(
      ["screenshots", "V1", "--locale", "fr-FR"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found]");
  });
});

describe("screenshots upload", () => {
  async function folder() {
    const dir = await mkdtemp(join(tmpdir(), "asc-screenshots-"));
    await mkdir(join(dir, "en-US"));
    await mkdir(join(dir, "ja"));
    await writeFile(join(dir, "en-US", "10-home.png"), png(1290, 2796));
    await writeFile(join(dir, "en-US", "2-menu.jpg"), jpeg(2064, 2752));
    await writeFile(join(dir, "en-US", `${IPHONE}-preview.mp4`), "video");
    await writeFile(join(dir, "en-US", "notes.txt"), "ignored");
    await writeFile(join(dir, "en-US", ".DS_Store"), "ignored");
    // Landscape, read in either orientation.
    await writeFile(join(dir, "ja", "1.png"), png(2796, 1290));
    return dir;
  }

  it("should show where each file goes without --yes", async () => {
    const { client, provider } = screenshotsClient();
    const dir = await folder();
    const result = await run(
      ["screenshots", "upload", "V1", "--dir", dir],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Dry run");
    expect(client.post).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
    const output = JSON.parse(result.stdout);
    expect(output.files).toEqual([
      {
        locale: "en-US",
        file: "2-menu.jpg",
        placementType: "APP_SCREENSHOT",
        placementGroup: IPAD,
        fileSize: 39,
      },
      {
        locale: "en-US",
        file: "10-home.png",
        placementType: "APP_SCREENSHOT",
        placementGroup: IPHONE,
        fileSize: 33,
      },
      {
        locale: "en-US",
        file: `${IPHONE}-preview.mp4`,
        placementType: "APP_PREVIEW",
        placementGroup: IPHONE,
        fileSize: 5,
      },
      {
        locale: "ja",
        file: "1.png",
        placementType: "APP_SCREENSHOT",
        placementGroup: IPHONE,
        fileSize: 33,
      },
    ]);
    expect(output.skipped).toEqual(["en-US/notes.txt"]);
  });

  it("should reserve, send the parts, commit and place each file with --yes", async () => {
    const { client, provider } = screenshotsClient();
    const dir = await folder();
    const result = await run(
      ["screenshots", "upload", "V1", "--dir", dir, "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/appAssetLibraryImages", {
      data: {
        type: "appAssetLibraryImages",
        attributes: {
          fileName: "2-menu.jpg",
          fileSize: 39,
          category: "APP_SCREENSHOTS_AND_PREVIEWS",
        },
        relationships: {
          assetLibrary: { data: { type: "appAssetLibraries", id: "L1" } },
        },
      },
    });
    // Every byte goes up once, in the parts Apple asked for.
    const parts = vi.mocked(client.upload).mock.calls;
    expect(parts).toHaveLength(8);
    expect(parts[0]?.[0].url).toBe("https://upload.example/1");
    expect(Buffer.concat(parts.slice(0, 2).map(([, part]) => part))).toEqual(
      Buffer.from(jpeg(2064, 2752)),
    );
    expect(client.patch).toHaveBeenCalledWith("/v1/appAssetLibraryVideos/A3", {
      data: {
        type: "appAssetLibraryVideos",
        id: "A3",
        attributes: { uploaded: true },
      },
    });
    expect(client.post).toHaveBeenCalledWith("/v1/appAssetLibraryPlacements", {
      data: {
        type: "appAssetLibraryPlacements",
        attributes: { placementType: "APP_PREVIEW", placementGroup: IPHONE },
        relationships: {
          video: { data: { type: "appAssetLibraryVideos", id: "A3" } },
          appStoreVersionLocalization: {
            data: { type: "appStoreVersionLocalizations", id: "VL1" },
          },
        },
      },
    });
    const output = JSON.parse(result.stdout);
    expect(output.dryRun).toBe(false);
    expect(
      output.uploaded.map(
        ({ assetId, placementId }: Record<string, string>) => [
          assetId,
          placementId,
        ],
      ),
    ).toEqual([
      ["A1", "NP1"],
      ["A2", "NP2"],
      ["A3", "NP3"],
      ["A4", "NP4"],
    ]);
  });

  it("should refuse a version that is no longer editable", async () => {
    const { client, provider } = screenshotsClient({
      versionState: "READY_FOR_DISTRIBUTION",
    });
    const result = await run(
      ["screenshots", "upload", "V1", "--dir", await folder(), "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should stop before writing on a file it cannot place", async () => {
    const cases: [string, string | Uint8Array, string][] = [
      ["en-US/odd.png", png(100, 100), "100x100"],
      ["en-US/preview.mov", "video", "app preview"],
      ["fr-FR/1.png", png(1290, 2796), "no fr-FR localization"],
      ["en-US/ipad.png", png(2048, 2732), "fits more than one device group"],
    ];
    for (const [file, content, message] of cases) {
      const { client, provider } = screenshotsClient();
      const dir = await mkdtemp(join(tmpdir(), "asc-screenshots-"));
      await mkdir(join(dir, file.split("/")[0] ?? ""));
      await writeFile(join(dir, file), content);
      const result = await run(
        ["screenshots", "upload", "V1", "--dir", dir, "--yes"],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
      expect(client.post).not.toHaveBeenCalled();
    }
  });

  it("should stop before writing when a group would go past its limit", async () => {
    const { client, provider } = screenshotsClient();
    const dir = await mkdtemp(join(tmpdir(), "asc-screenshots-"));
    await mkdir(join(dir, "en-US"));
    // en-US already has one iPhone preview, and the limit is three.
    for (const n of [1, 2, 3]) {
      await writeFile(join(dir, "en-US", `${IPHONE}-${n}.mp4`), "video");
    }
    for (const yes of [[], ["--yes"]]) {
      const result = await run(
        ["screenshots", "upload", "V1", "--dir", dir, ...yes],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[invalid_input]");
      expect(result.stderr).toContain(
        "has 1 APP_PREVIEW and the folder adds 3",
      );
      expect(result.stderr).toContain("limit of 3");
    }
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should say which files were placed when a later one fails", async () => {
    const { client, provider } = screenshotsClient();
    const post = vi.mocked(client.post);
    const placeOrFail = post.getMockImplementation();
    let placements = 0;
    post.mockImplementation((path, body) => {
      if (path === "/v1/appAssetLibraryPlacements" && ++placements === 2) {
        return Promise.reject(
          new AscApiError(409, {
            errors: [{ code: "STATE_ERROR", detail: "Not now." }],
          }),
        );
      }
      return placeOrFail?.(path, body) as never;
    });
    const result = await run(
      ["screenshots", "upload", "V1", "--dir", await folder(), "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("HTTP 409");
    expect(result.stderr).toContain("Stopped at en-US/10-home.png");
    expect(result.stderr).toContain("en-US/2-menu.jpg (NP1)");
  });

  it("should say a refused part is not about the key", async () => {
    const { client, provider } = screenshotsClient();
    vi.mocked(client.upload).mockRejectedValue(
      new UnexpectedResponseError(
        "Apple's storage refused part of the file with HTTP 403; the upload URL may have expired, so run the upload again.",
      ),
    );
    const result = await run(
      ["screenshots", "upload", "V1", "--dir", await folder(), "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[unexpected] Apple's storage refused");
    expect(result.stderr).toContain("Nothing was placed before it.");
    expect(result.stderr).not.toContain("role");
  });

  it("should require --dir", async () => {
    const { client, provider } = screenshotsClient();
    const result = await run(["screenshots", "upload", "V1"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--dir");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("screenshots reorder", () => {
  const args = [
    "screenshots",
    "reorder",
    "V1",
    "--locale",
    "en-US",
    "--group",
    IPHONE,
    "--placement",
    "P2,P1",
  ];

  it("should show the current and new order without --yes", async () => {
    const { client, provider } = screenshotsClient();
    const result = await run(args, provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      dryRun: true,
      locale: "en-US",
      placementGroup: IPHONE,
      placementType: "APP_SCREENSHOT",
      current: [
        { id: "P1", fileName: "1.png" },
        { id: "P2", fileName: "2.png" },
      ],
      order: [
        { id: "P2", fileName: "2.png" },
        { id: "P1", fileName: "1.png" },
      ],
      changes: true,
    });
  });

  it("should send an ordering request with --yes", async () => {
    const { client, provider } = screenshotsClient();
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith(
      "/v1/appAssetLibraryPlacementOrderingRequests",
      {
        data: {
          type: "appAssetLibraryPlacementOrderingRequests",
          attributes: { placementGroup: IPHONE },
          relationships: {
            orderedPlacements: {
              data: [
                { type: "appAssetLibraryPlacements", id: "P2" },
                { type: "appAssetLibraryPlacements", id: "P1" },
              ],
            },
            appStoreVersionLocalization: {
              data: { type: "appStoreVersionLocalizations", id: "VL1" },
            },
          },
        },
      },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: false,
      changed: true,
    });
  });

  it("should not write an order that is unchanged", async () => {
    const { client, provider } = screenshotsClient();
    const result = await run(
      [...args.slice(0, -1), "P1", "--placement", "P2", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should refuse a version that is no longer editable", async () => {
    const { client, provider } = screenshotsClient({
      versionState: "READY_FOR_DISTRIBUTION",
    });
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should require every screenshot of the group and nothing else", async () => {
    for (const ids of ["P1", "P1,P3", "P1,P9"]) {
      const { client, provider } = screenshotsClient();
      const result = await run([...args.slice(0, -1), ids, "--yes"], provider);
      expect(result.exitCode).toBe(1);
      expect(client.post).not.toHaveBeenCalled();
    }
  });
});

describe("screenshots delete", () => {
  it("should show each placement without --yes", async () => {
    const { client, provider } = screenshotsClient();
    const result = await run(["screenshots", "delete", "P1"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.delete).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "delete",
      placements: [
        {
          id: "P1",
          placementType: "APP_SCREENSHOT",
          placementGroup: IPHONE,
          state: "PARENT_PREPARE_FOR_SUBMISSION",
          fileName: "1.png",
          assetState: "PREPARE_FOR_SUBMISSION",
          versionId: "V1",
          version: "2.4",
          locale: "en-US",
        },
      ],
    });
  });

  it("should refuse what is not a version's screenshot or preview", async () => {
    for (const [id, message] of [
      ["H1", "PRODUCT_PAGE_HEADER_ASSET"],
      ["C1", "not on an App Store version localization"],
    ]) {
      const { client, provider } = screenshotsClient();
      const result = await run(
        ["screenshots", "delete", id ?? "", "--yes"],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[invalid_input]");
      expect(result.stderr).toContain(message);
      expect(client.delete).not.toHaveBeenCalled();
    }
  });

  it("should refuse a placement on a version that is no longer editable", async () => {
    const { client, provider } = screenshotsClient({
      versionState: "READY_FOR_DISTRIBUTION",
    });
    const result = await run(
      ["screenshots", "delete", "P1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("should reject an id that is not one path segment", async () => {
    const { client, provider } = screenshotsClient();
    const result = await run(
      ["screenshots", "delete", "a/b", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("should delete the placement with --yes", async () => {
    const { client, provider } = screenshotsClient();
    const result = await run(
      ["screenshots", "delete", "P1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith(
      "/v1/appAssetLibraryPlacements/P1",
    );
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "delete",
      deleted: ["P1"],
    });
  });
});

/**
 * Custom page CP1 of app 123 with version CV1 (en-US CL1, ja CL2), on top of
 * the screenshots mock for the asset library and ref data.
 */
function customPagesClient({
  versionState = "PREPARE_FOR_SUBMISSION",
  drafts = [] as { id: string; items: Record<string, unknown>[] }[],
} = {}) {
  const base = screenshotsClient();
  const baseGet = vi.mocked(base.client.get).getMockImplementation();
  const localizations = [
    {
      type: "appCustomProductPageLocalizations",
      id: "CL1",
      attributes: { locale: "en-US", promotionalText: "Old text" },
    },
    {
      type: "appCustomProductPageLocalizations",
      id: "CL2",
      attributes: { locale: "ja", promotionalText: null },
    },
  ];
  const get = vi.fn((path: string, query: Record<string, unknown> = {}) => {
    if (path === "/v1/apps/123/appCustomProductPages") {
      return Promise.resolve({
        data: [
          {
            type: "appCustomProductPages",
            id: "CP1",
            attributes: {
              name: "Summer",
              url: "https://apps.apple.com/app/id123?ppid=CP1",
              visible: true,
            },
          },
        ],
        links: { self: "https://api.appstoreconnect.apple.com/v1/x" },
        meta: { paging: { total: 1, limit: 50 } },
      });
    }
    if (path === "/v1/appCustomProductPages/CP1") {
      return Promise.resolve({
        data: {
          type: "appCustomProductPages",
          id: "CP1",
          attributes: query.include
            ? undefined
            : {
                name: "Summer",
                url: "https://apps.apple.com/app/id123?ppid=CP1",
                visible: true,
              },
          relationships: query.include
            ? { app: { data: { type: "apps", id: "123" } } }
            : undefined,
        },
      });
    }
    if (path === "/v1/appCustomProductPages/CP1/appCustomProductPageVersions") {
      return Promise.resolve({
        data: [
          {
            type: "appCustomProductPageVersions",
            id: "CV1",
            attributes: {
              version: "2",
              state: versionState,
              deepLink: "myapp://summer",
            },
          },
        ],
      });
    }
    if (path === "/v1/appCustomProductPageVersions/CV1") {
      return Promise.resolve({
        data: {
          type: "appCustomProductPageVersions",
          id: "CV1",
          attributes: {
            version: "2",
            state: versionState,
            deepLink: "myapp://summer",
          },
          relationships: {
            appCustomProductPage: {
              data: { type: "appCustomProductPages", id: "CP1" },
            },
          },
        },
        included: [
          {
            type: "appCustomProductPages",
            id: "CP1",
            attributes: { name: "Summer" },
          },
        ],
      });
    }
    if (
      path ===
      "/v1/appCustomProductPageVersions/CV1/appCustomProductPageLocalizations"
    ) {
      const locale = query["filter[locale]"];
      return Promise.resolve({
        data: localizations.filter(
          (item) => locale === undefined || item.attributes.locale === locale,
        ),
      });
    }
    if (path.startsWith("/v1/appCustomProductPageLocalizations/")) {
      return Promise.resolve({ data: [] });
    }
    if (path === "/v1/reviewSubmissions") {
      return Promise.resolve({
        data: drafts.map(({ id }) => ({ type: "reviewSubmissions", id })),
      });
    }
    const draft = drafts.find(
      ({ id }) => path === `/v1/reviewSubmissions/${id}/items`,
    );
    if (draft) return Promise.resolve({ data: draft.items });
    return baseGet?.(path, query as AscQuery) as never;
  });
  const basePost = vi.mocked(base.client.post).getMockImplementation();
  const post = vi.fn((path: string, body: unknown) => {
    if (path === "/v1/appCustomProductPages") {
      return Promise.resolve({
        data: {
          type: "appCustomProductPages",
          id: "CP2",
          attributes: {
            name: "Winter",
            url: "https://apps.apple.com/app/id123?ppid=CP2",
            visible: true,
          },
          relationships: {
            appCustomProductPageVersions: {
              data: [{ type: "appCustomProductPageVersions", id: "CV2" }],
            },
          },
        },
      });
    }
    if (path === "/v1/reviewSubmissions") {
      return Promise.resolve({
        data: { type: "reviewSubmissions", id: "RS9" },
      });
    }
    if (path === "/v1/reviewSubmissionItems") {
      return Promise.resolve({
        data: { type: "reviewSubmissionItems", id: "RI1" },
      });
    }
    return basePost?.(path, body) as never;
  });
  const patch = vi.fn((path: string) =>
    Promise.resolve(
      path.startsWith("/v1/reviewSubmissions/")
        ? {
            data: {
              type: "reviewSubmissions",
              id: path.split("/").pop(),
              attributes: { state: "WAITING_FOR_REVIEW" },
            },
          }
        : { data: {} },
    ),
  );
  const client: AscClient = {
    ...base.client,
    get: get as AscClient["get"],
    post: post as AscClient["post"],
    patch: patch as AscClient["patch"],
  };
  return { client, provider: vi.fn<AscClientProvider>(() => client) };
}

describe("custom-pages", () => {
  it("should list an app's pages, filtered by visibility", async () => {
    const { client, provider } = customPagesClient();
    const result = await run(["custom-pages", "123", "--no-visible"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/123/appCustomProductPages",
      expect.objectContaining({ "filter[visible]": "false", limit: 50 }),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      pages: [
        {
          id: "CP1",
          name: "Summer",
          url: "https://apps.apple.com/app/id123?ppid=CP1",
          visible: true,
        },
      ],
      total: 1,
      hasMore: false,
    });
  });

  it("should show a page's versions and each locale's promotional text", async () => {
    const { provider } = customPagesClient();
    const result = await run(["custom-pages", "show", "CP1"], provider);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      page: {
        id: "CP1",
        name: "Summer",
        url: "https://apps.apple.com/app/id123?ppid=CP1",
        visible: true,
      },
      versions: [
        {
          id: "CV1",
          version: "2",
          state: "PREPARE_FOR_SUBMISSION",
          deepLink: "myapp://summer",
          localizations: [
            { id: "CL1", locale: "en-US", promotionalText: "Old text" },
            { id: "CL2", locale: "ja", promotionalText: null },
          ],
        },
      ],
    });
  });
});

// Apple's own local id form for resources created in the same request.
// biome-ignore lint/suspicious/noTemplateCurlyInString: not a template.
const NEW_VERSION = "${new-appCustomProductPageVersion-id}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: not a template.
const NEW_LOCALIZATION = "${new-appCustomProductPageLocalization-id}";

describe("custom-pages create", () => {
  const args = [
    "custom-pages",
    "create",
    "123",
    "--name",
    "Winter",
    "--locale",
    "en-US",
    "--promotional-text",
    "Snow sale",
  ];

  it("should show the page and how many the app has without --yes", async () => {
    const { client, provider } = customPagesClient();
    const result = await run(args, provider);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Dry run");
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "create",
      appId: "123",
      page: {
        name: "Winter",
        locale: "en-US",
        promotionalText: "Snow sale",
        deepLink: null,
      },
      existingPages: 1,
    });
  });

  it("should create the page with its first version and locale with --yes", async () => {
    const { client, provider } = customPagesClient();
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/appCustomProductPages", {
      data: {
        type: "appCustomProductPages",
        attributes: { name: "Winter" },
        relationships: {
          app: { data: { type: "apps", id: "123" } },
          appCustomProductPageVersions: {
            data: [
              {
                type: "appCustomProductPageVersions",
                id: NEW_VERSION,
              },
            ],
          },
        },
      },
      included: [
        {
          type: "appCustomProductPageVersions",
          id: NEW_VERSION,
          relationships: {
            appCustomProductPageLocalizations: {
              data: [
                {
                  type: "appCustomProductPageLocalizations",
                  id: NEW_LOCALIZATION,
                },
              ],
            },
          },
        },
        {
          type: "appCustomProductPageLocalizations",
          id: NEW_LOCALIZATION,
          attributes: { locale: "en-US", promotionalText: "Snow sale" },
        },
      ],
    });
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "create",
      page: {
        id: "CP2",
        name: "Winter",
        url: "https://apps.apple.com/app/id123?ppid=CP2",
        visible: true,
      },
      versionId: "CV2",
    });
  });

  it("should report Apple's page limit as an error", async () => {
    const { client, provider } = customPagesClient();
    vi.mocked(client.post).mockRejectedValue(
      new AscApiError(409, {
        errors: [
          {
            code: "ENTITY_ERROR",
            detail:
              "You have reached the maximum number of custom product pages.",
          },
        ],
      }),
    );
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain(
      "App 123 may have reached Apple's limit of custom product pages",
    );
    expect(result.stderr).toContain("maximum number of custom product pages");
  });

  it("should require a name and a locale", async () => {
    const { client, provider } = customPagesClient();
    const result = await run(["custom-pages", "create", "123"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--name");
    expect(result.stderr).toContain("--locale");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("custom-pages set", () => {
  const args = [
    "custom-pages",
    "set",
    "CV1",
    "--locale",
    "en-US",
    "--promotional-text",
    "New text",
    "--deep-link",
    "myapp://winter",
  ];

  it("should show the current and new values without --yes", async () => {
    const { client, provider } = customPagesClient();
    const result = await run(args, provider);
    expect(result.exitCode).toBe(0);
    expect(client.patch).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "set",
      version: {
        id: "CV1",
        version: "2",
        state: "PREPARE_FOR_SUBMISSION",
        deepLink: "myapp://summer",
        pageId: "CP1",
        page: "Summer",
      },
      locale: "en-US",
      current: { deepLink: "myapp://summer", promotionalText: "Old text" },
      update: { deepLink: "myapp://winter", promotionalText: "New text" },
      changes: true,
    });
  });

  it("should update the version's deep link and the locale's text with --yes", async () => {
    const { client, provider } = customPagesClient();
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appCustomProductPageVersions/CV1",
      {
        data: {
          type: "appCustomProductPageVersions",
          id: "CV1",
          attributes: { deepLink: "myapp://winter" },
        },
      },
    );
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appCustomProductPageLocalizations/CL1",
      {
        data: {
          type: "appCustomProductPageLocalizations",
          id: "CL1",
          attributes: { promotionalText: "New text" },
        },
      },
    );
    expect(JSON.parse(result.stdout).changed).toEqual([
      "deepLink",
      "promotionalText",
    ]);
  });

  it("should refuse a page version in review", async () => {
    const { client, provider } = customPagesClient({
      versionState: "WAITING_FOR_REVIEW",
    });
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[invalid_input] Version 2 of custom product page Summer is WAITING_FOR_REVIEW",
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should report a locale the page version does not have", async () => {
    const { client, provider } = customPagesClient();
    const result = await run(
      [
        "custom-pages",
        "set",
        "CV1",
        "--locale",
        "fr-FR",
        "--promotional-text",
        "x",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found]");
    expect(result.stderr).toContain("no fr-FR localization");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should need --locale for promotional text", async () => {
    const { client, provider } = customPagesClient();
    const result = await run(
      ["custom-pages", "set", "CV1", "--promotional-text", "x"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--locale");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("custom-pages upload", () => {
  it("should place each file on the page's localization with --yes", async () => {
    const { client, provider } = customPagesClient();
    const dir = await mkdtemp(join(tmpdir(), "asc-custom-pages-"));
    await mkdir(join(dir, "ja"));
    await writeFile(join(dir, "ja", "1.png"), png(1290, 2796));
    const dry = await run(
      ["custom-pages", "upload", "CV1", "--dir", dir],
      provider,
    );
    expect(dry.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(dry.stdout).files).toEqual([
      {
        locale: "ja",
        file: "1.png",
        placementType: "APP_SCREENSHOT",
        placementGroup: IPHONE,
        fileSize: 33,
      },
    ]);
    vi.mocked(console.log).mockClear();
    const result = await run(
      ["custom-pages", "upload", "CV1", "--dir", dir, "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/appCustomProductPageLocalizations/CL2/placements",
      expect.anything(),
    );
    expect(client.post).toHaveBeenCalledWith("/v1/appAssetLibraryPlacements", {
      data: {
        type: "appAssetLibraryPlacements",
        attributes: { placementType: "APP_SCREENSHOT", placementGroup: IPHONE },
        relationships: {
          image: { data: { type: "appAssetLibraryImages", id: "A1" } },
          appCustomProductPageLocalization: {
            data: { type: "appCustomProductPageLocalizations", id: "CL2" },
          },
        },
      },
    });
    expect(JSON.parse(result.stdout).uploaded).toEqual([
      expect.objectContaining({ assetId: "A1", placementId: "NP1" }),
    ]);
  });

  it("should refuse a page version that is no longer editable", async () => {
    const { client, provider } = customPagesClient({
      versionState: "APPROVED",
    });
    const result = await run(
      ["custom-pages", "upload", "CV1", "--dir", "/nonexistent", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("custom-pages submit", () => {
  it("should only show the version and submission without --yes", async () => {
    const { client, provider } = customPagesClient();
    const result = await run(["custom-pages", "submit", "CV1"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
    expect(client.get).toHaveBeenCalledWith(
      "/v1/reviewSubmissions",
      expect.objectContaining({
        "filter[app]": "123",
        "filter[platform]": "IOS",
        "filter[state]": "READY_FOR_REVIEW",
      }),
    );
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: "submit",
        platform: "IOS",
        reviewSubmissionId: null,
      }),
    );
  });

  it("should create a submission, add the version and submit it with --yes", async () => {
    const { client, provider } = customPagesClient();
    const result = await run(
      ["custom-pages", "submit", "CV1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/reviewSubmissions", {
      data: {
        type: "reviewSubmissions",
        attributes: { platform: "IOS" },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
    expect(client.post).toHaveBeenCalledWith("/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: "RS9" } },
          appCustomProductPageVersion: {
            data: { type: "appCustomProductPageVersions", id: "CV1" },
          },
        },
      },
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/reviewSubmissions/RS9", {
      data: {
        type: "reviewSubmissions",
        id: "RS9",
        attributes: { submitted: true },
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "submit",
      versionId: "CV1",
      reviewSubmissionId: "RS9",
      state: "WAITING_FOR_REVIEW",
    });
  });

  it("should reuse a draft submission that holds only this version", async () => {
    const { client, provider } = customPagesClient({
      versionState: "READY_FOR_REVIEW",
      drafts: [
        {
          id: "RS1",
          items: [
            {
              type: "reviewSubmissionItems",
              id: "RI1",
              relationships: {
                appCustomProductPageVersion: {
                  data: { type: "appCustomProductPageVersions", id: "CV1" },
                },
              },
            },
          ],
        },
      ],
    });
    const result = await run(
      ["custom-pages", "submit", "CV1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/reviewSubmissions/RS1",
      expect.anything(),
    );
  });

  it("should refuse a draft submission with other items", async () => {
    const { client, provider } = customPagesClient({
      drafts: [
        {
          id: "RS1",
          items: [
            {
              type: "reviewSubmissionItems",
              id: "RI1",
              relationships: { appCustomProductPageVersion: { data: null } },
            },
          ],
        },
      ],
    });
    const result = await run(["custom-pages", "submit", "CV1"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[invalid_input] The app's IOS review submission RS1 is being prepared with 1 other item(s)",
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should refuse a page version that is already approved", async () => {
    const { client, provider } = customPagesClient({
      versionState: "APPROVED",
    });
    const result = await run(
      ["custom-pages", "submit", "CV1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is APPROVED, so it cannot be submitted");
    expect(client.post).not.toHaveBeenCalled();
  });
});

/**
 * Product page test T1 of app 123 with treatment TR1 (en-US TL1, ja TL2), on
 * top of the screenshots mock for the asset library and ref data.
 */
function pageTestsClient({
  state = "PREPARE_FOR_SUBMISSION",
  startDate = null as string | null,
  reviewRequired = true,
  drafts = [] as { id: string; items: Record<string, unknown>[] }[],
} = {}) {
  const base = screenshotsClient();
  const baseGet = vi.mocked(base.client.get).getMockImplementation();
  const test = {
    type: "appStoreVersionExperiments",
    id: "T1",
    attributes: {
      name: "Icon test",
      platform: "IOS",
      state,
      trafficProportion: 30,
      reviewRequired,
      startDate,
      endDate: null,
    },
  };
  const treatment = {
    type: "appStoreVersionExperimentTreatments",
    id: "TR1",
    attributes: {
      name: "Bold",
      appIconName: "AppIconBold",
      promotedDate: null,
    },
  };
  const get = vi.fn((path: string, query: Record<string, unknown> = {}) => {
    if (path === "/v1/apps/123/appStoreVersionExperimentsV2") {
      return Promise.resolve({
        data: [
          {
            ...test,
            relationships: {
              appStoreVersionExperimentTreatments: {
                data: [
                  { type: "appStoreVersionExperimentTreatments", id: "TR1" },
                ],
              },
            },
          },
        ],
        included: [treatment],
        links: { self: "https://api.appstoreconnect.apple.com/v1/x" },
        meta: { paging: { total: 1, limit: 50 } },
      });
    }
    if (path === "/v2/appStoreVersionExperiments/T1") {
      return Promise.resolve({
        data: {
          ...test,
          relationships: { app: { data: { type: "apps", id: "123" } } },
        },
      });
    }
    if (
      path ===
      "/v2/appStoreVersionExperiments/T1/appStoreVersionExperimentTreatments"
    ) {
      return Promise.resolve({ data: [treatment] });
    }
    if (path === "/v1/appStoreVersionExperimentTreatments/TR1") {
      return Promise.resolve({
        data: {
          ...treatment,
          relationships: {
            appStoreVersionExperimentV2: {
              data: { type: "appStoreVersionExperiments", id: "T1" },
            },
          },
        },
      });
    }
    if (
      path ===
      "/v1/appStoreVersionExperimentTreatments/TR1/appStoreVersionExperimentTreatmentLocalizations"
    ) {
      return Promise.resolve({
        data: [
          {
            type: "appStoreVersionExperimentTreatmentLocalizations",
            id: "TL1",
            attributes: { locale: "en-US" },
          },
          {
            type: "appStoreVersionExperimentTreatmentLocalizations",
            id: "TL2",
            attributes: { locale: "ja" },
          },
        ],
      });
    }
    if (
      path.startsWith("/v1/appStoreVersionExperimentTreatmentLocalizations/")
    ) {
      return Promise.resolve({ data: [] });
    }
    if (path === "/v1/reviewSubmissions") {
      return Promise.resolve({
        data: drafts.map(({ id }) => ({ type: "reviewSubmissions", id })),
      });
    }
    const draft = drafts.find(
      ({ id }) => path === `/v1/reviewSubmissions/${id}/items`,
    );
    if (draft) return Promise.resolve({ data: draft.items });
    return baseGet?.(path, query as AscQuery) as never;
  });
  const basePost = vi.mocked(base.client.post).getMockImplementation();
  let created = 0;
  const post = vi.fn((path: string, body: unknown) => {
    if (path === "/v2/appStoreVersionExperiments") {
      return Promise.resolve({
        data: {
          ...test,
          id: "T2",
          attributes: { ...test.attributes, name: "New" },
        },
      });
    }
    if (path === "/v1/appStoreVersionExperimentTreatments") {
      created += 1;
      const { data } = body as { data: { attributes: object } };
      return Promise.resolve({
        data: {
          type: "appStoreVersionExperimentTreatments",
          id: `NT${created}`,
          attributes: data.attributes,
        },
      });
    }
    if (path === "/v1/appStoreVersionExperimentTreatmentLocalizations") {
      created += 1;
      return Promise.resolve({
        data: {
          type: "appStoreVersionExperimentTreatmentLocalizations",
          id: `NL${created}`,
        },
      });
    }
    if (path === "/v1/reviewSubmissions") {
      return Promise.resolve({
        data: { type: "reviewSubmissions", id: "RS9" },
      });
    }
    if (path === "/v1/reviewSubmissionItems") {
      return Promise.resolve({
        data: { type: "reviewSubmissionItems", id: "RI1" },
      });
    }
    return basePost?.(path, body) as never;
  });
  const patch = vi.fn((path: string, body: unknown) => {
    if (path.startsWith("/v1/reviewSubmissions/")) {
      return Promise.resolve({
        data: {
          type: "reviewSubmissions",
          id: path.split("/").pop(),
          attributes: { state: "WAITING_FOR_REVIEW" },
        },
      });
    }
    const { started } = (body as { data: { attributes: { started: boolean } } })
      .data.attributes;
    return Promise.resolve({
      data: {
        ...test,
        attributes: {
          ...test.attributes,
          state: started ? "APPROVED" : "STOPPED",
          startDate: "2026-11-20T00:00:00Z",
        },
      },
    });
  });
  const client: AscClient = {
    ...base.client,
    get: get as AscClient["get"],
    post: post as AscClient["post"],
    patch: patch as AscClient["patch"],
  };
  return { client, provider: vi.fn<AscClientProvider>(() => client) };
}

const TEST_T1 = {
  id: "T1",
  name: "Icon test",
  platform: "IOS",
  state: "PREPARE_FOR_SUBMISSION",
  trafficProportion: 30,
  reviewRequired: true,
  startDate: null,
  endDate: null,
};

describe("page-tests", () => {
  it("should list an app's tests with their treatments, filtered by state", async () => {
    const { client, provider } = pageTestsClient();
    const result = await run(
      ["page-tests", "123", "--state", "APPROVED,COMPLETED"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/123/appStoreVersionExperimentsV2",
      expect.objectContaining({
        "filter[state]": ["APPROVED", "COMPLETED"],
        include: "appStoreVersionExperimentTreatments",
        limit: 50,
      }),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      tests: [
        {
          ...TEST_T1,
          treatments: [
            {
              id: "TR1",
              name: "Bold",
              appIconName: "AppIconBold",
              promotedDate: null,
            },
          ],
        },
      ],
      total: 1,
      hasMore: false,
    });
  });

  it("should reject an unknown state", async () => {
    const { client, provider } = pageTestsClient();
    const result = await run(
      ["page-tests", "123", "--state", "RUNNING"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("should show a test's treatments and their locales", async () => {
    const { provider } = pageTestsClient();
    const result = await run(["page-tests", "show", "T1"], provider);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      test: TEST_T1,
      treatments: [
        {
          id: "TR1",
          name: "Bold",
          appIconName: "AppIconBold",
          promotedDate: null,
          localizations: [
            { id: "TL1", locale: "en-US" },
            { id: "TL2", locale: "ja" },
          ],
        },
      ],
    });
  });
});

describe("page-tests create", () => {
  const args = [
    "page-tests",
    "create",
    "123",
    "--name",
    "New",
    "--traffic-proportion",
    "30",
    "--treatment",
    "Bold=AppIconBold",
    "--treatment",
    "Calm",
    "--locale",
    "en-US,ja",
  ];

  it("should show the test and how many tests are open without --yes", async () => {
    const { client, provider } = pageTestsClient();
    const result = await run(args, provider);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Dry run");
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "create",
      appId: "123",
      test: {
        name: "New",
        platform: "IOS",
        trafficProportion: 30,
        treatments: [
          { name: "Bold", appIconName: "AppIconBold" },
          { name: "Calm", appIconName: null },
        ],
        locales: ["en-US", "ja"],
      },
      openTests: 1,
    });
  });

  it("should create the test, its treatments and their locales with --yes", async () => {
    const { client, provider } = pageTestsClient();
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v2/appStoreVersionExperiments", {
      data: {
        type: "appStoreVersionExperiments",
        attributes: { name: "New", platform: "IOS", trafficProportion: 30 },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/appStoreVersionExperimentTreatments",
      {
        data: {
          type: "appStoreVersionExperimentTreatments",
          attributes: { name: "Bold", appIconName: "AppIconBold" },
          relationships: {
            appStoreVersionExperimentV2: {
              data: { type: "appStoreVersionExperiments", id: "T2" },
            },
          },
        },
      },
    );
    expect(client.post).toHaveBeenCalledWith(
      "/v1/appStoreVersionExperimentTreatmentLocalizations",
      {
        data: {
          type: "appStoreVersionExperimentTreatmentLocalizations",
          attributes: { locale: "ja" },
          relationships: {
            appStoreVersionExperimentTreatment: {
              data: { type: "appStoreVersionExperimentTreatments", id: "NT1" },
            },
          },
        },
      },
    );
    const output = JSON.parse(result.stdout);
    expect(output.test.id).toBe("T2");
    expect(output.treatments).toEqual([
      {
        id: "NT1",
        name: "Bold",
        appIconName: "AppIconBold",
        promotedDate: null,
        localizations: [
          { id: "NL2", locale: "en-US" },
          { id: "NL3", locale: "ja" },
        ],
      },
      {
        id: "NT4",
        name: "Calm",
        appIconName: null,
        promotedDate: null,
        localizations: [
          { id: "NL5", locale: "en-US" },
          { id: "NL6", locale: "ja" },
        ],
      },
    ]);
  });

  it("should say what was created when a later step fails", async () => {
    const { client, provider } = pageTestsClient();
    const post = vi.mocked(client.post).getMockImplementation();
    vi.mocked(client.post).mockImplementation((path, body) =>
      path === "/v1/appStoreVersionExperimentTreatmentLocalizations"
        ? Promise.reject(
            new AscApiError(409, { errors: [{ code: "ENTITY_ERROR" }] }),
          )
        : (post?.(path, body) as never),
    );
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Test T2 was created");
    expect(result.stderr).toContain("Bold (NT1)");
  });

  it("should need a name, a traffic proportion and at most three treatments", async () => {
    const { client, provider } = pageTestsClient();
    const result = await run(
      [
        "page-tests",
        "create",
        "123",
        "--traffic-proportion",
        "150",
        ...["A", "B", "C", "D"].flatMap((name) => ["--treatment", name]),
      ],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--name");
    expect(result.stderr).toContain("at most 3 treatments");
    expect(result.stderr).toContain("trafficProportion");
    expect(result.stderr).toContain("at least one --locale");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("page-tests upload", () => {
  it("should place each file on the treatment's localization with --yes", async () => {
    const { client, provider } = pageTestsClient();
    const dir = await mkdtemp(join(tmpdir(), "asc-page-tests-"));
    await mkdir(join(dir, "ja"));
    await writeFile(join(dir, "ja", "1.png"), png(1290, 2796));
    const dry = await run(
      ["page-tests", "upload", "TR1", "--dir", dir],
      provider,
    );
    expect(dry.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(dry.stdout).files).toEqual([
      {
        locale: "ja",
        file: "1.png",
        placementType: "APP_SCREENSHOT",
        placementGroup: IPHONE,
        fileSize: 33,
      },
    ]);
    vi.mocked(console.log).mockClear();
    const result = await run(
      ["page-tests", "upload", "TR1", "--dir", dir, "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/appStoreVersionExperimentTreatmentLocalizations/TL2/placements",
      expect.anything(),
    );
    expect(client.post).toHaveBeenCalledWith("/v1/appAssetLibraryPlacements", {
      data: {
        type: "appAssetLibraryPlacements",
        attributes: { placementType: "APP_SCREENSHOT", placementGroup: IPHONE },
        relationships: {
          image: { data: { type: "appAssetLibraryImages", id: "A1" } },
          appStoreVersionExperimentTreatmentLocalization: {
            data: {
              type: "appStoreVersionExperimentTreatmentLocalizations",
              id: "TL2",
            },
          },
        },
      },
    });
  });

  it("should refuse a test in review", async () => {
    const { client, provider } = pageTestsClient({ state: "IN_REVIEW" });
    const result = await run(
      ["page-tests", "upload", "TR1", "--dir", "/nonexistent", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[invalid_input] Product page test Icon test is IN_REVIEW",
    );
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("page-tests submit", () => {
  it("should only show the test and submission without --yes", async () => {
    const { client, provider } = pageTestsClient();
    const result = await run(["page-tests", "submit", "T1"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "submit",
      test: TEST_T1,
      reviewSubmissionId: null,
    });
  });

  it("should add the test to a new submission and submit it with --yes", async () => {
    const { client, provider } = pageTestsClient();
    const result = await run(["page-tests", "submit", "T1", "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: "RS9" } },
          appStoreVersionExperimentV2: {
            data: { type: "appStoreVersionExperiments", id: "T1" },
          },
        },
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "submit",
      testId: "T1",
      reviewSubmissionId: "RS9",
      state: "WAITING_FOR_REVIEW",
    });
  });

  it("should refuse a draft submission with other items", async () => {
    const { client, provider } = pageTestsClient({
      drafts: [
        {
          id: "RS1",
          items: [
            {
              type: "reviewSubmissionItems",
              id: "RI1",
              relationships: { appStoreVersionExperimentV2: { data: null } },
            },
          ],
        },
      ],
    });
    const result = await run(["page-tests", "submit", "T1", "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("1 other item(s)");
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("page-tests start and stop", () => {
  it("should start an approved test with --yes", async () => {
    const { client, provider } = pageTestsClient({ state: "APPROVED" });
    const dry = await run(["page-tests", "start", "T1"], provider);
    expect(dry.exitCode).toBe(0);
    expect(client.patch).not.toHaveBeenCalled();
    vi.mocked(console.log).mockClear();
    const result = await run(["page-tests", "start", "T1", "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v2/appStoreVersionExperiments/T1",
      {
        data: {
          type: "appStoreVersionExperiments",
          id: "T1",
          attributes: { started: true },
        },
      },
    );
    expect(JSON.parse(result.stdout).test.startDate).toBe(
      "2026-11-20T00:00:00Z",
    );
  });

  it("should refuse to start a test that still needs review", async () => {
    const { client, provider } = pageTestsClient();
    const result = await run(["page-tests", "start", "T1", "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "is PREPARE_FOR_SUBMISSION, so it cannot start",
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should start a test that needs no review", async () => {
    const { provider } = pageTestsClient({ reviewRequired: false });
    const result = await run(["page-tests", "start", "T1"], provider);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).dryRun).toBe(true);
  });

  it("should refuse to start a test that already started", async () => {
    const { client, provider } = pageTestsClient({
      state: "APPROVED",
      startDate: "2026-11-20T00:00:00Z",
    });
    const result = await run(["page-tests", "start", "T1", "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already started on 2026-11-20T00:00:00Z");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should show a running test without stopping it when --yes is missing", async () => {
    const { client, provider } = pageTestsClient({
      state: "APPROVED",
      startDate: "2026-11-20T00:00:00Z",
    });
    const result = await run(["page-tests", "stop", "T1"], provider);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).dryRun).toBe(true);
    expect(result.stderr).toContain("Dry run");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should stop a running test with --yes", async () => {
    const { client, provider } = pageTestsClient({
      state: "APPROVED",
      startDate: "2026-11-20T00:00:00Z",
    });
    const result = await run(["page-tests", "stop", "T1", "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v2/appStoreVersionExperiments/T1",
      {
        data: {
          type: "appStoreVersionExperiments",
          id: "T1",
          attributes: { started: false },
        },
      },
    );
    expect(JSON.parse(result.stdout).test.state).toBe("STOPPED");
  });

  it("should refuse to stop a test that already ended", async () => {
    const { client, provider } = pageTestsClient({
      state: "STOPPED",
      startDate: "2026-11-20T00:00:00Z",
    });
    const result = await run(["page-tests", "stop", "T1", "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is already STOPPED");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should refuse to stop a test that has not started", async () => {
    const { client, provider } = pageTestsClient({ state: "APPROVED" });
    const result = await run(["page-tests", "stop", "T1", "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has not started");
    expect(client.patch).not.toHaveBeenCalled();
  });
});

const EVENT_CARD = "EVENT_CARD_PROFILE";

/**
 * In-app event E1 of app 123 with en-US localization EL1, on top of the
 * screenshots mock for the asset library, with ref data for event placements.
 */
function eventsClient({
  state = "DRAFT",
  cardPlaced = false,
  drafts = [] as { id: string; items: Record<string, unknown>[] }[],
} = {}) {
  const base = screenshotsClient();
  const baseGet = vi.mocked(base.client.get).getMockImplementation();
  const event = {
    type: "appEvents",
    id: "E1",
    attributes: {
      referenceName: "Winter challenge",
      badge: "CHALLENGE",
      eventState: state,
      priority: "NORMAL",
      purpose: "KEEP_ACTIVE_USERS_INFORMED",
      purchaseRequirement: "NO_COST_ASSOCIATED",
      primaryLocale: "en-US",
      deepLink: null,
      territorySchedules: [
        {
          territories: ["USA", "GBR"],
          publishStart: "2026-12-01T00:00:00Z",
          eventStart: "2026-12-05T00:00:00Z",
          eventEnd: "2026-12-20T00:00:00Z",
        },
      ],
    },
  };
  const localization = {
    type: "appEventLocalizations",
    id: "EL1",
    attributes: {
      locale: "en-US",
      name: "Winter challenge",
      shortDescription: "Beat the cold",
      longDescription: null,
    },
  };
  const get = vi.fn((path: string, query: Record<string, unknown> = {}) => {
    if (path === "/v1/apps/123/appEvents") {
      const id = query["filter[id]"];
      return Promise.resolve({
        data: id === undefined || id === "E1" ? [event] : [],
        links: { self: "https://api.appstoreconnect.apple.com/v1/x" },
        meta: { paging: { total: 4, limit: 50 } },
      });
    }
    if (path === "/v1/appEvents/E1") {
      return Promise.resolve({ data: event });
    }
    if (path === "/v1/appEvents/E1/localizations") {
      return Promise.resolve({ data: [localization] });
    }
    if (path === "/v1/appEvents/E2/localizations") {
      return Promise.resolve({ data: [] });
    }
    if (path === "/v1/appEventLocalizations/EL1/placements") {
      return Promise.resolve({
        data: cardPlaced
          ? [
              {
                type: "appAssetLibraryPlacements",
                id: "EP1",
                attributes: {
                  placementType: "EVENT_CARD_ASSET",
                  placementGroup: EVENT_CARD,
                  state: "PARENT_PREPARE_FOR_SUBMISSION",
                },
                relationships: {
                  image: { data: { type: "appAssetLibraryImages", id: "I9" } },
                },
              },
            ]
          : [],
        included: [
          {
            type: "appAssetLibraryImages",
            id: "I9",
            attributes: {
              fileName: "card.png",
              state: "PREPARE_FOR_SUBMISSION",
            },
          },
        ],
      });
    }
    if (path === "/v1/appAssetLibraryRefData") {
      return Promise.resolve({
        data: [
          {
            type: "appAssetLibraryRefData",
            id: "1",
            attributes: {
              imageSpecs: [],
              placementTypes: [
                {
                  placementTypeId: "EVENT_CARD_ASSET",
                  specMappings: [{ placementGroupId: EVENT_CARD, specs: [] }],
                },
                {
                  placementTypeId: "EVENT_DETAILS_PAGE_ASSET",
                  specMappings: [
                    { placementGroupId: "EVENT_DETAILS_IPHONE", specs: [] },
                    { placementGroupId: "EVENT_DETAILS_IPAD", specs: [] },
                  ],
                },
              ],
              features: [
                {
                  featureId: "IN_APP_EVENTS",
                  placementPolicies: [
                    {
                      placementType: "EVENT_CARD_ASSET",
                      groupLimits: [{ groupIds: [EVENT_CARD], maxCount: 1 }],
                    },
                  ],
                },
              ],
            },
          },
        ],
      });
    }
    if (path === "/v1/reviewSubmissions") {
      return Promise.resolve({
        data: drafts.map(({ id }) => ({ type: "reviewSubmissions", id })),
      });
    }
    const draft = drafts.find(
      ({ id }) => path === `/v1/reviewSubmissions/${id}/items`,
    );
    if (draft) return Promise.resolve({ data: draft.items });
    return baseGet?.(path, query as AscQuery) as never;
  });
  const basePost = vi.mocked(base.client.post).getMockImplementation();
  const post = vi.fn((path: string, body: unknown) => {
    if (path === "/v1/appEvents") {
      const { data } = body as { data: { attributes: object } };
      return Promise.resolve({
        data: {
          type: "appEvents",
          id: "E2",
          attributes: { ...data.attributes, eventState: "DRAFT" },
        },
      });
    }
    if (path === "/v1/appEventLocalizations") {
      const { data } = body as { data: { attributes: object } };
      return Promise.resolve({
        data: {
          type: "appEventLocalizations",
          id: "EL9",
          attributes: data.attributes,
        },
      });
    }
    if (path === "/v1/reviewSubmissions") {
      return Promise.resolve({
        data: { type: "reviewSubmissions", id: "RS9" },
      });
    }
    if (path === "/v1/reviewSubmissionItems") {
      return Promise.resolve({
        data: { type: "reviewSubmissionItems", id: "RI1" },
      });
    }
    return basePost?.(path, body) as never;
  });
  const patch = vi.fn((path: string, body: unknown) => {
    if (path.startsWith("/v1/reviewSubmissions/")) {
      return Promise.resolve({
        data: {
          type: "reviewSubmissions",
          id: path.split("/").pop(),
          attributes: { state: "WAITING_FOR_REVIEW" },
        },
      });
    }
    if (path === "/v1/appEventLocalizations/EL1") {
      const { data } = body as { data: { attributes: object } };
      return Promise.resolve({
        data: {
          ...localization,
          attributes: { ...localization.attributes, ...data.attributes },
        },
      });
    }
    return Promise.resolve({ data: {} });
  });
  const client: AscClient = {
    ...base.client,
    get: get as AscClient["get"],
    post: post as AscClient["post"],
    patch: patch as AscClient["patch"],
  };
  return { client, provider: vi.fn<AscClientProvider>(() => client) };
}

const EVENT_E1 = {
  id: "E1",
  referenceName: "Winter challenge",
  badge: "CHALLENGE",
  state: "DRAFT",
  priority: "NORMAL",
  purpose: "KEEP_ACTIVE_USERS_INFORMED",
  purchaseRequirement: "NO_COST_ASSOCIATED",
  primaryLocale: "en-US",
  deepLink: null,
  territorySchedules: [
    {
      territories: ["USA", "GBR"],
      publishStart: "2026-12-01T00:00:00Z",
      eventStart: "2026-12-05T00:00:00Z",
      eventEnd: "2026-12-20T00:00:00Z",
    },
  ],
};

describe("events", () => {
  it("should list an app's events with their schedules, filtered by state", async () => {
    const { client, provider } = eventsClient();
    const result = await run(
      ["events", "123", "--state", "DRAFT,PUBLISHED"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/123/appEvents",
      expect.objectContaining({
        "filter[eventState]": ["DRAFT", "PUBLISHED"],
        limit: 50,
      }),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      events: [EVENT_E1],
      total: 4,
      hasMore: false,
    });
  });

  it("should reject an unknown state", async () => {
    const { client, provider } = eventsClient();
    const result = await run(["events", "123", "--state", "LIVE"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("should show an event's localizations and their event images", async () => {
    const { client, provider } = eventsClient({ cardPlaced: true });
    const result = await run(["events", "show", "E1"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/appEventLocalizations/EL1/placements",
      expect.objectContaining({
        "filter[placementType]": [
          "EVENT_CARD_ASSET",
          "EVENT_DETAILS_PAGE_ASSET",
        ],
      }),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      event: EVENT_E1,
      localizations: [
        {
          id: "EL1",
          locale: "en-US",
          name: "Winter challenge",
          shortDescription: "Beat the cold",
          longDescription: null,
          placements: [
            {
              id: "EP1",
              placementType: "EVENT_CARD_ASSET",
              placementGroup: EVENT_CARD,
              state: "PARENT_PREPARE_FOR_SUBMISSION",
              fileName: "card.png",
              assetState: "PREPARE_FOR_SUBMISSION",
            },
          ],
        },
      ],
    });
  });
});

describe("events create", () => {
  const args = [
    "events",
    "create",
    "123",
    "--reference-name",
    "Spring sprint",
    "--locale",
    "en-US",
    "--name",
    "Spring sprint",
    "--short-description",
    "Run every day",
    "--badge",
    "CHALLENGE",
    "--territories",
    "USA,GBR",
    "--event-start",
    "2027-03-01T00:00:00Z",
    "--event-end",
    "2027-03-31T00:00:00Z",
  ];

  it("should show the event and how many the app has without --yes", async () => {
    const { client, provider } = eventsClient();
    const result = await run(args, provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(result.stderr).toContain("Dry run");
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      dryRun: true,
      action: "create",
      appId: "123",
      event: {
        referenceName: "Spring sprint",
        primaryLocale: "en-US",
        badge: "CHALLENGE",
        territorySchedules: [
          {
            territories: ["USA", "GBR"],
            eventStart: "2027-03-01T00:00:00Z",
            eventEnd: "2027-03-31T00:00:00Z",
          },
        ],
      },
      localization: {
        locale: "en-US",
        name: "Spring sprint",
        shortDescription: "Run every day",
      },
      existingEvents: 4,
    });
  });

  it("should create the event and its primary locale with --yes", async () => {
    const { client, provider } = eventsClient();
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/appEvents", {
      data: {
        type: "appEvents",
        attributes: {
          referenceName: "Spring sprint",
          primaryLocale: "en-US",
          badge: "CHALLENGE",
          territorySchedules: [
            {
              territories: ["USA", "GBR"],
              eventStart: "2027-03-01T00:00:00Z",
              eventEnd: "2027-03-31T00:00:00Z",
            },
          ],
        },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
    expect(client.post).toHaveBeenCalledWith("/v1/appEventLocalizations", {
      data: {
        type: "appEventLocalizations",
        attributes: {
          locale: "en-US",
          name: "Spring sprint",
          shortDescription: "Run every day",
        },
        relationships: {
          appEvent: { data: { type: "appEvents", id: "E2" } },
        },
      },
    });
    const output = JSON.parse(result.stdout);
    expect(output.event).toMatchObject({ id: "E2", state: "DRAFT" });
    expect(output.localization).toMatchObject({ id: "EL9", locale: "en-US" });
  });

  it("should say the event was created when its locale fails", async () => {
    const { client, provider } = eventsClient();
    const post = vi.mocked(client.post);
    const create = post.getMockImplementation();
    post.mockImplementation((path, body) =>
      path === "/v1/appEventLocalizations"
        ? Promise.reject(new AscApiError(409, {}))
        : (create?.(path, body) as never),
    );
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "In-app event E2 was created but its en-US name and descriptions were not saved",
    );
  });

  it("should need a reference name, a locale, and valid territories and dates", async () => {
    const { client, provider } = eventsClient();
    for (const extra of [
      ["--locale", "en-US"],
      ["--reference-name", "X"],
      ["--reference-name", "X", "--locale", "en-US", "--territories", "us"],
      ["--reference-name", "X", "--locale", "en-US", "--event-start", "soon"],
    ]) {
      const result = await run(["events", "create", "123", ...extra], provider);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[invalid_input]");
    }
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("events set", () => {
  it("should show the current and new values without --yes", async () => {
    const { client, provider } = eventsClient();
    const result = await run(
      [
        "events",
        "set",
        "E1",
        "--locale",
        "en-US",
        "--long-description",
        "Long",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "set",
      event: EVENT_E1,
      locale: "en-US",
      newLocale: false,
      current: { longDescription: null },
      update: { longDescription: "Long" },
      changes: true,
    });
  });

  it("should update only the changed fields with --yes", async () => {
    const { client, provider } = eventsClient();
    const result = await run(
      [
        "events",
        "set",
        "E1",
        "--locale",
        "en-US",
        "--name",
        "Winter challenge",
        "--long-description",
        "Long",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/appEventLocalizations/EL1", {
      data: {
        type: "appEventLocalizations",
        id: "EL1",
        attributes: { longDescription: "Long" },
      },
    });
    expect(JSON.parse(result.stdout).changed).toEqual(["longDescription"]);
  });

  it("should add a locale the event does not have with --yes", async () => {
    const { client, provider } = eventsClient();
    const result = await run(
      ["events", "set", "E1", "--locale", "ja", "--name", "冬", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/appEventLocalizations", {
      data: {
        type: "appEventLocalizations",
        attributes: { locale: "ja", name: "冬" },
        relationships: {
          appEvent: { data: { type: "appEvents", id: "E1" } },
        },
      },
    });
  });

  it("should refuse an event in review", async () => {
    const { client, provider } = eventsClient({ state: "IN_REVIEW" });
    const result = await run(
      ["events", "set", "E1", "--locale", "en-US", "--name", "X", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[invalid_input] In-app event Winter challenge is IN_REVIEW",
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should need a field to change", async () => {
    const { provider } = eventsClient();
    const result = await run(
      ["events", "set", "E1", "--locale", "en-US"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Give --name");
  });
});

describe("events upload", () => {
  async function folder(files: string[]) {
    const dir = await mkdtemp(join(tmpdir(), "asc-events-"));
    await mkdir(join(dir, "en-US"));
    for (const file of files) {
      await writeFile(
        join(dir, "en-US", file),
        file.endsWith(".png") ? png(1920, 1080) : "video",
      );
    }
    return dir;
  }

  it("should place each file by the type and group in its name with --yes", async () => {
    const { client, provider } = eventsClient();
    const dir = await folder([
      "EVENT_CARD_ASSET.png",
      "EVENT_DETAILS_PAGE_ASSET-EVENT_DETAILS_IPHONE.mp4",
    ]);
    const dry = await run(
      ["events", "upload", "123", "E1", "--dir", dir],
      provider,
    );
    expect(dry.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(dry.stdout).files).toEqual([
      {
        locale: "en-US",
        file: "EVENT_CARD_ASSET.png",
        placementType: "EVENT_CARD_ASSET",
        placementGroup: EVENT_CARD,
        fileSize: 33,
      },
      {
        locale: "en-US",
        file: "EVENT_DETAILS_PAGE_ASSET-EVENT_DETAILS_IPHONE.mp4",
        placementType: "EVENT_DETAILS_PAGE_ASSET",
        placementGroup: "EVENT_DETAILS_IPHONE",
        fileSize: 5,
      },
    ]);
    vi.mocked(console.log).mockClear();
    const result = await run(
      ["events", "upload", "123", "E1", "--dir", dir, "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/appAssetLibraryImages", {
      data: {
        type: "appAssetLibraryImages",
        attributes: {
          fileName: "EVENT_CARD_ASSET.png",
          fileSize: 33,
          category: "CREATIVE_ASSETS",
        },
        relationships: {
          assetLibrary: { data: { type: "appAssetLibraries", id: "L1" } },
        },
      },
    });
    expect(client.post).toHaveBeenCalledWith("/v1/appAssetLibraryPlacements", {
      data: {
        type: "appAssetLibraryPlacements",
        attributes: {
          placementType: "EVENT_DETAILS_PAGE_ASSET",
          placementGroup: "EVENT_DETAILS_IPHONE",
        },
        relationships: {
          video: { data: { type: "appAssetLibraryVideos", id: "A2" } },
          appEventLocalization: {
            data: { type: "appEventLocalizations", id: "EL1" },
          },
        },
      },
    });
  });

  it("should place a file without a group when Apple lists none for its type", async () => {
    const { client, provider } = eventsClient();
    const eventsGet = vi.mocked(client.get).getMockImplementation();
    vi.mocked(client.get).mockImplementation((path, query) =>
      path === "/v1/appAssetLibraryRefData"
        ? (Promise.resolve({
            data: [
              {
                type: "appAssetLibraryRefData",
                id: "1",
                attributes: {
                  imageSpecs: [],
                  placementTypes: [
                    { placementTypeId: "EVENT_CARD_ASSET", specMappings: [] },
                  ],
                },
              },
            ],
          }) as never)
        : (eventsGet?.(path, query) as never),
    );
    const result = await run(
      [
        "events",
        "upload",
        "123",
        "E1",
        "--dir",
        await folder(["EVENT_CARD_ASSET.png", "EVENT_CARD_ASSET.mp4"]),
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/appAssetLibraryPlacements", {
      data: {
        type: "appAssetLibraryPlacements",
        attributes: { placementType: "EVENT_CARD_ASSET" },
        relationships: {
          image: { data: { type: "appAssetLibraryImages", id: "A2" } },
          appEventLocalization: {
            data: { type: "appEventLocalizations", id: "EL1" },
          },
        },
      },
    });
  });

  it("should stop before writing on a file it cannot place", async () => {
    const cases: [string, string][] = [
      ["card.png", "EVENT_CARD_ASSET or EVENT_DETAILS_PAGE_ASSET"],
      [
        "EVENT_DETAILS_PAGE_ASSET.mp4",
        "EVENT_DETAILS_IPHONE, EVENT_DETAILS_IPAD",
      ],
    ];
    for (const [file, message] of cases) {
      const { client, provider } = eventsClient();
      const result = await run(
        [
          "events",
          "upload",
          "123",
          "E1",
          "--dir",
          await folder([file]),
          "--yes",
        ],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
      expect(client.post).not.toHaveBeenCalled();
    }
  });

  it("should stop when the event already has its one card", async () => {
    const { client, provider } = eventsClient({ cardPlaced: true });
    const result = await run(
      [
        "events",
        "upload",
        "123",
        "E1",
        "--dir",
        await folder(["EVENT_CARD_ASSET.png"]),
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("limit of 1");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should report an event that is not the app's", async () => {
    const { client, provider } = eventsClient();
    const result = await run(
      ["events", "upload", "123", "E7", "--dir", "/nonexistent", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[not_found] App 123 has no in-app event E7",
    );
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("events submit", () => {
  it("should show the event, submission and events past review without --yes", async () => {
    const { client, provider } = eventsClient();
    const result = await run(["events", "submit", "123", "E1"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/123/appEvents",
      expect.objectContaining({
        "filter[eventState]": ["ACCEPTED", "APPROVED", "PUBLISHED"],
      }),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "submit",
      event: EVENT_E1,
      platform: "IOS",
      reviewSubmissionId: null,
      eventsPastReview: 4,
    });
  });

  it("should add the event to a new submission and submit it with --yes", async () => {
    const { client, provider } = eventsClient();
    const result = await run(
      ["events", "submit", "123", "E1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: "RS9" } },
          appEvent: { data: { type: "appEvents", id: "E1" } },
        },
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "submit",
      eventId: "E1",
      reviewSubmissionId: "RS9",
      state: "WAITING_FOR_REVIEW",
    });
  });

  it("should explain a refused submission, such as Apple's limit on events", async () => {
    const { client, provider } = eventsClient();
    vi.mocked(client.patch).mockRejectedValue(
      new AscApiError(409, {
        errors: [{ code: "STATE_ERROR", detail: "Too many events." }],
      }),
    );
    const result = await run(
      ["events", "submit", "123", "E1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("Apple's limit of events at once");
    expect(result.stderr).toContain("Too many events.");
  });

  it("should refuse an event that is already published", async () => {
    const { client, provider } = eventsClient({ state: "PUBLISHED" });
    const result = await run(
      ["events", "submit", "123", "E1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is PUBLISHED, so it cannot be submitted");
    expect(client.post).not.toHaveBeenCalled();
  });
});

/** A client answering the pricing, availability and age rating reads. */
function storeClient({
  appInfoState = "PREPARE_FOR_SUBMISSION",
  failPatchAt = -1,
}: {
  appInfoState?: string;
  failPatchAt?: number;
} = {}) {
  const price = (
    id: string,
    territory: string,
    startDate: string | null,
    endDate: string | null,
  ) => ({
    type: "appPrices",
    id,
    attributes: { manual: true, startDate, endDate },
    relationships: {
      appPricePoint: { data: { type: "appPricePoints", id: `P-${id}` } },
      territory: { data: { type: "territories", id: territory } },
    },
  });
  const point = (id: string, customerPrice: string, proceeds: string) => ({
    type: "appPricePoints",
    id: `P-${id}`,
    attributes: { customerPrice, proceeds },
  });
  const territory = (id: string, currency: string) => ({
    type: "territories",
    id,
    attributes: { currency },
  });
  const availability = (id: string, code: string, available: boolean) => ({
    type: "territoryAvailabilities",
    id,
    attributes: {
      available,
      releaseDate: null,
      preOrderEnabled: false,
      preOrderPublishDate: null,
      contentStatuses: available ? ["AVAILABLE"] : ["CANNOT_SELL"],
    },
    relationships: { territory: { data: { type: "territories", id: code } } },
  });
  const get = vi.fn((path: string, query: Record<string, unknown> = {}) => {
    switch (path) {
      case "/v1/apps/123/appPriceSchedule":
        return Promise.resolve({
          data: {
            type: "appPriceSchedules",
            id: "S1",
            relationships: {
              baseTerritory: { data: { type: "territories", id: "USA" } },
            },
          },
          included: [territory("USA", "USD")],
        });
      case "/v1/appPriceSchedules/S1/manualPrices":
        return Promise.resolve({
          data: [
            price("M1", "USA", null, "2027-01-01"),
            price("M2", "USA", "2027-01-01", null),
          ],
          included: [
            point("M1", "0.99", "0.84"),
            point("M2", "1.99", "1.69"),
            territory("USA", "USD"),
          ],
          links: { self: "x" },
        });
      case "/v1/appPriceSchedules/S1/automaticPrices":
        // Two pages, to check the cursor is followed.
        return Promise.resolve(
          query.cursor === undefined
            ? {
                data: [price("A1", "JPN", null, null)],
                included: [point("A1", "160", "136"), territory("JPN", "JPY")],
                links: {
                  self: "x",
                  next: "https://api.appstoreconnect.apple.com/v1/appPriceSchedules/S1/automaticPrices?cursor=NEXT",
                },
              }
            : {
                data: [price("A2", "GBR", null, null)],
                included: [
                  point("A2", "0.99", "0.70"),
                  territory("GBR", "GBP"),
                ],
                links: { self: "x" },
              },
        );
      case "/v1/apps/123/appAvailabilityV2":
        return Promise.resolve({
          data: {
            type: "appAvailabilities",
            id: "AV1",
            attributes: { availableInNewTerritories: true },
          },
        });
      case "/v2/appAvailabilities/AV1/territoryAvailabilities":
        return Promise.resolve({
          data: [
            availability("TA1", "USA", true),
            availability("TA2", "GBR", false),
            availability("TA3", "JPN", false),
          ],
          links: { self: "x" },
        });
      case "/v1/apps/123/appInfos":
        return Promise.resolve({
          data: [
            {
              type: "appInfos",
              id: "AI1",
              attributes: {
                state: "PREPARE_FOR_SUBMISSION",
                appStoreAgeRating: "FOUR_PLUS",
              },
            },
          ],
        });
      case "/v1/appInfos/AI1":
        return Promise.resolve({
          data: {
            type: "appInfos",
            id: "AI1",
            attributes: { state: appInfoState },
          },
        });
      case "/v1/appInfos/AI1/ageRatingDeclaration":
        return Promise.resolve({
          data: {
            type: "ageRatingDeclarations",
            id: "D1",
            attributes: {
              gambling: false,
              violenceRealistic: "NONE",
              lootBox: null,
              kidsAgeBand: null,
            },
          },
        });
      default:
        return Promise.reject(new Error(`unexpected GET ${path}`));
    }
  });
  let patches = 0;
  const client: AscClient = {
    ...noWrites(),
    get: get as AscClient["get"],
    patch: vi.fn(() =>
      patches++ === failPatchAt
        ? Promise.reject(new AscApiError(409, { errors: [] }))
        : Promise.resolve({ data: {} }),
    ) as AscClient["patch"],
  };
  return { client, provider: vi.fn<AscClientProvider>(() => client) };
}

describe("pricing", () => {
  it("should print the base territory and the manual and automatic prices", async () => {
    const { client, provider } = storeClient();
    const result = await run(["pricing", "123"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/123/appPriceSchedule",
      expect.objectContaining({ include: ["baseTerritory"] }),
    );
    expect(client.get).toHaveBeenCalledWith(
      "/v1/appPriceSchedules/S1/automaticPrices",
      expect.objectContaining({ cursor: "NEXT" }),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      appId: "123",
      baseTerritory: { id: "USA", currency: "USD" },
      manualPrices: [
        {
          territory: "USA",
          currency: "USD",
          customerPrice: "0.99",
          proceeds: "0.84",
          startDate: null,
          endDate: "2027-01-01",
        },
        {
          territory: "USA",
          currency: "USD",
          customerPrice: "1.99",
          proceeds: "1.69",
          startDate: "2027-01-01",
          endDate: null,
        },
      ],
      automaticPrices: [
        {
          territory: "JPN",
          currency: "JPY",
          customerPrice: "160",
          proceeds: "136",
          startDate: null,
          endDate: null,
        },
        {
          territory: "GBR",
          currency: "GBP",
          customerPrice: "0.99",
          proceeds: "0.70",
          startDate: null,
          endDate: null,
        },
      ],
    });
  });

  it("should filter by territory and reject a bad code", async () => {
    const { client, provider } = storeClient();
    const ok = await run(["pricing", "123", "--territory", "jpn"], provider);
    expect(ok.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/appPriceSchedules/S1/manualPrices",
      expect.objectContaining({ "filter[territory]": ["JPN"] }),
    );
    const bad = await run(["pricing", "123", "--territory", "US"], provider);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("[invalid_input]");
  });
});

describe("availability", () => {
  it("should print each territory and those the app is missing from", async () => {
    const { provider } = storeClient();
    const result = await run(["availability", "123"], provider);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      appId: "123",
      availableInNewTerritories: true,
      availableCount: 1,
      unavailable: ["GBR", "JPN"],
    });
    expect(output.territories[0]).toEqual({
      territory: "USA",
      available: true,
      releaseDate: null,
      preOrderEnabled: false,
      preOrderPublishDate: null,
      contentStatuses: ["AVAILABLE"],
    });
  });
});

describe("availability set", () => {
  it("should show each territory's current availability without --yes", async () => {
    const { client, provider } = storeClient();
    const result = await run(
      ["availability", "set", "123", "--territory", "usa,GBR", "--available"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Dry run");
    expect(client.patch).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "add-territories",
      appId: "123",
      territories: [
        {
          territory: "USA",
          available: true,
          contentStatuses: ["AVAILABLE"],
          changes: false,
        },
        {
          territory: "GBR",
          available: false,
          contentStatuses: ["CANNOT_SELL"],
          changes: true,
        },
      ],
    });
  });

  it("should change only the territories that differ with --yes", async () => {
    const { client, provider } = storeClient();
    const result = await run(
      [
        "availability",
        "set",
        "123",
        "--territory",
        "USA,GBR",
        "--territory",
        "JPN",
        "--available",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledTimes(2);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/territoryAvailabilities/TA2",
      {
        data: {
          type: "territoryAvailabilities",
          id: "TA2",
          attributes: { available: true },
        },
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "add-territories",
      appId: "123",
      changed: ["GBR", "JPN"],
    });
  });

  it("should name the territories already changed when one fails", async () => {
    const { provider } = storeClient({ failPatchAt: 1 });
    const result = await run(
      [
        "availability",
        "set",
        "123",
        "--territory",
        "GBR,JPN",
        "--available",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[invalid_input] App Store Connect would not change availability in JPN",
    );
    expect(result.stderr).toContain("Already changed: GBR.");
  });

  it("should report a partway failure Apple did not reject as a conflict", async () => {
    const { client, provider } = storeClient();
    vi.mocked(client.patch)
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new AscApiError(503, undefined));
    const result = await run(
      [
        "availability",
        "set",
        "123",
        "--territory",
        "GBR,JPN",
        "--available",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[unavailable]");
    expect(result.stderr).toContain(
      "Changing availability stopped partway. Already changed: GBR.",
    );
  });

  it("should remove territories with --no-available", async () => {
    const { client, provider } = storeClient();
    const result = await run(
      [
        "availability",
        "set",
        "123",
        "--territory",
        "USA",
        "--no-available",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/territoryAvailabilities/TA1",
      {
        data: {
          type: "territoryAvailabilities",
          id: "TA1",
          attributes: { available: false },
        },
      },
    );
  });

  it("should refuse a territory the app has no entry for, or a missing choice", async () => {
    const { client, provider } = storeClient();
    const unknown = await run(
      ["availability", "set", "123", "--territory", "FRA", "--available"],
      provider,
    );
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain(
      "[not_found] App 123 has no availability entry for FRA",
    );
    const noChoice = await run(
      ["availability", "set", "123", "--territory", "USA"],
      provider,
    );
    expect(noChoice.exitCode).toBe(1);
    expect(noChoice.stderr).toContain("--no-available");
    const noTerritory = await run(
      ["availability", "set", "123", "--available"],
      provider,
    );
    expect(noTerritory.exitCode).toBe(1);
    expect(noTerritory.stderr).toContain("--territory");
    expect(client.patch).not.toHaveBeenCalled();
  });
});

describe("age-rating", () => {
  it("should print each app info's declaration with every answer", async () => {
    const { client, provider } = storeClient();
    const result = await run(["age-rating", "123"], provider);
    expect(result.exitCode).toBe(0);
    // No field list, so new questions from Apple come through.
    expect(client.get).toHaveBeenCalledWith(
      "/v1/appInfos/AI1/ageRatingDeclaration",
    );
    expect(JSON.parse(result.stdout)).toEqual({
      appInfos: [
        {
          id: "AI1",
          state: "PREPARE_FOR_SUBMISSION",
          appStoreAgeRating: "FOUR_PLUS",
          declaration: {
            id: "D1",
            answers: {
              gambling: false,
              violenceRealistic: "NONE",
              lootBox: null,
              kidsAgeBand: null,
            },
          },
        },
      ],
    });
  });
});

describe("age-rating set", () => {
  const args = [
    "age-rating",
    "set",
    "AI1",
    "--answer",
    "gambling=false",
    "--answer",
    "violenceRealistic=INFREQUENT",
    "--answer",
    "lootBox=true",
  ];

  it("should show the current and new answers without --yes", async () => {
    const { client, provider } = storeClient();
    const result = await run(args, provider);
    expect(result.exitCode).toBe(0);
    expect(client.patch).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "age-rating",
      appInfo: { id: "AI1", state: "PREPARE_FOR_SUBMISSION" },
      declarationId: "D1",
      current: { gambling: false, violenceRealistic: "NONE", lootBox: null },
      update: {
        gambling: false,
        violenceRealistic: "INFREQUENT",
        lootBox: true,
      },
      changes: true,
    });
  });

  it("should send only the changed answers with --yes", async () => {
    const { client, provider } = storeClient();
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/ageRatingDeclarations/D1", {
      data: {
        type: "ageRatingDeclarations",
        id: "D1",
        attributes: { violenceRealistic: "INFREQUENT", lootBox: true },
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "age-rating",
      appInfoId: "AI1",
      declarationId: "D1",
      changed: ["violenceRealistic", "lootBox"],
    });
  });

  it("should name the answers Apple rejects", async () => {
    const { provider } = storeClient({ failPatchAt: 0 });
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[invalid_input] App Store Connect rejected the age rating answers violenceRealistic, lootBox",
    );
    expect(result.stderr).toContain("INFREQUENT_OR_MILD");
  });

  it("should refuse an app info that is no longer editable", async () => {
    const { client, provider } = storeClient({
      appInfoState: "READY_FOR_DISTRIBUTION",
    });
    const result = await run([...args, "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[invalid_input] App info AI1 is READY_FOR_DISTRIBUTION",
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should refuse a question the declaration does not have, and bad answers", async () => {
    const { client, provider } = storeClient();
    const unknown = await run(
      ["age-rating", "set", "AI1", "--answer", "horror=NONE"],
      provider,
    );
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain(
      "[invalid_input] The age rating declaration has no question named horror",
    );
    const malformed = await run(
      ["age-rating", "set", "AI1", "--answer", "gambling"],
      provider,
    );
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain("name=value");
    const twice = await run(
      [
        "age-rating",
        "set",
        "AI1",
        "--answer",
        "gambling=true",
        "--answer",
        "gambling=false",
      ],
      provider,
    );
    expect(twice.exitCode).toBe(1);
    expect(twice.stderr).toContain("Give each answer once.");
    const none = await run(["age-rating", "set", "AI1"], provider);
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain("--answer");
    expect(client.patch).not.toHaveBeenCalled();
  });
});
