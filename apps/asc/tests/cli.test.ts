import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";
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
async function run(args: string[], provider: AscClientProvider) {
  let stderr = "";
  const program = createProgram(provider);
  // Subcommands inherit both settings when they are created, so set them on each.
  for (const command of [program, ...program.commands]) {
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
    });
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
