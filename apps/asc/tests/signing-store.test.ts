import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { decryptFile, encryptFile } from "../src/asc/store.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";

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
  vi.mocked(console.log).mockClear();
  return { exitCode, stdout, stderr };
}

const PASSPHRASE = "correct horse battery staple";
const FAST = { logN: 14, r: 8, p: 1 };
const LATER = new Date(Date.now() + 300 * 86_400_000).toISOString();

/** An empty bare repository as the store's remote. */
async function bareRepository() {
  const dir = await mkdtemp(join(tmpdir(), "asc-store-remote-"));
  execFileSync("git", ["init", "--quiet", "--bare", dir]);
  return dir;
}

function storeFiles(remote: string): string[] {
  return execFileSync(
    "git",
    ["--git-dir", remote, "ls-tree", "-r", "--name-only", "HEAD"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("ASC_SIGNING_PASSPHRASE", PASSPHRASE);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("store encryption", () => {
  it("should round-trip and bind the file to its path", async () => {
    const data = new TextEncoder().encode("secret contents");
    const sealed = await encryptFile(PASSPHRASE, "certs/a.key.enc", data, FAST);
    expect(sealed.subarray(0, 5)).toEqual(Buffer.from("ASCS\x01", "latin1"));
    expect(sealed.includes(Buffer.from("secret contents"))).toBe(false);
    expect(
      (await decryptFile(PASSPHRASE, "certs/a.key.enc", sealed)).toString(),
    ).toBe("secret contents");
    await expect(
      decryptFile(PASSPHRASE, "certs/b.key.enc", sealed),
    ).rejects.toThrow("passphrase is wrong or the file was changed");
    await expect(
      decryptFile("another passphrase", "certs/a.key.enc", sealed),
    ).rejects.toThrow("passphrase is wrong");
  });

  it("should refuse an unknown version and tampered parameters", async () => {
    const sealed = await encryptFile(
      PASSPHRASE,
      "x",
      new Uint8Array([1]),
      FAST,
    );
    const newer = Buffer.from(sealed);
    newer[4] = 2;
    await expect(decryptFile(PASSPHRASE, "x", newer)).rejects.toThrow(
      "format version 2",
    );
    const greedy = Buffer.from(sealed);
    greedy[5] = 30;
    await expect(decryptFile(PASSPHRASE, "x", greedy)).rejects.toThrow(
      "passphrase is wrong",
    );
  });
});

const certificateResponse = {
  data: {
    type: "certificates",
    id: "CERT1",
    attributes: {
      certificateType: "DISTRIBUTION",
      expirationDate: LATER,
      certificateContent: "AAEC",
    },
  },
};

const profileResponse = {
  data: {
    type: "profiles",
    id: "PROF1",
    attributes: {
      name: "asc IOS_APP_STORE com.example.app",
      profileType: "IOS_APP_STORE",
      profileState: "ACTIVE",
      uuid: "UUID-1",
      expirationDate: LATER,
      profileContent: btoa("profile bytes"),
    },
  },
};

/** Answers the reads a sync makes against a store holding CERT1 and PROF1. */
function appleWith(options: { profileCertificate?: string } = {}) {
  return vi.fn((path: string) => {
    if (path === "/v1/certificates/CERT1") {
      return Promise.resolve(certificateResponse);
    }
    if (path === "/v1/profiles/PROF1") {
      return Promise.resolve({
        data: {
          ...profileResponse.data,
          relationships: {
            certificates: {
              data: [
                {
                  type: "certificates",
                  id: options.profileCertificate ?? "CERT1",
                },
              ],
            },
          },
        },
      });
    }
    if (path === "/v1/bundleIds") {
      return Promise.resolve({
        data: [
          {
            type: "bundleIds",
            id: "B1",
            attributes: { identifier: "com.example.app" },
          },
        ],
      });
    }
    if (path === "/v1/profiles") return Promise.resolve({ data: [] });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }) as unknown as AscClient["get"];
}

const syncArgs = (remote: string, ...extra: string[]) => [
  "signing",
  "sync",
  "--git-url",
  remote,
  "--type",
  "DISTRIBUTION",
  "--profile-type",
  "IOS_APP_STORE",
  "--bundle-id",
  "com.example.app",
  ...extra,
];

describe("signing sync", () => {
  it("should plan without creating or storing anything", async () => {
    const remote = await bareRepository();
    const client = mockClient({ get: appleWith() });
    const result = await run(syncArgs(remote), client);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      certificate: { type: "DISTRIBUTION", status: "create" },
      profiles: [{ identifier: "com.example.app", status: "create" }],
    });
    expect(client.post).not.toHaveBeenCalled();
    expect(result.stderr).toContain("Dry run");
  });

  it("should create, store only encrypted files and fetch them on another machine", {
    timeout: 30_000,
  }, async () => {
    const remote = await bareRepository();
    const post = vi.fn((path: string) =>
      Promise.resolve(
        path === "/v1/certificates" ? certificateResponse : profileResponse,
      ),
    );
    const out = join(await mkdtemp(join(tmpdir(), "asc-out-")), "signing");
    const client = mockClient({
      get: appleWith(),
      post: post as unknown as AscClient["post"],
    });
    const created = await run(
      syncArgs(remote, "--out-dir", out, "--yes"),
      client,
    );
    expect(created.stderr).toBe("");
    expect(created.exitCode).toBe(0);
    const output = JSON.parse(created.stdout);
    expect(output).toMatchObject({
      dryRun: false,
      committed: true,
      certificate: { id: "CERT1", status: "created" },
      profiles: [{ id: "PROF1", status: "created" }],
    });
    expect(storeFiles(remote)).toEqual([
      "certs/DISTRIBUTION/CERT1.cer.enc",
      "certs/DISTRIBUTION/CERT1.key.enc",
      "profiles/IOS_APP_STORE/com.example.app/PROF1.mobileprovision.enc",
    ]);
    const key = await readFile(join(out, "CERT1.key"), "utf8");
    expect(key).toContain("PRIVATE KEY");
    expect((await stat(join(out, "CERT1.key"))).mode & 0o777).toBe(0o600);
    expect(created.stdout).not.toContain(key.split("\n")[1]);
    expect(created.stdout).not.toContain(PASSPHRASE);

    // A CI machine: read only, nothing created.
    const ciOut = await mkdtemp(join(tmpdir(), "asc-ci-"));
    const ciClient = mockClient({ get: appleWith() });
    const fetched = await run(
      syncArgs(remote, "--out-dir", ciOut, "--readonly"),
      ciClient,
    );
    expect(fetched.exitCode).toBe(0);
    expect(JSON.parse(fetched.stdout)).toMatchObject({
      dryRun: false,
      certificate: { id: "CERT1", status: "current" },
      profiles: [{ id: "PROF1", status: "current" }],
    });
    expect(ciClient.post).not.toHaveBeenCalled();
    expect(await readFile(join(ciOut, "CERT1.key"), "utf8")).toBe(key);
    expect(
      await readFile(
        join(ciOut, "com.example.app.IOS_APP_STORE.mobileprovision"),
        "utf8",
      ),
    ).toBe("profile bytes");

    // The wrong passphrase cannot read the store.
    vi.stubEnv("ASC_SIGNING_PASSPHRASE", "not the passphrase at all");
    const wrong = await run(syncArgs(remote, "--readonly"), ciClient);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toContain("[invalid_input]");
    expect(wrong.stderr).toContain("passphrase is wrong");
  });

  it("should fail read only when the store has nothing usable", async () => {
    const remote = await bareRepository();
    const client = mockClient({ get: appleWith() });
    const result = await run(syncArgs(remote, "--readonly"), client);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no DISTRIBUTION certificate");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should need the passphrase", async () => {
    vi.stubEnv("ASC_SIGNING_PASSPHRASE", "");
    const result = await run(syncArgs("unused"), mockClient());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ASC_SIGNING_PASSPHRASE");
  });

  it("should not print credentials in a repository URL", async () => {
    const result = await run(
      syncArgs("https://user:s3cret-token@127.0.0.1:1/store.git"),
      mockClient(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git clone failed");
    expect(result.stderr).not.toContain("s3cret-token");
  });
});

describe("signing nuke", () => {
  it("should list, then revoke, delete and remove from the store", async () => {
    const remote = await bareRepository();
    const post = vi.fn((path: string) =>
      Promise.resolve(
        path === "/v1/certificates" ? certificateResponse : profileResponse,
      ),
    );
    await run(
      syncArgs(remote, "--yes"),
      mockClient({
        get: appleWith(),
        post: post as unknown as AscClient["post"],
      }),
    );
    const get = vi.fn((path: string) =>
      Promise.resolve(
        path === "/v1/certificates"
          ? { data: [certificateResponse.data] }
          : { data: [profileResponse.data] },
      ),
    ) as unknown as AscClient["get"];
    const del = vi.fn(() => Promise.resolve(undefined));
    const client = mockClient({
      get,
      delete: del as unknown as AscClient["delete"],
    });
    const args = [
      "signing",
      "nuke",
      "--git-url",
      remote,
      "--type",
      "DISTRIBUTION",
      "--profile-type",
      "IOS_APP_STORE",
    ];
    const dry = await run(args, client);
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      dryRun: true,
      certificates: [{ id: "CERT1" }],
      profiles: [{ id: "PROF1" }],
    });
    expect(JSON.parse(dry.stdout).warning).toContain("cannot be undone");
    expect(del).not.toHaveBeenCalled();

    const done = await run([...args, "--yes"], client);
    expect(done.exitCode).toBe(0);
    expect(del).toHaveBeenCalledWith("/v1/profiles/PROF1");
    expect(del).toHaveBeenCalledWith("/v1/certificates/CERT1");
    expect(storeFiles(remote)).toEqual([]);
  }, 30_000);
});
