import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function mockClient(get = vi.fn(async () => ({})) as AscClient["get"]) {
  const client: AscClient = {
    get: vi.fn(get) as AscClient["get"],
    post: vi.fn(async () => ({ data: { id: "N1" } })) as AscClient["post"],
    patch: vi.fn(async () => ({ data: { id: "P1" } })) as AscClient["patch"],
    delete: vi.fn(async () => {}),
    upload: vi.fn(() => Promise.reject(new Error("unexpected upload"))),
    download: vi.fn(() => Promise.reject(new Error("unexpected download"))),
    downloadSigned: vi.fn(() =>
      Promise.reject(new Error("unexpected download")),
    ),
  };
  return { client, provider: vi.fn<AscClientProvider>(() => client) };
}

async function bodyFile(text: string) {
  const dir = await mkdtemp(join(tmpdir(), "asc-api-"));
  const file = join(dir, "body.json");
  await writeFile(file, text);
  return file;
}

describe("api", () => {
  it("should GET a path with its query and print Apple's response", async () => {
    const response = { data: [{ type: "apps", id: "1" }] };
    const { client, provider } = mockClient(
      vi.fn(async () => response) as AscClient["get"],
    );
    const result = await run(
      [
        "api",
        "GET",
        "/v1/apps?limit=5",
        "--query",
        "filter[platform]=IOS",
        "--query",
        "filter[platform]=MAC_OS",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith("/v1/apps?limit=5", {
      "filter[platform]": ["IOS", "MAC_OS"],
    });
    expect(JSON.parse(result.stdout)).toEqual(response);
  });

  it("should accept a full URL on the API host", async () => {
    const { client, provider } = mockClient();
    const result = await run(
      ["api", "GET", "https://api.appstoreconnect.apple.com/v1/apps/1"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith("/v1/apps/1", {});
  });

  it("should refuse any other host without sending a request", async () => {
    for (const path of [
      "https://evil.example/v1/apps",
      "//evil.example/v1/apps",
      "/\\evil.example/v1/apps",
      "http://api.appstoreconnect.apple.com/v1/apps",
      "https://appstoreconnect.apple.com/notary/v2/submissions",
      "v1/apps",
    ]) {
      const { client, provider } = mockClient();
      const result = await run(["api", "GET", path], provider);
      expect(result.exitCode, path).toBe(1);
      expect(result.stderr).toContain("[invalid_input]");
      expect(client.get).not.toHaveBeenCalled();
    }
  });

  it("should follow links.next with --paginate and join the pages", async () => {
    const pages = [
      {
        data: [{ type: "builds", id: "1" }],
        included: [{ type: "apps", id: "A" }],
        links: {
          next: "https://api.appstoreconnect.apple.com/v1/builds?cursor=2",
        },
      },
      {
        data: [{ type: "builds", id: "2" }],
        included: [{ type: "apps", id: "A" }],
        links: {},
      },
    ];
    const { client, provider } = mockClient(
      vi.fn(async () => pages.shift()) as AscClient["get"],
    );
    const result = await run(
      ["api", "GET", "/v1/builds", "--query", "limit=1", "--paginate"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(vi.mocked(client.get).mock.calls).toEqual([
      ["/v1/builds", { limit: ["1"] }],
      ["/v1/builds?cursor=2", undefined],
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      data: [
        { type: "builds", id: "1" },
        { type: "builds", id: "2" },
      ],
      included: [{ type: "apps", id: "A" }],
      pages: 2,
    });
  });

  it("should not follow a next link to another host", async () => {
    const { client, provider } = mockClient(
      vi.fn(async () => ({
        data: [],
        links: { next: "https://evil.example/v1/builds?cursor=2" },
      })) as AscClient["get"],
    );
    const result = await run(
      ["api", "GET", "/v1/builds", "--paginate"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("should change nothing without --yes, then send the body with it", async () => {
    const body = { data: { type: "apps", id: "1", attributes: {} } };
    const file = await bodyFile(JSON.stringify(body));
    const { client, provider } = mockClient();
    let result = await run(
      ["api", "PATCH", "/v1/apps/1", "--body", file],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Dry run");
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      request: { method: "PATCH", path: "/v1/apps/1", body },
    });
    expect(client.patch).not.toHaveBeenCalled();

    vi.mocked(console.log).mockClear();
    result = await run(
      ["api", "PATCH", "/v1/apps/1", "--body", file, "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/apps/1", body);
    expect(JSON.parse(result.stdout).response).toEqual({ data: { id: "P1" } });
  });

  it("should DELETE without a body and print null for Apple's 204", async () => {
    const { client, provider } = mockClient();
    const result = await run(
      ["api", "DELETE", "/v1/betaTesters/T1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith("/v1/betaTesters/T1", undefined);
    expect(JSON.parse(result.stdout).response).toBeNull();
  });

  it("should refuse a write without a body, a body that is not JSON, and --paginate on a write", async () => {
    const cases: [string[], string][] = [
      [["api", "POST", "/v1/apps", "--yes"], "needs a JSON body"],
      [
        ["api", "POST", "/v1/apps", "--body", await bodyFile("{"), "--yes"],
        "not valid JSON",
      ],
      [
        ["api", "DELETE", "/v1/apps/1", "--paginate", "--yes"],
        "only follows pages of a GET",
      ],
      [["api", "GET", "/v1/apps", "--query", "limit"], "not key=value"],
    ];
    for (const [args, message] of cases) {
      const { client, provider } = mockClient();
      const result = await run(args, provider);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
      expect(client.post).not.toHaveBeenCalled();
      expect(client.delete).not.toHaveBeenCalled();
    }
  });

  it("should refuse a method it does not know", async () => {
    const { provider } = mockClient();
    const result = await run(["api", "PUT", "/v1/apps"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Allowed choices are GET, POST, PATCH, DELETE",
    );
  });

  it("should classify Apple's errors like every other command", async () => {
    const { provider } = mockClient(
      vi.fn(() => Promise.reject(new AscApiError(403, {}))) as AscClient["get"],
    );
    const result = await run(["api", "GET", "/v1/salesReports"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[permission]");
  });
});
