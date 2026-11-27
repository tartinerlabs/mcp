import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";

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
  return { exitCode, stdout, stderr };
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
  phasedState?: string | null;
  submissions?: {
    id: string;
    state: string;
    version?: string;
    items?: string[];
  }[];
  drafts?: { id: string; items: string[] }[];
  ageRating?: Record<string, unknown>;
  accessibility?: Record<string, unknown>[];
  reviewDetail?: Record<string, unknown> | null;
  otherBuild?: { app?: string; platform?: string; processingState?: string };
}

/** A client answering the release commands' reads for version V1 of app 123. */
function releaseClient({
  state = "PREPARE_FOR_SUBMISSION",
  build = {
    version: "42",
    processingState: "VALID",
    expired: false,
    usesNonExemptEncryption: false,
  },
  phasedState = null,
  submissions = [],
  drafts = [],
  ageRating = { gambling: false, kidsAgeBand: null },
  accessibility = [],
  reviewDetail = {
    contactFirstName: "Ada",
    contactLastName: "Lovelace",
    contactPhone: "+44 20 7946 0000",
    contactEmail: "ada@example.com",
    demoAccountRequired: false,
  },
  otherBuild = {},
}: Setup = {}) {
  const get = vi.fn((path: string, query: Record<string, unknown> = {}) => {
    if (path === "/v1/appStoreVersions/V1") {
      const included = [];
      if (build) included.push({ type: "builds", id: "B1", attributes: build });
      if (phasedState) {
        included.push({
          type: "appStoreVersionPhasedReleases",
          id: "PR1",
          attributes: { phasedReleaseState: phasedState, currentDayNumber: 3 },
        });
      }
      return Promise.resolve({
        data: {
          type: "appStoreVersions",
          id: "V1",
          attributes: {
            platform: "IOS",
            versionString: "2.0",
            appVersionState: state,
            releaseType: "MANUAL",
          },
          relationships: {
            app: { data: { type: "apps", id: "123" } },
            build: { data: build ? { type: "builds", id: "B1" } : null },
            appStoreVersionPhasedRelease: {
              data: phasedState
                ? { type: "appStoreVersionPhasedReleases", id: "PR1" }
                : null,
            },
          },
        },
        included,
      });
    }
    if (path === "/v1/builds/B2") {
      return Promise.resolve({
        data: {
          type: "builds",
          id: "B2",
          attributes: {
            version: "43",
            processingState: otherBuild.processingState ?? "VALID",
            expired: false,
            usesNonExemptEncryption: null,
          },
          relationships: {
            app: { data: { type: "apps", id: otherBuild.app ?? "123" } },
            preReleaseVersion: {
              data: { type: "preReleaseVersions", id: "P" },
            },
          },
        },
        included: [
          {
            type: "preReleaseVersions",
            id: "P",
            attributes: {
              version: "2.0",
              platform: otherBuild.platform ?? "IOS",
            },
          },
        ],
      });
    }
    if (path === "/v1/reviewSubmissions") {
      const ready = query["filter[state]"] === "READY_FOR_REVIEW";
      const data = ready
        ? drafts.map((draft) => ({
            type: "reviewSubmissions",
            id: draft.id,
            attributes: { state: "READY_FOR_REVIEW" },
          }))
        : submissions.map((submission) => ({
            type: "reviewSubmissions",
            id: submission.id,
            attributes: {
              state: submission.state,
              submittedDate: "2026-11-01",
            },
            relationships: {
              appStoreVersionForReview: {
                data: {
                  type: "appStoreVersions",
                  id: submission.version ?? "V1",
                },
              },
            },
          }));
      return Promise.resolve({ data, links });
    }
    const items = /^\/v1\/reviewSubmissions\/(\w+)\/items$/.exec(path);
    if (items) {
      const ids =
        [...drafts, ...submissions].find((entry) => entry.id === items[1])
          ?.items ?? [];
      return Promise.resolve({
        data: ids.map((id, index) => ({
          type: "reviewSubmissionItems",
          id: `I${index}`,
          relationships: id.startsWith("V")
            ? { appStoreVersion: { data: { type: "appStoreVersions", id } } }
            : { appEvent: { data: { type: "appEvents", id } } },
        })),
        links,
      });
    }
    if (path === "/v1/apps/123/appInfos") {
      return Promise.resolve({
        data: [
          {
            type: "appInfos",
            id: "AI1",
            attributes: { state: "READY_FOR_DISTRIBUTION" },
          },
          {
            type: "appInfos",
            id: "AI2",
            attributes: { state: "PREPARE_FOR_SUBMISSION" },
          },
        ],
        links,
      });
    }
    if (path === "/v1/appInfos/AI2/ageRatingDeclaration") {
      return Promise.resolve({
        data: {
          type: "ageRatingDeclarations",
          id: "AR2",
          attributes: ageRating,
        },
      });
    }
    if (path === "/v1/appStoreVersions/V1/appStoreReviewDetail") {
      return Promise.resolve({
        data: reviewDetail && {
          type: "appStoreReviewDetails",
          id: "RD1",
          attributes: reviewDetail,
        },
      });
    }
    if (path === "/v1/apps/123/accessibilityDeclarations") {
      return Promise.resolve({
        data: accessibility.map((attributes, index) => ({
          type: "accessibilityDeclarations",
          id: `AD${index}`,
          attributes,
        })),
        links,
      });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  const client: AscClient = {
    get: get as AscClient["get"],
    post: vi.fn((path: string) =>
      Promise.resolve(
        path === "/v1/reviewSubmissions"
          ? { data: { type: "reviewSubmissions", id: "RS9" } }
          : undefined,
      ),
    ) as AscClient["post"],
    patch: vi.fn((path: string) =>
      Promise.resolve(
        path.startsWith("/v1/reviewSubmissions/")
          ? {
              data: {
                type: "reviewSubmissions",
                id: "RS9",
                attributes: {
                  state: path.endsWith("RS1")
                    ? "CANCELING"
                    : "WAITING_FOR_REVIEW",
                },
              },
            }
          : undefined,
      ),
    ) as AscClient["patch"],
    delete: vi.fn(() => Promise.reject(new Error("unexpected delete"))),
    upload: vi.fn(() => Promise.reject(new Error("unexpected upload"))),
    download: vi.fn(() => Promise.reject(new Error("unexpected download"))),
    downloadSigned: vi.fn(() =>
      Promise.reject(new Error("unexpected download")),
    ),
  };
  const provider = vi.fn<AscClientProvider>(() => client);
  return { client, provider };
}

function noWrites(client: AscClient) {
  expect(client.post).not.toHaveBeenCalled();
  expect(client.patch).not.toHaveBeenCalled();
}

describe("versions attach-build", () => {
  it("should only show the current and new build without --yes", async () => {
    const { client, provider } = releaseClient();
    const result = await run(
      ["versions", "attach-build", "V1", "B2"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    noWrites(client);
    expect(result.stderr).toContain("Dry run");
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: "attach-build",
        appId: "123",
        versionId: "V1",
        version: "2.0",
        currentBuild: expect.objectContaining({ id: "B1", version: "42" }),
        build: expect.objectContaining({ id: "B2", version: "43" }),
        changes: true,
      }),
    );
  });

  it("should attach the build with --yes", async () => {
    const { client, provider } = releaseClient();
    const result = await run(
      ["versions", "attach-build", "V1", "B2", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appStoreVersions/V1/relationships/build",
      { data: { type: "builds", id: "B2" } },
    );
  });

  it.each([
    [{ app: "999" }, "belongs to app 999"],
    [{ platform: "MAC_OS" }, "is for MAC_OS"],
    [{ processingState: "PROCESSING" }, "is PROCESSING"],
  ])("should refuse build %o", async (otherBuild, message) => {
    const { client, provider } = releaseClient({ otherBuild });
    const result = await run(
      ["versions", "attach-build", "V1", "B2", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain(message);
    noWrites(client);
  });

  it("should refuse a version that is no longer editable", async () => {
    const { client, provider } = releaseClient({ state: "IN_REVIEW" });
    const result = await run(
      ["versions", "attach-build", "V1", "B2", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is IN_REVIEW");
    noWrites(client);
  });
});

describe("versions submit", () => {
  it("should only show the version and submission without --yes", async () => {
    const { client, provider } = releaseClient();
    const result = await run(["versions", "submit", "V1"], provider);
    expect(result.exitCode).toBe(0);
    noWrites(client);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: "submit",
        appId: "123",
        versionId: "V1",
        version: "2.0",
        platform: "IOS",
        reviewSubmissionId: null,
      }),
    );
  });

  it("should create a submission, add the version and submit it with --yes", async () => {
    const { client, provider } = releaseClient();
    const result = await run(["versions", "submit", "V1", "--yes"], provider);
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
          appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } },
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
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        dryRun: false,
        reviewSubmissionId: "RS9",
        state: "WAITING_FOR_REVIEW",
      }),
    );
  });

  it("should refuse when the draft submission holds other items", async () => {
    const { client, provider } = releaseClient({
      drafts: [{ id: "RS5", items: ["E1"] }],
    });
    const result = await run(["versions", "submit", "V1", "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("1 other item(s)");
    noWrites(client);
  });

  it.each([
    [{ build: null }, "has no build"],
    [
      {
        build: {
          version: "42",
          processingState: "VALID",
          usesNonExemptEncryption: null,
        },
      },
      "export compliance",
    ],
    [{ state: "READY_FOR_DISTRIBUTION" }, "is READY_FOR_DISTRIBUTION"],
    [
      { submissions: [{ id: "RS1", state: "WAITING_FOR_REVIEW" }] },
      "already in review submission RS1",
    ],
    [
      { ageRating: { gambling: false, socialMedia: null, kidsAgeBand: null } },
      "socialMedia (app info AI2)",
    ],
    [
      {
        accessibility: [
          { state: "DRAFT", deviceFamily: "IPHONE", supportsVoiceover: null },
        ],
      },
      "supportsVoiceover (IPHONE)",
    ],
    [{ reviewDetail: null }, "leave contactFirstName, contactLastName"],
    [
      {
        reviewDetail: {
          contactFirstName: "Ada",
          contactLastName: "Lovelace",
          contactPhone: "+44 20 7946 0000",
          contactEmail: "ada@example.com",
          demoAccountRequired: true,
          demoAccountName: "demo",
        },
      },
      "leave demoAccountPassword blank",
    ],
  ] as [Setup, string][])("should refuse %o", async (setup, message) => {
    const { client, provider } = releaseClient(setup);
    const result = await run(["versions", "submit", "V1", "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
    noWrites(client);
  });

  it("should name the role when Apple refuses the write", async () => {
    const { client, provider } = releaseClient();
    vi.mocked(client.post).mockRejectedValue(new AscApiError(403, {}));
    const result = await run(["versions", "submit", "V1", "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[permission]");
    expect(result.stderr).toContain("Admin or App Manager role");
  });
});

describe("versions cancel-review", () => {
  it("should only show the submission without --yes", async () => {
    const { client, provider } = releaseClient({
      state: "WAITING_FOR_REVIEW",
      submissions: [{ id: "RS1", state: "WAITING_FOR_REVIEW", items: ["V1"] }],
    });
    const result = await run(["versions", "cancel-review", "V1"], provider);
    expect(result.exitCode).toBe(0);
    noWrites(client);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: "cancel-review",
        appId: "123",
        versionId: "V1",
        submission: expect.objectContaining({
          id: "RS1",
          state: "WAITING_FOR_REVIEW",
        }),
      }),
    );
  });

  it("should cancel the submission with --yes", async () => {
    const { client, provider } = releaseClient({
      state: "IN_REVIEW",
      submissions: [{ id: "RS1", state: "IN_REVIEW", items: ["V1"] }],
    });
    const result = await run(
      ["versions", "cancel-review", "V1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/reviewSubmissions/RS1", {
      data: {
        type: "reviewSubmissions",
        id: "RS1",
        attributes: { canceled: true },
      },
    });
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({ dryRun: false, submissionState: "CANCELING" }),
    );
  });

  it.each([
    [{ submissions: [] }, "[not_found]", "nothing to cancel"],
    [
      {
        submissions: [
          { id: "RS1", state: "WAITING_FOR_REVIEW", version: "V7" },
        ],
      },
      "[not_found]",
      "nothing to cancel",
    ],
    [
      { submissions: [{ id: "RS1", state: "UNRESOLVED_ISSUES" }] },
      "[invalid_input]",
      "can no longer be cancelled",
    ],
    [
      { submissions: [{ id: "RS1", state: "CANCELING" }] },
      "[invalid_input]",
      "already being cancelled",
    ],
    [
      {
        submissions: [
          { id: "RS1", state: "WAITING_FOR_REVIEW", items: ["V1", "E1"] },
        ],
      },
      "[invalid_input]",
      "1 other item(s)",
    ],
  ] as [Setup, string, string][])(
    "should refuse %o",
    async (setup, kind, message) => {
      const { client, provider } = releaseClient(setup);
      const result = await run(
        ["versions", "cancel-review", "V1", "--yes"],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(kind);
      expect(result.stderr).toContain(message);
      noWrites(client);
    },
  );
});

describe("versions release", () => {
  it("should only show the version without --yes", async () => {
    const { client, provider } = releaseClient({
      state: "PENDING_DEVELOPER_RELEASE",
    });
    const result = await run(["versions", "release", "V1"], provider);
    expect(result.exitCode).toBe(0);
    noWrites(client);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: "release",
        appId: "123",
        versionId: "V1",
      }),
    );
  });

  it("should request the release with --yes", async () => {
    const { client, provider } = releaseClient({
      state: "PENDING_DEVELOPER_RELEASE",
    });
    const result = await run(["versions", "release", "V1", "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith(
      "/v1/appStoreVersionReleaseRequests",
      {
        data: {
          type: "appStoreVersionReleaseRequests",
          relationships: {
            appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } },
          },
        },
      },
    );
  });

  it("should refuse a version that is not pending developer release", async () => {
    const { client, provider } = releaseClient({ state: "IN_REVIEW" });
    const result = await run(["versions", "release", "V1", "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "only a version that is PENDING_DEVELOPER_RELEASE",
    );
    noWrites(client);
  });
});

describe("versions phased-release", () => {
  it.each([
    ["pause", "ACTIVE", "PAUSED"],
    ["resume", "PAUSED", "ACTIVE"],
    ["complete", "PAUSED", "COMPLETE"],
  ])(
    "should %s a phased release that is %s with --yes",
    async (action, from, to) => {
      const { client, provider } = releaseClient({
        state: "READY_FOR_DISTRIBUTION",
        phasedState: from,
      });
      const result = await run(
        ["versions", "phased-release", "V1", action, "--yes"],
        provider,
      );
      expect(result.exitCode).toBe(0);
      expect(client.patch).toHaveBeenCalledWith(
        "/v1/appStoreVersionPhasedReleases/PR1",
        {
          data: {
            type: "appStoreVersionPhasedReleases",
            id: "PR1",
            attributes: { phasedReleaseState: to },
          },
        },
      );
    },
  );

  it("should only show the phased release without --yes", async () => {
    const { client, provider } = releaseClient({ phasedState: "ACTIVE" });
    const result = await run(
      ["versions", "phased-release", "V1", "pause"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    noWrites(client);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: "phased-release pause",
        newState: "PAUSED",
        phasedRelease: expect.objectContaining({
          id: "PR1",
          phasedReleaseState: "ACTIVE",
        }),
      }),
    );
  });

  it("should refuse an action the state does not allow", async () => {
    const { client, provider } = releaseClient({ phasedState: "PAUSED" });
    const result = await run(
      ["versions", "phased-release", "V1", "pause", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is PAUSED, so it cannot pause");
    noWrites(client);
  });

  it("should refuse a version without a phased release", async () => {
    const { client, provider } = releaseClient();
    const result = await run(
      ["versions", "phased-release", "V1", "complete", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has no phased release");
    noWrites(client);
  });

  it("should reject an unknown action", async () => {
    const { provider } = releaseClient({ phasedState: "ACTIVE" });
    const result = await run(
      ["versions", "phased-release", "V1", "stop"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(provider).not.toHaveBeenCalled();
  });
});
