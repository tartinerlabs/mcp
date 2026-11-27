import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";

function mockClient(overrides: Partial<AscClient> = {}): AscClient {
  const fail = () => Promise.reject(new Error("unexpected call"));
  return {
    get: vi.fn(fail) as AscClient["get"],
    post: vi.fn(fail) as AscClient["post"],
    patch: vi.fn(fail) as AscClient["patch"],
    delete: vi.fn(fail) as AscClient["delete"],
    upload: vi.fn(fail) as AscClient["upload"],
    download: vi.fn(fail) as AscClient["download"],
    downloadSigned: vi.fn(fail) as AscClient["downloadSigned"],
    ...overrides,
  };
}

async function run(args: string[], client: AscClient) {
  let stderr = "";
  const provider: AscClientProvider = () => client;
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

const get = (impl: (path: string, query?: unknown) => unknown) =>
  vi.fn((path: string, query?: unknown) =>
    Promise.resolve(impl(path, query)),
  ) as unknown as AscClient["get"];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bundle-ids create", () => {
  it("should check the identifier and change nothing without --yes", async () => {
    const client = mockClient({
      get: get(() => ({
        data: [
          {
            type: "bundleIds",
            id: "B0",
            attributes: { identifier: "com.example.app.widget" },
          },
        ],
      })),
    });
    const result = await run(
      [
        "bundle-ids",
        "create",
        "--identifier",
        "com.example.app",
        "--name",
        "Example",
        "--platform",
        "IOS",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      bundleId: { identifier: "com.example.app", platform: "IOS" },
    });
    expect(client.post).not.toHaveBeenCalled();
    expect(result.stderr).toContain("Dry run");
  });

  it("should register it with --yes", async () => {
    const post = vi.fn(() =>
      Promise.resolve({
        data: {
          type: "bundleIds",
          id: "B1",
          attributes: {
            identifier: "com.example.app",
            name: "Example",
            platform: "IOS",
            seedId: "TEAM",
          },
        },
      }),
    );
    const client = mockClient({
      get: get(() => ({ data: [] })),
      post: post as unknown as AscClient["post"],
    });
    const result = await run(
      [
        "bundle-ids",
        "create",
        "--identifier",
        "com.example.app",
        "--name",
        "Example",
        "--platform",
        "IOS",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(post).toHaveBeenCalledWith("/v1/bundleIds", {
      data: {
        type: "bundleIds",
        attributes: {
          identifier: "com.example.app",
          name: "Example",
          platform: "IOS",
        },
      },
    });
    expect(JSON.parse(result.stdout).bundleId).toMatchObject({
      id: "B1",
      teamId: "TEAM",
    });
  });

  it("should refuse an identifier that is taken", async () => {
    const client = mockClient({
      get: get(() => ({
        data: [
          {
            type: "bundleIds",
            id: "B1",
            attributes: { identifier: "com.example.app" },
          },
        ],
      })),
    });
    const result = await run(
      [
        "bundle-ids",
        "create",
        "--identifier",
        "com.example.app",
        "--name",
        "Example",
        "--platform",
        "IOS",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("B1");
  });

  it("should explain that a team key is needed", async () => {
    const client = mockClient({
      get: vi.fn(() =>
        Promise.reject(new AscApiError(403, { errors: [] })),
      ) as AscClient["get"],
    });
    const result = await run(
      [
        "bundle-ids",
        "create",
        "--identifier",
        "com.example.app",
        "--name",
        "Example",
        "--platform",
        "IOS",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[permission]");
    expect(result.stderr).toContain("team API key");
  });
});

const capabilities = {
  data: [
    {
      type: "bundleIdCapabilities",
      id: "C1",
      attributes: { capabilityType: "PUSH_NOTIFICATIONS", settings: null },
    },
  ],
};

describe("bundle-ids capabilities", () => {
  it("should list a bundle ID's capabilities", async () => {
    const client = mockClient({ get: get(() => capabilities) });
    const result = await run(["bundle-ids", "capabilities", "B1"], client);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/bundleIds/B1/bundleIdCapabilities",
      { limit: 200 },
    );
    expect(JSON.parse(result.stdout).capabilities).toEqual([
      { id: "C1", type: "PUSH_NOTIFICATIONS" },
    ]);
  });
});

describe("bundle-ids enable", () => {
  it("should send settings grouped by key", async () => {
    const post = vi.fn(() =>
      Promise.resolve({
        data: {
          type: "bundleIdCapabilities",
          id: "C2",
          attributes: { capabilityType: "ICLOUD" },
        },
      }),
    );
    const client = mockClient({
      get: get(() => capabilities),
      post: post as unknown as AscClient["post"],
    });
    const result = await run(
      [
        "bundle-ids",
        "enable",
        "B1",
        "--capability",
        "ICLOUD",
        "--setting",
        "ICLOUD_VERSION=XCODE_6",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(post).toHaveBeenCalledWith("/v1/bundleIdCapabilities", {
      data: {
        type: "bundleIdCapabilities",
        attributes: {
          capabilityType: "ICLOUD",
          settings: [
            {
              key: "ICLOUD_VERSION",
              options: [{ key: "XCODE_6", enabled: true }],
            },
          ],
        },
        relationships: { bundleId: { data: { type: "bundleIds", id: "B1" } } },
      },
    });
    expect(JSON.parse(result.stdout).note).toContain("profiles renew");
  });

  it("should refuse a capability that is already on", async () => {
    const client = mockClient({ get: get(() => capabilities) });
    const result = await run(
      ["bundle-ids", "enable", "B1", "--capability", "PUSH_NOTIFICATIONS"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already enabled");
  });

  it("should refuse a malformed setting", async () => {
    const result = await run(
      [
        "bundle-ids",
        "enable",
        "B1",
        "--capability",
        "ICLOUD",
        "--setting",
        "XCODE_6",
      ],
      mockClient(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("KEY=OPTION");
  });
});

describe("bundle-ids disable", () => {
  it("should delete the capability with --yes", async () => {
    const del = vi.fn(() => Promise.resolve(undefined));
    const client = mockClient({
      get: get(() => capabilities),
      delete: del as unknown as AscClient["delete"],
    });
    const result = await run(
      [
        "bundle-ids",
        "disable",
        "B1",
        "--capability",
        "PUSH_NOTIFICATIONS",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(del).toHaveBeenCalledWith("/v1/bundleIdCapabilities/C1");
  });

  it("should say when the capability is not on", async () => {
    const client = mockClient({ get: get(() => capabilities) });
    const result = await run(
      ["bundle-ids", "disable", "B1", "--capability", "ICLOUD"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found]");
  });
});

const UDID_A = "00008030-001A2B3C4D5E6F70";
const UDID_B = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("devices register", () => {
  const existing = {
    data: [
      {
        type: "devices",
        id: "D1",
        attributes: {
          name: "Old",
          udid: UDID_B.toUpperCase(),
          status: "ENABLED",
        },
      },
    ],
  };

  it("should warn about the device limit and change nothing without --yes", async () => {
    const client = mockClient({ get: get(() => existing) });
    const result = await run(
      ["devices", "register", "--name", "Test phone", "--udid", UDID_A],
      client,
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      dryRun: true,
      toRegister: [{ name: "Test phone", udid: UDID_A, platform: "IOS" }],
      alreadyRegistered: [],
    });
    expect(output.warning).toContain("device limit");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should register a file's devices and skip registered ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-devices-"));
    const file = join(dir, "devices.txt");
    await writeFile(
      file,
      `Device ID\tDevice Name\tDevice Platform\n${UDID_A}\tPhone\tios\n${UDID_B}\tMac\tmac\n`,
    );
    const post = vi.fn((_path: string, body: unknown) =>
      Promise.resolve({
        data: {
          type: "devices",
          id: "D2",
          attributes: (body as { data: { attributes: object } }).data
            .attributes,
        },
      }),
    );
    const client = mockClient({
      get: get(() => existing),
      post: post as unknown as AscClient["post"],
    });
    const result = await run(
      ["devices", "register", "--file", file, "--yes"],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/v1/devices", {
      data: {
        type: "devices",
        attributes: { udid: UDID_A, name: "Phone", platform: "IOS" },
      },
    });
    const output = JSON.parse(result.stdout);
    expect(output.registered).toEqual([
      { id: "D2", name: "Phone", udid: UDID_A, platform: "IOS" },
    ]);
    expect(output.alreadyRegistered).toMatchObject([{ id: "D1" }]);
  });

  it("should say which devices were registered when one fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-devices-"));
    const file = join(dir, "devices.csv");
    await writeFile(file, `${UDID_A},One\n${UDID_B},Two\n`);
    let calls = 0;
    const post = vi.fn(() => {
      calls++;
      return calls === 1
        ? Promise.resolve({
            data: { type: "devices", id: "D3", attributes: { udid: UDID_A } },
          })
        : Promise.reject(new AscApiError(409, { errors: [] }));
    });
    const client = mockClient({
      get: get(() => ({ data: [] })),
      post: post as unknown as AscClient["post"],
    });
    const result = await run(
      ["devices", "register", "--file", file, "--yes"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Registered 1 of 2 devices (${UDID_A})`);
  });

  it("should need --name and --udid or --file", async () => {
    const result = await run(["devices", "register"], mockClient());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--name and --udid");
  });
});
