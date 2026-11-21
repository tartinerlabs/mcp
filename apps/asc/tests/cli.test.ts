import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import {
  type AscClientProvider,
  createProgram,
  type ProgramOptions,
} from "../src/cli.ts";
import { AscApiError, CredentialsError } from "../src/utils/errors.ts";

/** A spied provider and client whose `get` resolves the given body. */
function respond(body: unknown) {
  const client: AscClient = {
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
        "fields[builds]": expect.arrayContaining(["preReleaseVersion"]),
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
])("%s --cursor", (command, args, path) => {
  it("should pass the cursor through and print the next one", async () => {
    const { client, provider } = respond({
      data: [],
      links: {
        self: "x",
        next: `https://api.appstoreconnect.apple.com${path}?cursor=NEXT`,
      },
    });
    const result = await run([command, ...args, "--cursor", "AB"], provider);
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
