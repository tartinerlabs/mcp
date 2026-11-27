import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient, AscQuery } from "../src/asc/client.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";

/** A client answering reads from `routes` (unknown paths are a 404) and recording writes. */
function routed(routes: Record<string, unknown>) {
  const client: AscClient = {
    get: vi.fn((path: string, _query?: AscQuery) =>
      path in routes
        ? Promise.resolve(routes[path])
        : Promise.reject(new AscApiError(404, { errors: [] })),
    ) as AscClient["get"],
    post: vi.fn((_path: string, body: unknown) =>
      Promise.resolve({
        data: { ...(body as { data: object }).data, id: "N9" },
      }),
    ) as AscClient["post"],
    patch: vi.fn((_path: string, body: unknown) =>
      Promise.resolve({
        data: {
          ...(body as { data: object }).data,
          attributes: { state: "SUBMITTED" },
        },
      }),
    ) as AscClient["patch"],
    delete: vi.fn(() => Promise.resolve()) as AscClient["delete"],
    upload: vi.fn(() => Promise.reject(new Error("unexpected"))),
    download: vi.fn(() => Promise.reject(new Error("unexpected"))),
    downloadSigned: vi.fn(() => Promise.reject(new Error("unexpected"))),
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

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const nomination = (
  state = "DRAFT",
  publishStartDate = "2999-01-01T00:00:00Z",
) => ({
  data: {
    type: "nominations",
    id: "N1",
    attributes: {
      name: "Winter update",
      type: "APP_ENHANCEMENTS",
      description: "New levels",
      state,
      publishStartDate,
      deviceFamilies: ["IPHONE"],
    },
    relationships: {
      relatedApps: { data: [{ type: "apps", id: "123" }] },
      inAppEvents: { data: [] },
    },
  },
});

describe("nominations", () => {
  it("should ask for drafts and submitted ones by default and shape each", async () => {
    const { client, provider } = routed({
      "/v1/nominations": { data: [nomination().data], links: { self: "x" } },
    });
    const { exitCode, stdout } = await run(
      ["nominations", "--app", "123"],
      provider,
    );
    expect(exitCode).toBe(0);
    const query = vi.mocked(client.get).mock.calls[0]?.[1];
    expect(query?.["filter[state]"]).toEqual(["DRAFT", "SUBMITTED"]);
    expect(query?.["filter[relatedApps]"]).toEqual(["123"]);
    const result = JSON.parse(stdout);
    expect(result.nominations[0]).toMatchObject({
      id: "N1",
      name: "Winter update",
      state: "DRAFT",
      appIds: ["123"],
      eventIds: [],
    });
    expect(result.hasMore).toBe(false);
  });

  it("should print the planned nomination without --yes", async () => {
    const { client, provider } = routed({
      "/v1/apps/123": {
        data: { type: "apps", id: "123", attributes: { name: "Game" } },
      },
    });
    const { exitCode, stdout, stderr } = await run(
      [
        "nominations",
        "create",
        "--app",
        "123",
        "--type",
        "APP_LAUNCH",
        "--name",
        "Launch",
        "--description",
        "Our first game",
        "--publish-date",
        "2999-01-01T00:00:00Z",
      ],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(stderr).toContain("Dry run");
    expect(JSON.parse(stdout)).toMatchObject({
      dryRun: true,
      apps: [{ id: "123", name: "Game" }],
      nomination: { name: "Launch", type: "APP_LAUNCH" },
    });
  });

  it("should create a draft for several apps with its events", async () => {
    const app = (id: string) => ({
      data: { type: "apps", id, attributes: {} },
    });
    const { client, provider } = routed({
      "/v1/apps/123": app("123"),
      "/v1/apps/456": app("456"),
    });
    const { exitCode } = await run(
      [
        "nominations",
        "create",
        "--app",
        "123",
        "--app",
        "456",
        "--type",
        "NEW_CONTENT",
        "--name",
        "Season 2",
        "--description",
        "A new season",
        "--publish-date",
        "2999-01-01T00:00:00Z",
        "--device-families",
        "IPHONE,IPAD",
        "--events",
        "E1",
        "--pre-order",
        "false",
        "--yes",
      ],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/nominations", {
      data: {
        type: "nominations",
        attributes: {
          name: "Season 2",
          type: "NEW_CONTENT",
          description: "A new season",
          publishStartDate: "2999-01-01T00:00:00Z",
          deviceFamilies: ["IPHONE", "IPAD"],
          preOrderEnabled: false,
          submitted: false,
        },
        relationships: {
          relatedApps: {
            data: [
              { type: "apps", id: "123" },
              { type: "apps", id: "456" },
            ],
          },
          inAppEvents: { data: [{ type: "appEvents", id: "E1" }] },
        },
      },
    });
  });

  it("should refuse a create without its required fields", async () => {
    const { client, provider } = routed({});
    const { exitCode, stderr } = await run(
      ["nominations", "create", "--app", "123", "--type", "APP_LAUNCH"],
      provider,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("[invalid_input]");
    expect(stderr).toContain("--name");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("should patch only the fields that change", async () => {
    const { client, provider } = routed({ "/v1/nominations/N1": nomination() });
    const { exitCode, stdout } = await run(
      [
        "nominations",
        "set",
        "N1",
        "--name",
        "Winter update",
        "--description",
        "New levels and a boss",
        "--yes",
      ],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/nominations/N1", {
      data: {
        type: "nominations",
        id: "N1",
        attributes: { description: "New levels and a boss" },
      },
    });
    expect(JSON.parse(stdout).changed).toEqual(["description"]);
  });

  it("should refuse to change a submitted nomination", async () => {
    const { client, provider } = routed({
      "/v1/nominations/N1": nomination("SUBMITTED"),
    });
    const { exitCode, stderr } = await run(
      ["nominations", "set", "N1", "--name", "New", "--yes"],
      provider,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SUBMITTED");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should submit a draft", async () => {
    const { client, provider } = routed({ "/v1/nominations/N1": nomination() });
    const { exitCode, stdout } = await run(
      ["nominations", "submit", "N1", "--yes"],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/nominations/N1", {
      data: { type: "nominations", id: "N1", attributes: { submitted: true } },
    });
    expect(JSON.parse(stdout)).toMatchObject({
      dryRun: false,
      state: "SUBMITTED",
    });
  });

  it("should refuse to submit a nomination whose publish date has passed", async () => {
    const { client, provider } = routed({
      "/v1/nominations/N1": nomination("DRAFT", "2000-01-01T00:00:00Z"),
    });
    const { exitCode, stderr } = await run(
      ["nominations", "submit", "N1", "--yes"],
      provider,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("[invalid_input]");
    expect(client.patch).not.toHaveBeenCalled();
  });
});
