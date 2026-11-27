import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";

/** A client whose methods fail unless a test gives them an implementation. */
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

/** Answers GETs by path; anything else rejects. */
function getByPath(responses: Record<string, unknown>): AscClient["get"] {
  return vi.fn((path: string) =>
    path in responses
      ? responses[path] instanceof Error
        ? Promise.reject(responses[path])
        : Promise.resolve(responses[path])
      : Promise.reject(new Error(`unexpected GET ${path}`)),
  ) as AscClient["get"];
}

/** Runs the CLI, capturing stdout, stderr and the exit code. */
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
    .parseAsync(["alt-distribution", ...args], { from: "user" })
    .then(() => 0)
    .catch((error: { exitCode?: number }) => error.exitCode ?? 1);
  const stdout = vi
    .mocked(console.log)
    .mock.calls.map(([text]) => text)
    .join("\n");
  return { exitCode, stdout, stderr };
}

const workdir = () => mkdtemp(join(tmpdir(), "asc-alt-distribution-"));
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const forbidden = new AscApiError(403, {
  errors: [{ code: "FORBIDDEN_ERROR", detail: "This request is forbidden." }],
});
const notFound = new AscApiError(404, { errors: [{ code: "NOT_FOUND" }] });

const PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsecretlookingkey==";
const SIGNED_URL = "https://download.example.apple.com/pkg?signature=SIGNED";
const KEY_BLOB = "S0VZQkxPQg==";

const key = {
  type: "alternativeDistributionKeys",
  id: "KEY1",
  attributes: { publicKey: PUBLIC_KEY },
};

const packageVersion = {
  type: "alternativeDistributionPackageVersions",
  id: "PV1",
  attributes: {
    version: "1.0 (42)",
    state: "COMPLETED",
    fileChecksum: "abc",
    url: SIGNED_URL,
    urlExpirationDate: "2026-11-28T00:00:00Z",
  },
  relationships: {
    variants: {
      data: [{ type: "alternativeDistributionPackageVariants", id: "VAR1" }],
    },
    deltas: { data: [] },
  },
};

const variant = {
  type: "alternativeDistributionPackageVariants",
  id: "VAR1",
  attributes: {
    url: SIGNED_URL,
    urlExpirationDate: "2026-11-28T00:00:00Z",
    alternativeDistributionKeyBlob: KEY_BLOB,
    fileChecksum: "def",
  },
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("alt-distribution keys", () => {
  it("should list keys with a fingerprint and never the public key", async () => {
    const client = mockClient({
      get: vi.fn(() =>
        Promise.resolve({ data: [key], links: { self: "x" } }),
      ) as AscClient["get"],
    });
    const result = await run(["keys", "--scope", "account"], client);
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith("/v1/alternativeDistributionKeys", {
      "fields[alternativeDistributionKeys]": ["publicKey"],
      "exists[app]": false,
      limit: 50,
    });
    const output = JSON.parse(result.stdout);
    expect(output.keys[0].id).toBe("KEY1");
    expect(output.keys[0].publicKeyFingerprint).toMatch(
      /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/,
    );
    expect(result.stdout).not.toContain(PUBLIC_KEY);
  });

  it("should read an app's key and show none when Apple answers 404", async () => {
    const client = mockClient({
      get: getByPath({ "/v1/apps/123/alternativeDistributionKey": notFound }),
    });
    const result = await run(["keys", "--app", "123"], client);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ appId: "123", key: null });
  });

  it("should explain the EU entitlement when Apple answers 403", async () => {
    const client = mockClient({
      get: vi.fn(() => Promise.reject(forbidden)) as AscClient["get"],
    });
    const result = await run(["keys"], client);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[permission]");
    expect(result.stderr).toContain("EU alternative distribution entitlement");
  });

  it("should export the public key only to a new file", async () => {
    const dir = await workdir();
    const out = join(dir, "key.pem");
    const client = mockClient({
      get: getByPath({ "/v1/alternativeDistributionKeys/KEY1": { data: key } }),
    });
    const result = await run(["keys", "export", "KEY1", "--out", out], client);
    expect(result.exitCode).toBe(0);
    expect(await readFile(out, "utf8")).toBe(`${PUBLIC_KEY}\n`);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(result.stdout).not.toContain(PUBLIC_KEY);

    const again = await run(["keys", "export", "KEY1", "--out", out], client);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("already exists");
  });

  it("should plan a key without --yes and create it with --yes", async () => {
    const dir = await workdir();
    const file = join(dir, "public.pem");
    await writeFile(file, `${PUBLIC_KEY}\n`);
    const get = getByPath({
      "/v1/apps/123/alternativeDistributionKey": notFound,
    });
    const post = vi.fn(() =>
      Promise.resolve({ data: key }),
    ) as AscClient["post"];
    const client = mockClient({ get, post });

    const dry = await run(
      ["keys", "create", "--public-key-file", file, "--app", "123"],
      client,
    );
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout).dryRun).toBe(true);
    expect(dry.stderr).toContain("Dry run");
    expect(post).not.toHaveBeenCalled();

    vi.mocked(console.log).mockClear();
    const real = await run(
      ["keys", "create", "--public-key-file", file, "--app", "123", "--yes"],
      client,
    );
    expect(real.exitCode).toBe(0);
    expect(post).toHaveBeenCalledWith("/v1/alternativeDistributionKeys", {
      data: {
        type: "alternativeDistributionKeys",
        attributes: { publicKey: PUBLIC_KEY },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
    expect(real.stdout).not.toContain(PUBLIC_KEY);
  });

  it("should refuse a second key for an app", async () => {
    const dir = await workdir();
    const file = join(dir, "public.pem");
    await writeFile(file, PUBLIC_KEY);
    const client = mockClient({
      get: getByPath({
        "/v1/apps/123/alternativeDistributionKey": { data: key },
      }),
    });
    const result = await run(
      ["keys", "create", "--public-key-file", file, "--app", "123", "--yes"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already has alternative distribution key");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should delete a key only with --yes", async () => {
    const del = vi.fn(() => Promise.resolve()) as AscClient["delete"];
    const client = mockClient({
      get: getByPath({ "/v1/alternativeDistributionKeys/KEY1": { data: key } }),
      delete: del,
    });
    await run(["keys", "delete", "KEY1"], client);
    expect(del).not.toHaveBeenCalled();
    const result = await run(["keys", "delete", "KEY1", "--yes"], client);
    expect(result.exitCode).toBe(0);
    expect(del).toHaveBeenCalledWith("/v1/alternativeDistributionKeys/KEY1");
  });
});

describe("alt-distribution packages", () => {
  it("should show a version's package without download URLs", async () => {
    const client = mockClient({
      get: getByPath({
        "/v1/appStoreVersions/V1/alternativeDistributionPackage": {
          data: {
            type: "alternativeDistributionPackages",
            id: "PKG1",
            attributes: { sourceFileChecksum: null },
          },
          included: [packageVersion],
        },
      }),
    });
    const result = await run(["package", "V1"], client);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.package.id).toBe("PKG1");
    expect(output.package.versions[0]).toEqual({
      id: "PV1",
      version: "1.0 (42)",
      state: "COMPLETED",
      fileChecksum: "abc",
      downloadable: true,
      urlExpirationDate: "2026-11-28T00:00:00Z",
    });
    expect(result.stdout).not.toContain("SIGNED");
  });

  it("should list package versions with variants, never URLs or key blobs", async () => {
    const client = mockClient({
      get: vi.fn(() =>
        Promise.resolve({ data: [packageVersion], included: [variant] }),
      ) as AscClient["get"],
    });
    const result = await run(
      ["package-versions", "PKG1", "--state", "COMPLETED"],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/alternativeDistributionPackages/PKG1/versions",
      expect.objectContaining({
        "filter[state]": "COMPLETED",
        include: ["variants", "deltas"],
      }),
    );
    const output = JSON.parse(result.stdout);
    expect(output.versions[0].variants).toEqual([
      {
        id: "VAR1",
        fileChecksum: "def",
        downloadable: true,
        urlExpirationDate: "2026-11-28T00:00:00Z",
        hasKeyBlob: true,
      },
    ]);
    expect(result.stdout).not.toContain("SIGNED");
    expect(result.stdout).not.toContain(KEY_BLOB);
  });

  it("should request a package only when the version has none", async () => {
    const post = vi.fn(() =>
      Promise.resolve({ data: { type: "x", id: "PKG2" } }),
    ) as AscClient["post"];
    const client = mockClient({
      get: getByPath({
        "/v1/appStoreVersions/V1/alternativeDistributionPackage": notFound,
      }),
      post,
    });
    const dry = await run(["package", "request", "V1"], client);
    expect(dry.exitCode).toBe(0);
    expect(post).not.toHaveBeenCalled();
    const real = await run(["package", "request", "V1", "--yes"], client);
    expect(real.exitCode).toBe(0);
    expect(post).toHaveBeenCalledWith("/v1/alternativeDistributionPackages", {
      data: {
        type: "alternativeDistributionPackages",
        relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } },
        },
      },
    });
  });

  it("should download a variant and its key blob to new files", async () => {
    const dir = await workdir();
    const out = join(dir, "app.zip");
    const blobOut = join(dir, "blob.txt");
    const downloadSigned = vi.fn(() =>
      Promise.resolve(new Uint8Array([1, 2, 3])),
    ) as AscClient["downloadSigned"];
    const client = mockClient({
      get: getByPath({
        "/v1/alternativeDistributionPackageVersions/PV1/variants": {
          data: [variant],
        },
      }),
      downloadSigned,
    });
    const result = await run(
      [
        "download",
        "PV1",
        "--variant",
        "VAR1",
        "--out",
        out,
        "--key-blob-out",
        blobOut,
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(downloadSigned).toHaveBeenCalledWith(SIGNED_URL);
    expect([...(await readFile(out))]).toEqual([1, 2, 3]);
    expect(await readFile(blobOut, "utf8")).toBe(`${KEY_BLOB}\n`);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(result.stdout).not.toContain("SIGNED");
    expect(result.stdout).not.toContain(KEY_BLOB);
    expect(JSON.parse(result.stdout).bytes).toBe(3);
  });

  it("should refuse a variant of another package version", async () => {
    const dir = await workdir();
    const out = join(dir, "app.zip");
    const client = mockClient({
      get: getByPath({
        "/v1/alternativeDistributionPackageVersions/PV1/variants": {
          data: [],
        },
      }),
    });
    const result = await run(
      ["download", "PV1", "--variant", "VAR1", "--out", out],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found]");
    expect(await exists(out)).toBe(false);
  });
});

describe("alt-distribution marketplace", () => {
  it("should create search details when there are none", async () => {
    const post = vi.fn(() => Promise.resolve({})) as AscClient["post"];
    const client = mockClient({
      get: getByPath({ "/v1/apps/123/marketplaceSearchDetail": notFound }),
      post,
    });
    const result = await run(
      [
        "marketplace",
        "set",
        "123",
        "--catalog-url",
        "https://example.com/catalog",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(post).toHaveBeenCalledWith("/v1/marketplaceSearchDetails", {
      data: {
        type: "marketplaceSearchDetails",
        attributes: { catalogUrl: "https://example.com/catalog" },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
  });

  it("should patch existing search details and refuse http URLs", async () => {
    const patch = vi.fn(() => Promise.resolve({})) as AscClient["patch"];
    const client = mockClient({
      get: getByPath({
        "/v1/apps/123/marketplaceSearchDetail": {
          data: {
            type: "marketplaceSearchDetails",
            id: "MSD1",
            attributes: { catalogUrl: "https://example.com/old" },
          },
        },
      }),
      patch,
    });
    const bad = await run(
      ["marketplace", "set", "123", "--catalog-url", "http://example.com"],
      client,
    );
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("[invalid_input]");

    const result = await run(
      [
        "marketplace",
        "set",
        "123",
        "--catalog-url",
        "https://example.com/new",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(patch).toHaveBeenCalledWith("/v1/marketplaceSearchDetails/MSD1", {
      data: {
        type: "marketplaceSearchDetails",
        id: "MSD1",
        attributes: { catalogUrl: "https://example.com/new" },
      },
    });
  });
});

describe("alt-distribution webhooks", () => {
  it("should create a webhook with a secret from a file, never printing it", async () => {
    const dir = await workdir();
    const secretFile = join(dir, "secret");
    await writeFile(secretFile, "hunter2-secret\n");
    const post = vi.fn(() =>
      Promise.resolve({
        data: {
          type: "marketplaceWebhooks",
          id: "WH1",
          attributes: { endpointUrl: "https://example.com/hook" },
        },
      }),
    ) as AscClient["post"];
    const client = mockClient({ post });
    const args = [
      "webhooks",
      "create",
      "--endpoint-url",
      "https://example.com/hook",
      "--secret-file",
      secretFile,
    ];
    const dry = await run(args, client);
    expect(dry.exitCode).toBe(0);
    expect(post).not.toHaveBeenCalled();
    const result = await run([...args, "--yes"], client);
    expect(result.exitCode).toBe(0);
    expect(post).toHaveBeenCalledWith("/v1/marketplaceWebhooks", {
      data: {
        type: "marketplaceWebhooks",
        attributes: {
          endpointUrl: "https://example.com/hook",
          secret: "hunter2-secret",
        },
      },
    });
    expect(result.stdout + dry.stdout).not.toContain("hunter2");
  });

  it("should fail when the webhook to delete does not exist", async () => {
    const client = mockClient({
      get: getByPath({ "/v1/marketplaceWebhooks": { data: [] } }),
    });
    const result = await run(["webhooks", "delete", "WH9", "--yes"], client);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[not_found]");
    expect(client.delete).not.toHaveBeenCalled();
  });
});
