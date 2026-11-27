import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient, AscQuery } from "../src/asc/client.ts";
import {
  type AscClientProvider,
  createProgram,
  type ProgramOptions,
} from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";

/** A client answering reads from `routes` (a function is called each time; unknown paths are a 404). */
function routed(routes: Record<string, unknown>) {
  let reserved = 0;
  const client: AscClient = {
    get: vi.fn((path: string, _query?: AscQuery) => {
      if (!(path in routes)) {
        return Promise.reject(new AscApiError(404, { errors: [] }));
      }
      const route = routes[path];
      return Promise.resolve(typeof route === "function" ? route() : route);
    }) as AscClient["get"],
    post: vi.fn((path: string) => {
      if (path === "/v1/backgroundAssetVersions") {
        return Promise.resolve({
          data: {
            type: "backgroundAssetVersions",
            id: "V3",
            attributes: { version: "3", state: "AWAITING_UPLOAD" },
          },
        });
      }
      reserved += 1;
      return Promise.resolve({
        data: {
          type: "backgroundAssetUploadFiles",
          id: `F${reserved}`,
          attributes: {
            uploadOperations: [
              {
                method: "PUT",
                url: "https://upload.example/1",
                offset: 0,
                length: 4,
              },
              {
                method: "PUT",
                url: "https://upload.example/2",
                offset: 4,
                length: 6,
              },
            ],
          },
        },
      });
    }) as AscClient["post"],
    patch: vi.fn(() => Promise.resolve({})) as AscClient["patch"],
    delete: vi.fn(() => Promise.reject(new Error("unexpected"))),
    upload: vi.fn(() => Promise.resolve()),
    download: vi.fn(() => Promise.reject(new Error("unexpected"))),
    downloadSigned: vi.fn(() => Promise.reject(new Error("unexpected"))),
  };
  const provider = vi.fn<AscClientProvider>(() => client);
  return { client, provider };
}

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

const pack = (archived = false) => ({
  data: {
    type: "backgroundAssets",
    id: "P1",
    attributes: { assetPackIdentifier: "levels", archived, usedBytes: 2048 },
  },
});

const version = (state: string, id = "V2", number = "2") => ({
  type: "backgroundAssetVersions",
  id,
  attributes: {
    version: number,
    state,
    platforms: ["IOS"],
    stateDetails: {
      errors:
        state === "FAILED" ? [{ code: "BAD", description: "Bad archive" }] : [],
    },
  },
  relationships: {
    internalBetaRelease: {
      data: { type: "backgroundAssetVersionInternalBetaReleases", id: "R1" },
    },
    appStoreRelease: { data: null },
  },
});

const versions = {
  data: [version("COMPLETE")],
  included: [
    {
      type: "backgroundAssetVersionInternalBetaReleases",
      id: "R1",
      attributes: { state: "READY_FOR_TESTING" },
    },
  ],
};

/** A 10-byte file in a new folder. */
async function file(name: string) {
  const dir = await mkdtemp(join(tmpdir(), "asc-background-assets-"));
  const path = join(dir, name);
  await writeFile(path, "0123456789");
  return path;
}

describe("background-assets", () => {
  it("should list packs with their newest versions and release states", async () => {
    const { client, provider } = routed({
      "/v1/apps/123/backgroundAssets": { data: [pack().data] },
      "/v1/backgroundAssets/P1/versions": versions,
    });
    const { exitCode, stdout } = await run(
      ["background-assets", "123"],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(vi.mocked(client.get).mock.calls[0]?.[1]?.["filter[archived]"]).toBe(
      "false",
    );
    expect(JSON.parse(stdout).packs).toEqual([
      {
        id: "P1",
        assetPackIdentifier: "levels",
        archived: false,
        usedBytes: 2048,
        createdDate: null,
        versions: [
          {
            id: "V2",
            version: "2",
            state: "COMPLETE",
            platforms: ["IOS"],
            locale: null,
            createdDate: null,
            errors: [],
            warnings: [],
            internalBeta: "READY_FOR_TESTING",
            externalBeta: null,
            appStore: null,
          },
        ],
      },
    ]);
  });

  it("should print the planned upload without --yes", async () => {
    const archive = await file("levels.aar");
    const { client, provider } = routed({
      "/v1/backgroundAssets/P1": pack(),
      "/v1/backgroundAssets/P1/versions": versions,
    });
    const { exitCode, stdout, stderr } = await run(
      ["background-assets", "upload", "P1", "--file", archive],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Dry run");
    expect(client.post).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toMatchObject({
      dryRun: true,
      pack: { assetPackIdentifier: "levels" },
      latestVersion: { version: "2" },
      files: [{ assetType: "ASSET", fileName: "levels.aar", fileSize: 10 }],
    });
  });

  it("should create a version, send each file's parts and commit them", async () => {
    const archive = await file("levels.aar");
    const manifest = await file("manifest.json");
    const { client, provider } = routed({
      "/v1/backgroundAssets/P1": pack(),
      "/v1/backgroundAssets/P1/versions": versions,
    });
    const { exitCode, stdout } = await run(
      [
        "background-assets",
        "upload",
        "P1",
        "--file",
        archive,
        "--manifest",
        manifest,
        "--yes",
      ],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      "/v1/backgroundAssetVersions",
      {
        data: {
          type: "backgroundAssetVersions",
          relationships: {
            backgroundAsset: { data: { type: "backgroundAssets", id: "P1" } },
          },
        },
      },
    );
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      "/v1/backgroundAssetUploadFiles",
      {
        data: {
          type: "backgroundAssetUploadFiles",
          attributes: {
            assetType: "ASSET",
            fileName: "levels.aar",
            fileSize: 10,
          },
          relationships: {
            backgroundAssetVersion: {
              data: { type: "backgroundAssetVersions", id: "V3" },
            },
          },
        },
      },
    );
    expect(vi.mocked(client.post).mock.calls[2]?.[1]).toMatchObject({
      data: {
        attributes: { assetType: "MANIFEST", fileName: "manifest.json" },
      },
    });
    // Two files, two parts each, read from the right offsets.
    expect(client.upload).toHaveBeenCalledTimes(4);
    expect(
      new TextDecoder().decode(vi.mocked(client.upload).mock.calls[1]?.[1]),
    ).toBe("456789");
    const hash = createHash("md5").update("0123456789").digest("hex");
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/backgroundAssetUploadFiles/F1",
      {
        data: {
          type: "backgroundAssetUploadFiles",
          id: "F1",
          attributes: {
            uploaded: true,
            sourceFileChecksums: { file: { hash, algorithm: "MD5" } },
          },
        },
      },
    );
    expect(JSON.parse(stdout).version).toEqual({
      id: "V3",
      version: "3",
      state: "AWAITING_UPLOAD",
    });
  });

  it("should name the new version when a part fails to send", async () => {
    const archive = await file("levels.aar");
    const { client, provider } = routed({
      "/v1/backgroundAssets/P1": pack(),
      "/v1/backgroundAssets/P1/versions": versions,
    });
    vi.mocked(client.upload).mockRejectedValueOnce(
      new AscApiError(500, { errors: [] }),
    );
    const { exitCode, stderr } = await run(
      ["background-assets", "upload", "P1", "--file", archive, "--yes"],
      provider,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Version 3 of the asset pack was created");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("should refuse an archived pack", async () => {
    const archive = await file("levels.aar");
    const { client, provider } = routed({
      "/v1/backgroundAssets/P1": pack(true),
    });
    const { exitCode, stderr } = await run(
      ["background-assets", "upload", "P1", "--file", archive, "--yes"],
      provider,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("archived");
    expect(client.post).not.toHaveBeenCalled();
  });

  /** A fake clock that sleep advances. */
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
      },
    };
  }

  it("should wait until the version finishes processing", async () => {
    const states = ["PROCESSING", "COMPLETE"];
    const { provider } = routed({
      "/v1/backgroundAssetVersions/V3": () => ({
        data: version(states.shift() ?? "COMPLETE", "V3", "3"),
      }),
    });
    const { sleeps, options } = clock();
    const { exitCode, stdout, stderr } = await run(
      ["background-assets", "wait", "V3", "--interval", "10"],
      provider,
      options,
    );
    expect(exitCode).toBe(0);
    expect(sleeps).toEqual([10_000]);
    expect(stderr).toContain("Asset pack version 3: PROCESSING");
    expect(JSON.parse(stdout)).toMatchObject({ id: "V3", state: "COMPLETE" });
  });

  it("should exit 1 when processing failed", async () => {
    const { provider } = routed({
      "/v1/backgroundAssetVersions/V3": { data: version("FAILED", "V3", "3") },
    });
    const { exitCode, stdout, stderr } = await run(
      ["background-assets", "wait", "V3"],
      provider,
      clock().options,
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).errors).toEqual([
      { code: "BAD", description: "Bad archive" },
    ]);
    expect(stderr).toContain("finished processing as FAILED");
  });

  it("should give up after the timeout", async () => {
    const { provider } = routed({
      "/v1/backgroundAssetVersions/V3": {
        data: version("PROCESSING", "V3", "3"),
      },
    });
    const { exitCode, stderr } = await run(
      ["background-assets", "wait", "V3", "--timeout", "1", "--interval", "30"],
      provider,
      clock().options,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("still PROCESSING after 1 minute");
  });
});
