import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { createProgram } from "../src/cli.ts";
import { appleIncludes } from "./apple-includes.ts";

type Query = Record<string, unknown>;
type Route = (query: Query) => unknown;

/** A client answering GETs from `routes` by path; writes resolve and are recorded. */
function mockClient(routes: Record<string, Route>) {
  const get = vi.fn(async (path: string, query: Query = {}) => {
    const route = routes[path];
    if (!route) throw new Error(`unexpected GET ${path}`);
    return route(query);
  });
  const post = vi.fn(async (_path: string, _body: unknown) => ({
    data: { id: "NEW", attributes: {} },
  }));
  const patch = vi.fn(async (_path: string, _body: unknown) => ({}));
  const del = vi.fn(async (_path: string, _body?: unknown) => {});
  const downloadSigned = vi.fn(async (url: string) =>
    new TextEncoder().encode(`dsym from ${url}`),
  );
  const fail = () => Promise.reject(new Error("unexpected call"));
  const client = {
    get: vi.fn(appleIncludes(get)),
    post,
    patch,
    delete: del,
    upload: vi.fn(fail),
    download: vi.fn(fail),
    downloadSigned,
  } as unknown as AscClient;
  return { client, get, post, patch, del, downloadSigned };
}

async function run(args: string[], client: AscClient) {
  let stderr = "";
  const program = createProgram(() => client);
  const all = (command: Command): Command[] => [
    command,
    ...command.commands.flatMap(all),
  ];
  for (const command of all(program)) {
    command.exitOverride().configureOutput({
      writeErr: (text) => {
        stderr += text;
      },
      writeOut: () => {},
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
    stdout,
    stderr,
    // biome-ignore lint/suspicious/noExplicitAny: test results are read loosely
    json: () => JSON.parse(stdout) as Record<string, any>,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ASC_DEMO_ACCOUNT_PASSWORD;
});

const SECRET = "hunter2-secret";

const reviewDetail = (attributes: Record<string, unknown> = {}) => ({
  data: {
    type: "betaAppReviewDetails",
    id: "RD1",
    attributes: {
      contactFirstName: "Ada",
      contactLastName: "Lovelace",
      contactPhone: "+1 555 0100",
      contactEmail: "ada@example.com",
      demoAccountRequired: true,
      demoAccountName: "demo",
      demoAccountPassword: SECRET,
      notes: null,
      ...attributes,
    },
  },
});

const localizations = () => ({
  data: [
    {
      type: "betaAppLocalizations",
      id: "L1",
      attributes: {
        locale: "en-US",
        description: "Old",
        feedbackEmail: "beta@example.com",
        marketingUrl: null,
        privacyPolicyUrl: null,
      },
    },
  ],
});

describe("testflight info", () => {
  it("prints localizations and review details without the demo password", async () => {
    const { client } = mockClient({
      "/v1/apps/123/betaAppLocalizations": localizations,
      "/v1/apps/123/betaAppReviewDetail": () => reviewDetail(),
    });
    const result = await run(["testflight", "info", "123"], client);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    const json = result.json();
    expect(json.localizations[0]).toMatchObject({
      locale: "en-US",
      description: "Old",
    });
    expect(json.reviewDetails).toMatchObject({
      id: "RD1",
      demoAccountRequired: true,
      demoAccountPasswordSet: true,
    });
  });

  it("set patches the existing locale with only what changes", async () => {
    const { client, patch, post } = mockClient({
      "/v1/apps/123/betaAppLocalizations": localizations,
    });
    const dry = await run(
      [
        "testflight",
        "info",
        "set",
        "123",
        "--locale",
        "en-US",
        "--description",
        "New",
        "--feedback-email",
        "beta@example.com",
      ],
      client,
    );
    expect(dry.json()).toMatchObject({
      dryRun: true,
      creates: false,
      changes: { description: "New" },
    });
    expect(patch).not.toHaveBeenCalled();
    vi.mocked(console.log).mockClear();
    await run(
      [
        "testflight",
        "info",
        "set",
        "123",
        "--locale",
        "en-US",
        "--description",
        "New",
        "--yes",
      ],
      client,
    );
    expect(patch).toHaveBeenCalledWith("/v1/betaAppLocalizations/L1", {
      data: {
        type: "betaAppLocalizations",
        id: "L1",
        attributes: { description: "New" },
      },
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("set creates a missing locale", async () => {
    const { client, post } = mockClient({
      "/v1/apps/123/betaAppLocalizations": localizations,
    });
    await run(
      [
        "testflight",
        "info",
        "set",
        "123",
        "--locale",
        "fr-FR",
        "--privacy-url",
        "https://example.com/privacy",
        "--yes",
      ],
      client,
    );
    expect(post).toHaveBeenCalledWith("/v1/betaAppLocalizations", {
      data: {
        type: "betaAppLocalizations",
        attributes: {
          locale: "fr-FR",
          privacyPolicyUrl: "https://example.com/privacy",
        },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
  });

  it("set refuses a call with nothing to set", async () => {
    const { client } = mockClient({});
    const result = await run(
      ["testflight", "info", "set", "123", "--locale", "en-US"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Give at least one of");
  });
});

describe("testflight review-details set", () => {
  it("sends the password from the environment and never prints it", async () => {
    process.env.ASC_DEMO_ACCOUNT_PASSWORD = "new-secret-pass";
    const { client, patch } = mockClient({
      "/v1/apps/123/betaAppReviewDetail": () => reviewDetail(),
    });
    const dry = await run(
      ["testflight", "review-details", "set", "123", "--notes", "Hi"],
      client,
    );
    expect(dry.json()).toMatchObject({
      dryRun: true,
      changes: { notes: "Hi" },
      setsDemoAccountPassword: true,
    });
    expect(patch).not.toHaveBeenCalled();
    vi.mocked(console.log).mockClear();
    const done = await run(
      ["testflight", "review-details", "set", "123", "--notes", "Hi", "--yes"],
      client,
    );
    for (const output of [dry.stdout, dry.stderr, done.stdout, done.stderr]) {
      expect(output).not.toContain("new-secret-pass");
      expect(output).not.toContain(SECRET);
    }
    expect(patch).toHaveBeenCalledWith("/v1/betaAppReviewDetails/RD1", {
      data: {
        type: "betaAppReviewDetails",
        id: "RD1",
        attributes: { notes: "Hi", demoAccountPassword: "new-secret-pass" },
      },
    });
  });

  it("refuses a required demo account without a password", async () => {
    const { client, patch } = mockClient({
      "/v1/apps/123/betaAppReviewDetail": () =>
        reviewDetail({
          demoAccountRequired: false,
          demoAccountPassword: null,
        }),
    });
    const result = await run(
      [
        "testflight",
        "review-details",
        "set",
        "123",
        "--demo-account-required",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--demo-account-password");
    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps a password given as a flag out of validation errors", async () => {
    const { client } = mockClient({});
    const result = await run(
      [
        "testflight",
        "review-details",
        "set",
        "123",
        "--contact-email",
        "not-an-email",
        "--demo-account-password",
        "flag-secret",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("flag-secret");
  });
});

const groupResource = (attributes: Record<string, unknown> = {}) => ({
  data: {
    type: "betaGroups",
    id: "G1",
    attributes: {
      name: "Beta",
      isInternalGroup: false,
      feedbackEnabled: true,
      publicLinkEnabled: false,
      publicLinkLimitEnabled: false,
      publicLinkLimit: null,
      ...attributes,
    },
    relationships: { app: { data: { type: "apps", id: "123" } } },
  },
});

describe("testflight groups create, set and delete", () => {
  it("creates an internal group, taking --internal from the parent command", async () => {
    const { client, post } = mockClient({
      "/v1/betaGroups": () => ({ data: [] }),
    });
    const result = await run(
      [
        "testflight",
        "groups",
        "create",
        "123",
        "--name",
        "QA",
        "--internal",
        "--all-builds",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(post).toHaveBeenCalledWith("/v1/betaGroups", {
      data: {
        type: "betaGroups",
        attributes: {
          name: "QA",
          isInternalGroup: true,
          hasAccessToAllBuilds: true,
        },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
  });

  it("dry-runs an external group with a limited public link", async () => {
    const { client, post } = mockClient({
      "/v1/betaGroups": () => ({ data: [] }),
    });
    const result = await run(
      [
        "testflight",
        "groups",
        "create",
        "123",
        "--name",
        "Public",
        "--external",
        "--public-link",
        "--public-link-limit",
        "500",
      ],
      client,
    );
    expect(result.json()).toMatchObject({
      dryRun: true,
      group: {
        isInternalGroup: false,
        publicLinkEnabled: true,
        publicLinkLimitEnabled: true,
        publicLinkLimit: 500,
      },
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses a name the app already uses", async () => {
    const { client, post } = mockClient({
      "/v1/betaGroups": () => ({ data: [{ type: "betaGroups", id: "G9" }] }),
    });
    const result = await run(
      ["testflight", "groups", "create", "123", "--name", "QA", "--external"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already has a group");
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses a group with neither --internal nor --external", async () => {
    const { client } = mockClient({});
    const result = await run(
      ["testflight", "groups", "create", "123", "--name", "QA"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--internal or --external");
  });

  it("set turns on the public link with a limit", async () => {
    const { client, patch } = mockClient({
      "/v1/betaGroups/G1": () => groupResource(),
    });
    await run(
      [
        "testflight",
        "groups",
        "set",
        "G1",
        "--public-link",
        "--public-link-limit",
        "100",
        "--no-feedback",
        "--yes",
      ],
      client,
    );
    expect(patch).toHaveBeenCalledWith("/v1/betaGroups/G1", {
      data: {
        type: "betaGroups",
        id: "G1",
        attributes: {
          publicLinkEnabled: true,
          publicLinkLimitEnabled: true,
          publicLinkLimit: 100,
          feedbackEnabled: false,
        },
      },
    });
  });

  it("set removes the limit with --no-public-link-limit", async () => {
    const { client, patch } = mockClient({
      "/v1/betaGroups/G1": () =>
        groupResource({
          publicLinkEnabled: true,
          publicLinkLimitEnabled: true,
          publicLinkLimit: 50,
        }),
    });
    await run(
      ["testflight", "groups", "set", "G1", "--no-public-link-limit", "--yes"],
      client,
    );
    expect(patch).toHaveBeenCalledWith("/v1/betaGroups/G1", {
      data: {
        type: "betaGroups",
        id: "G1",
        attributes: { publicLinkLimitEnabled: false },
      },
    });
  });

  it("set refuses a public link on an internal group", async () => {
    const { client, patch } = mockClient({
      "/v1/betaGroups/G1": () => groupResource({ isInternalGroup: true }),
    });
    const result = await run(
      ["testflight", "groups", "set", "G1", "--public-link", "--yes"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Only external groups");
    expect(patch).not.toHaveBeenCalled();
  });

  it("delete says it cannot be undone, then deletes with --yes", async () => {
    const { client, del } = mockClient({
      "/v1/betaGroups/G1": () => groupResource(),
    });
    const dry = await run(["testflight", "groups", "delete", "G1"], client);
    expect(dry.json().note).toContain("cannot be undone");
    expect(del).not.toHaveBeenCalled();
    await run(["testflight", "groups", "delete", "G1", "--yes"], client);
    expect(del).toHaveBeenCalledWith("/v1/betaGroups/G1");
  });
});

describe("testflight testers import and export", () => {
  async function csv(contents: string) {
    const dir = await mkdtemp(join(tmpdir(), "asc-testers-"));
    const path = join(dir, "testers.csv");
    await writeFile(path, contents);
    return path;
  }

  function importClient() {
    return mockClient({
      "/v1/betaGroups/G1": () => groupResource(),
      "/v1/betaGroups/G2": () => ({
        ...groupResource(),
        data: { ...groupResource().data, id: "G2" },
      }),
      "/v1/betaTesters": (query) =>
        query["filter[email]"] === "known@example.com"
          ? { data: [{ type: "betaTesters", id: "T1" }] }
          : { data: [] },
      "/v1/betaTesters/T1/relationships/betaGroups": () => ({
        data: [{ type: "betaGroups", id: "G1" }],
      }),
    });
  }

  it("plans per row without printing emails", async () => {
    const file = await csv(
      "Email,First Name,Last Name\nknown@example.com,Kim,Known\nnew@example.com,Nat,New\nnew@example.com,,\n",
    );
    const { client, post } = importClient();
    const result = await run(
      [
        "testflight",
        "testers",
        "import",
        "123",
        "--file",
        file,
        "--group",
        "G1",
        "--group",
        "G2",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("@example.com");
    expect(result.json()).toMatchObject({
      dryRun: true,
      summary: { invite: 1, add: 1, none: 0 },
      rows: [
        { row: 2, change: "add", groups: ["G2"], testerId: "T1" },
        { row: 3, change: "invite", groups: ["G1", "G2"] },
      ],
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("adds and invites with --yes", async () => {
    const file = await csv(
      "email,firstName,lastName\nknown@example.com,Kim,Known\nnew@example.com,Nat,New\n",
    );
    const { client, post } = importClient();
    const result = await run(
      [
        "testflight",
        "testers",
        "import",
        "123",
        "--file",
        file,
        "--group",
        "G1,G2",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(post).toHaveBeenCalledWith(
      "/v1/betaTesters/T1/relationships/betaGroups",
      { data: [{ type: "betaGroups", id: "G2" }] },
    );
    expect(post).toHaveBeenCalledWith("/v1/betaTesters", {
      data: {
        type: "betaTesters",
        attributes: {
          email: "new@example.com",
          firstName: "Nat",
          lastName: "New",
        },
        relationships: {
          betaGroups: {
            data: [
              { type: "betaGroups", id: "G1" },
              { type: "betaGroups", id: "G2" },
            ],
          },
        },
      },
    });
  });

  it("reports a failed row and exits 1 after trying the rest", async () => {
    const file = await csv("email\nnew@example.com\nother@example.com\n");
    const { client, post } = importClient();
    post.mockRejectedValueOnce(new Error("boom"));
    const result = await run(
      [
        "testflight",
        "testers",
        "import",
        "123",
        "--file",
        file,
        "--group",
        "G1",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(post).toHaveBeenCalledTimes(2);
    const json = JSON.parse(result.stdout);
    expect(json.failed).toBe(1);
    expect(json.rows[0].error).toBeDefined();
  });

  it("refuses rows without an email, naming the rows only", async () => {
    const file = await csv("email\nnope\nok@example.com\n");
    const { client, post } = importClient();
    const result = await run(
      [
        "testflight",
        "testers",
        "import",
        "123",
        "--file",
        file,
        "--group",
        "G1",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("rows have no valid email address: 2");
    expect(result.stderr).not.toContain("nope");
    expect(post).not.toHaveBeenCalled();
  });

  it("listing testers still takes only one --group", async () => {
    const { client, get } = mockClient({});
    const result = await run(
      ["testflight", "testers", "123", "--group", "G1", "--group", "G2"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Give one --group.");
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses a group of another app", async () => {
    const file = await csv("email\nok@example.com\n");
    const { client } = mockClient({
      "/v1/betaGroups/G1": () => groupResource(),
    });
    const result = await run(
      [
        "testflight",
        "testers",
        "import",
        "999",
        "--file",
        file,
        "--group",
        "G1",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("belongs to another app");
  });

  const testerPage = (cursor?: string) => ({
    data: [
      {
        type: "betaTesters",
        id: cursor ? "T2" : "T1",
        attributes: {
          firstName: cursor ? "=cmd" : "Kim",
          lastName: 'O"Brien, Jr',
          email: cursor ? "b@example.com" : "a@example.com",
          inviteType: "EMAIL",
          state: "INSTALLED",
        },
      },
    ],
    links: cursor
      ? { self: "x" }
      : {
          self: "x",
          next: "https://api.appstoreconnect.apple.com/v1/betaTesters?cursor=NEXT",
        },
  });

  it("export writes every page to a new file and prints no emails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-export-"));
    const out = join(dir, "testers.csv");
    const { client, get } = mockClient({
      "/v1/betaTesters": (query) =>
        testerPage(query.cursor as string | undefined),
    });
    const result = await run(
      ["testflight", "testers", "export", "123", "--out", out],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("@example.com");
    expect(result.json()).toMatchObject({ count: 2, format: "csv" });
    expect(get).toHaveBeenCalledTimes(2);
    const text = await readFile(out, "utf8");
    expect(text).toBe(
      'id,email,firstName,lastName,inviteType,state\nT1,a@example.com,Kim,"O""Brien, Jr",EMAIL,INSTALLED\nT2,b@example.com,\'=cmd,"O""Brien, Jr",EMAIL,INSTALLED\n',
    );
    expect((await stat(out)).mode & 0o777).toBe(0o600);

    const again = await run(
      ["testflight", "testers", "export", "123", "--out", out],
      client,
    );
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("already exists");
  });

  it("export writes JSON for one group", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-export-"));
    const out = join(dir, "testers.json");
    const { client, get } = mockClient({
      "/v1/betaGroups/G1": () => groupResource(),
      "/v1/betaTesters": () => testerPage("last"),
    });
    await run(
      ["testflight", "testers", "export", "123", "--out", out, "--group", "G1"],
      client,
    );
    expect(get).toHaveBeenCalledWith(
      "/v1/betaTesters",
      expect.objectContaining({ "filter[betaGroups]": "G1" }),
    );
    expect(JSON.parse(await readFile(out, "utf8"))).toHaveLength(1);
  });
});

const buildDocument = (attributes: Record<string, unknown> = {}) => ({
  data: {
    type: "builds",
    id: "B1",
    attributes: { version: "42", processingState: "VALID", ...attributes },
    relationships: { app: { data: { type: "apps", id: "123" } } },
  },
});

describe("testflight notify", () => {
  it("posts a build beta notification with --yes", async () => {
    const { client, post } = mockClient({
      "/v1/builds/B1": () => buildDocument({ expired: false }),
    });
    const dry = await run(["testflight", "notify", "B1"], client);
    expect(dry.json()).toMatchObject({ dryRun: true, build: { id: "B1" } });
    expect(post).not.toHaveBeenCalled();
    await run(["testflight", "notify", "B1", "--yes"], client);
    expect(post).toHaveBeenCalledWith("/v1/buildBetaNotifications", {
      data: {
        type: "buildBetaNotifications",
        relationships: { build: { data: { type: "builds", id: "B1" } } },
      },
    });
  });

  it("refuses an expired build", async () => {
    const { client } = mockClient({
      "/v1/builds/B1": () => buildDocument({ expired: true }),
    });
    const result = await run(["testflight", "notify", "B1"], client);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("expired");
  });
});

const build = (id: string, version: string, uploadedDate: string) => ({
  type: "builds",
  id,
  attributes: { version, uploadedDate, processingState: "VALID" },
  relationships: {
    preReleaseVersion: { data: { type: "preReleaseVersions", id: "P1" } },
  },
});

describe("builds expire, latest and dsyms", () => {
  const unexpired = () => ({
    data: [
      build("B3", "12", "2026-11-03T00:00:00Z"),
      build("B2", "11", "2026-11-02T00:00:00Z"),
      build("B1", "10", "2026-11-01T00:00:00Z"),
    ],
    included: [
      {
        type: "preReleaseVersions",
        id: "P1",
        attributes: { version: "2.5.0", platform: "IOS" },
      },
    ],
  });

  it("--keep lists the builds it would expire, then expires them", async () => {
    const { client, get, patch } = mockClient({ "/v1/builds": unexpired });
    const dry = await run(["builds", "expire", "123", "--keep", "1"], client);
    expect(get).toHaveBeenCalledWith(
      "/v1/builds",
      expect.objectContaining({
        "filter[app]": "123",
        "filter[expired]": false,
      }),
    );
    expect(dry.json()).toMatchObject({ dryRun: true, count: 2 });
    expect(dry.json().builds.map((b: { id: string }) => b.id)).toEqual([
      "B2",
      "B1",
    ]);
    expect(patch).not.toHaveBeenCalled();
    vi.mocked(console.log).mockClear();
    const done = await run(
      ["builds", "expire", "123", "--keep", "1", "--yes"],
      client,
    );
    expect(done.json()).toMatchObject({ count: 2, expired: ["B2", "B1"] });
    expect(patch).toHaveBeenCalledWith("/v1/builds/B1", {
      data: { type: "builds", id: "B1", attributes: { expired: true } },
    });
  });

  it("--older-than expires only builds uploaded before that build", async () => {
    const { client } = mockClient({
      "/v1/builds": unexpired,
      "/v1/builds/B2": () => ({
        data: {
          ...build("B2", "11", "2026-11-02T00:00:00Z"),
          relationships: {
            app: { data: { type: "apps", id: "123" } },
            preReleaseVersion: {
              data: { type: "preReleaseVersions", id: "P1" },
            },
          },
        },
        included: unexpired().included,
      }),
    });
    const dry = await run(
      ["builds", "expire", "123", "--older-than", "B2"],
      client,
    );
    expect(dry.json().builds.map((b: { id: string }) => b.id)).toEqual(["B1"]);
  });

  it("names what was done when a bulk expiry stops partway", async () => {
    const { client, patch } = mockClient({ "/v1/builds": unexpired });
    patch.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("boom"));
    const result = await run(
      ["builds", "expire", "123", "--keep", "0", "--yes"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("after expiring 1 of 3 builds: B3");
  });

  it("still expires one build by id", async () => {
    const { client, patch } = mockClient({
      "/v1/builds/B1": () => buildDocument({ expired: false }),
    });
    await run(["builds", "expire", "B1", "--yes"], client);
    expect(patch).toHaveBeenCalledWith("/v1/builds/B1", {
      data: { type: "builds", id: "B1", attributes: { expired: true } },
    });
  });

  it("latest prints the highest build number and the next one", async () => {
    const { client, get } = mockClient({
      "/v1/builds": () => ({
        data: [
          build("B9", "9", "2026-11-03T00:00:00Z"),
          build("B10", "10", "2026-11-01T00:00:00Z"),
        ],
        included: unexpired().included,
      }),
    });
    const result = await run(
      ["builds", "latest", "123", "--app-version", "2.5.0", "--next"],
      client,
    );
    expect(get).toHaveBeenCalledWith(
      "/v1/builds",
      expect.objectContaining({ "filter[preReleaseVersion.version]": "2.5.0" }),
    );
    expect(result.json()).toMatchObject({
      buildNumber: "10",
      next: "11",
      id: "B10",
      marketingVersion: "2.5.0",
    });
  });

  it("latest is not_found for an app with no builds", async () => {
    const { client } = mockClient({ "/v1/builds": () => ({ data: [] }) });
    const result = await run(["builds", "latest", "123"], client);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found]");
  });

  const bundles = () => ({
    data: { type: "builds", id: "B1", attributes: { version: "42" } },
    included: [
      {
        type: "buildBundles",
        id: "BB1",
        attributes: {
          bundleId: "com.example.app",
          bundleType: "APP",
          dSYMUrl: "https://storage.example.com/app.zip",
        },
      },
      {
        type: "buildBundles",
        id: "BB2",
        attributes: { bundleId: "com.example.clip", bundleType: "APP_CLIP" },
      },
    ],
  });

  it("dsyms downloads each bundle's dSYM and will not overwrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-dsyms-"));
    const out = join(dir, "symbols");
    const { client, downloadSigned } = mockClient({
      "/v1/builds/B1": bundles,
    });
    const result = await run(["builds", "dsyms", "B1", "--out", out], client);
    expect(result.exitCode).toBe(0);
    expect(downloadSigned).toHaveBeenCalledWith(
      "https://storage.example.com/app.zip",
    );
    expect(result.json()).toMatchObject({
      files: [
        { bundleId: "com.example.app", file: "com.example.app-42.dSYM.zip" },
      ],
      withoutSymbols: ["com.example.clip"],
    });
    expect(
      await readFile(join(out, "com.example.app-42.dSYM.zip"), "utf8"),
    ).toBe("dsym from https://storage.example.com/app.zip");

    downloadSigned.mockClear();
    const again = await run(["builds", "dsyms", "B1", "--out", out], client);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("--overwrite");
    expect(downloadSigned).not.toHaveBeenCalled();

    const forced = await run(
      ["builds", "dsyms", "B1", "--out", out, "--overwrite"],
      client,
    );
    expect(forced.exitCode).toBe(0);
  });

  it("dsyms finds the build by app and build number", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-dsyms-"));
    const { client, get } = mockClient({
      "/v1/builds": () => ({ data: [{ type: "builds", id: "B1" }] }),
      "/v1/builds/B1": bundles,
    });
    const result = await run(
      ["builds", "dsyms", "--app", "123", "--build-number", "42", "--out", dir],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(get).toHaveBeenCalledWith(
      "/v1/builds",
      expect.objectContaining({
        "filter[app]": "123",
        "filter[version]": "42",
      }),
    );
  });

  it("dsyms is not_found when Apple has no symbols", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-dsyms-"));
    const { client } = mockClient({
      "/v1/builds/B1": () => ({ ...bundles(), included: [] }),
    });
    const result = await run(["builds", "dsyms", "B1", "--out", dir], client);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found]");
  });
});
