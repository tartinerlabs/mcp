import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import {
  type AscClientProvider,
  createProgram,
  type ProgramOptions,
} from "../src/cli.ts";
import { AscApiError, CredentialsError } from "../src/utils/errors.ts";

/** Write methods for read-only tests: any call fails the test. */
function noWrites(): Pick<AscClient, "post" | "patch" | "delete"> {
  const fail = () => Promise.reject(new Error("unexpected write"));
  return {
    post: vi.fn(fail) as AscClient["post"],
    patch: vi.fn(fail) as AscClient["patch"],
    delete: vi.fn(fail) as AscClient["delete"],
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
