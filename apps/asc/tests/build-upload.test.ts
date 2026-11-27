import { createHash } from "node:crypto";
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

/** Runs the CLI, capturing stdout, stderr and the exit code. */
async function run(
  args: string[],
  provider: AscClientProvider,
  options?: ProgramOptions,
) {
  let stderr = "";
  const program = createProgram(provider, options);
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

describe("builds upload", () => {
  // 10 bytes, sent in the two parts the reservation lists.
  const content = "0123456789";

  async function binary(name = "App.ipa") {
    const dir = await mkdtemp(join(tmpdir(), "asc-build-upload-"));
    const file = join(dir, name);
    await writeFile(file, content);
    return file;
  }

  /** A builds page; `existing` adds a build of 1.2.0 (42) on iOS. */
  function builds(existing = false) {
    return {
      data: existing
        ? [
            {
              type: "builds",
              id: "B0",
              attributes: { version: "42" },
              relationships: {
                preReleaseVersion: {
                  data: { type: "preReleaseVersions", id: "P1" },
                },
              },
            },
          ]
        : [],
      included: existing
        ? [
            {
              type: "preReleaseVersions",
              id: "P1",
              attributes: { version: "1.2.0", platform: "IOS" },
            },
          ]
        : [],
      links: { self: "x" },
    };
  }

  function uploadClient({
    existing = false,
    processingState = "VALID",
  }: {
    existing?: boolean;
    processingState?: string;
  } = {}) {
    const client: AscClient = {
      get: vi.fn(async (path: string) => {
        if (path === "/v1/apps/123") {
          return {
            data: {
              type: "apps",
              id: "123",
              attributes: { name: "Demo", bundleId: "com.example.demo" },
            },
          };
        }
        if (path === "/v1/builds") {
          return processingState && vi.mocked(client.post).mock.calls.length
            ? {
                data: [
                  {
                    type: "builds",
                    id: "B1",
                    attributes: { version: "42", processingState },
                  },
                ],
                links: { self: "x" },
              }
            : builds(existing);
        }
        if (path === "/v1/buildUploads/U1") {
          return {
            data: {
              type: "buildUploads",
              id: "U1",
              attributes: {
                cfBundleShortVersionString: "1.2.0",
                cfBundleVersion: "42",
                platform: "IOS",
                state: { state: "PROCESSING", errors: [], warnings: [] },
              },
            },
          };
        }
        throw new Error(`unexpected GET ${path}`);
      }) as AscClient["get"],
      post: vi.fn(async (path: string) => {
        if (path === "/v1/buildUploads") {
          return { data: { type: "buildUploads", id: "U1" } };
        }
        return {
          data: {
            type: "buildUploadFiles",
            id: "F1",
            attributes: {
              uploadOperations: [
                {
                  method: "PUT",
                  url: "https://upload.example/1",
                  offset: 0,
                  length: 6,
                  requestHeaders: [],
                },
                {
                  method: "PUT",
                  url: "https://upload.example/2",
                  offset: 6,
                  length: 4,
                  requestHeaders: [],
                },
              ],
            },
          },
        };
      }) as AscClient["post"],
      patch: vi.fn(async () => ({})) as AscClient["patch"],
      delete: vi.fn(async () => {}) as AscClient["delete"],
      upload: vi.fn(async () => {}) as AscClient["upload"],
    };
    return { client, provider: vi.fn<AscClientProvider>(() => client) };
  }

  const args = (file: string) => [
    "builds",
    "upload",
    "123",
    "--file",
    file,
    "--app-version",
    "1.2.0",
    "--build-number",
    "42",
  ];

  it("should show what would be uploaded without --yes", async () => {
    const { client, provider } = uploadClient();
    const file = await binary();
    const result = await run(args(file), provider);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Dry run");
    expect(client.post).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "upload",
      app: { id: "123", name: "Demo", bundleId: "com.example.demo" },
      version: "1.2.0",
      buildNumber: "42",
      platform: "IOS",
      file: { fileName: "App.ipa", fileSize: 10, uti: "com.apple.ipa" },
    });
  });

  it("should create the upload, send the parts and commit the checksum with --yes", async () => {
    const { client, provider } = uploadClient();
    const file = await binary();
    const result = await run([...args(file), "--yes"], provider);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/buildUploads", {
      data: {
        type: "buildUploads",
        attributes: {
          cfBundleShortVersionString: "1.2.0",
          cfBundleVersion: "42",
          platform: "IOS",
        },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
    expect(client.post).toHaveBeenCalledWith("/v1/buildUploadFiles", {
      data: {
        type: "buildUploadFiles",
        attributes: {
          assetType: "ASSET",
          fileName: "App.ipa",
          fileSize: 10,
          uti: "com.apple.ipa",
        },
        relationships: {
          buildUpload: { data: { type: "buildUploads", id: "U1" } },
        },
      },
    });
    // Every byte goes up once, in the parts Apple asked for, to Apple's URLs.
    const parts = vi.mocked(client.upload).mock.calls;
    expect(parts.map(([operation]) => operation.url)).toEqual([
      "https://upload.example/1",
      "https://upload.example/2",
    ]);
    expect(Buffer.concat(parts.map(([, part]) => part)).toString()).toBe(
      content,
    );
    expect(client.patch).toHaveBeenCalledWith("/v1/buildUploadFiles/F1", {
      data: {
        type: "buildUploadFiles",
        id: "F1",
        attributes: {
          uploaded: true,
          sourceFileChecksums: {
            file: {
              hash: createHash("md5").update(content).digest("hex"),
              algorithm: "MD5",
            },
          },
        },
      },
    });
    const output = JSON.parse(result.stdout);
    expect(output.dryRun).toBe(false);
    expect(output.upload).toMatchObject({
      id: "U1",
      state: "PROCESSING",
      buildNumber: "42",
    });
  });

  it("should wait for the build with --wait and exit 1 when it is invalid", async () => {
    const { provider } = uploadClient({ processingState: "INVALID" });
    const file = await binary();
    const result = await run([...args(file), "--yes", "--wait"], provider, {
      sleep: async () => {},
      now: () => 0,
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).build).toMatchObject({
      id: "B1",
      processingState: "INVALID",
    });
    expect(result.stderr).toContain("finished processing as INVALID");
  });

  it("should refuse a build number the version already has", async () => {
    const { client, provider } = uploadClient({ existing: true });
    const result = await run([...args(await binary()), "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("already has build 42");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should refuse a file that is not an .ipa or .pkg, or the wrong platform", async () => {
    const cases: [string, string[], string][] = [
      ["App.zip", [], "not an .ipa or .pkg"],
      ["App.pkg", ["--platform", "IOS"], "not a IOS build"],
      ["App.ipa", ["--platform", "MAC_OS"], "not a MAC_OS build"],
    ];
    for (const [name, extra, message] of cases) {
      const { client, provider } = uploadClient();
      const result = await run(
        [...args(await binary(name)), ...extra, "--yes"],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
      expect(client.post).not.toHaveBeenCalled();
    }
  });

  it("should name the build upload when sending a part fails", async () => {
    const { client, provider } = uploadClient();
    vi.mocked(client.upload).mockRejectedValueOnce(new TypeError("boom"));
    const result = await run([...args(await binary()), "--yes"], provider);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("U1");
    expect(client.patch).not.toHaveBeenCalled();
  });
});
