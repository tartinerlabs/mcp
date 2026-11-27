import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { createProgram, type ProgramOptions } from "../src/cli.ts";

/** Runs the CLI, capturing stdout, stderr and the exit code. */
async function run(
  args: string[],
  client: AscClient,
  options: ProgramOptions = {},
) {
  let stderr = "";
  const program = createProgram(() => client, options);
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

let dir: string;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "asc-metadata-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const noFetch = vi.fn(() => Promise.reject(new Error("unexpected fetch")));
const NOW = Date.UTC(2026, 10, 27);
const options = { fetch: noFetch as unknown as typeof fetch, now: () => NOW };

interface Setup {
  versionState?: string;
  appInfoState?: string;
  placements?: {
    id: string;
    type?: string;
    group: string;
    fileName: string;
  }[];
}

/** App 123 with version V1 (en-US only) and app info AI1 (en-US). */
function listingClient({
  versionState = "PREPARE_FOR_SUBMISSION",
  appInfoState = "PREPARE_FOR_SUBMISSION",
  placements = [],
}: Setup = {}) {
  let next = 0;
  const get = vi.fn((path: string) => {
    const body = ((): unknown => {
      switch (path) {
        case "/v1/apps/123/appStoreVersions":
          return {
            data: [
              {
                type: "appStoreVersions",
                id: "V0",
                attributes: { appVersionState: "READY_FOR_DISTRIBUTION" },
              },
              {
                type: "appStoreVersions",
                id: "V1",
                attributes: { appVersionState: versionState },
              },
            ],
          };
        case "/v1/appStoreVersions/V1":
          return {
            data: {
              type: "appStoreVersions",
              id: "V1",
              attributes: {
                versionString: "2.0",
                platform: "IOS",
                appVersionState: versionState,
                copyright: "2025 Example Ltd",
              },
            },
          };
        case "/v1/apps/123/appInfos":
          return {
            data: [
              {
                type: "appInfos",
                id: "AI1",
                attributes: { state: appInfoState },
              },
            ],
          };
        case "/v1/appStoreVersions/V1/appStoreVersionLocalizations":
          return {
            data: [
              {
                type: "appStoreVersionLocalizations",
                id: "VL1",
                attributes: {
                  locale: "en-US",
                  description: "A puzzle game.",
                  keywords: "puzzle,game",
                  promotionalText: "Play now",
                  whatsNew: "Fixes",
                  supportUrl: "https://example.com/support",
                  marketingUrl: null,
                },
              },
            ],
          };
        case "/v1/appInfos/AI1/appInfoLocalizations":
          return {
            data: [
              {
                type: "appInfoLocalizations",
                id: "IL1",
                attributes: {
                  locale: "en-US",
                  name: "Puzzler",
                  subtitle: "Brain teasers",
                  privacyPolicyUrl: "https://example.com/privacy",
                },
              },
            ],
          };
        case "/v1/appStoreVersionLocalizations/VL1/placements":
          return {
            data: placements.map(({ id, type, group }) => ({
              type: "appAssetLibraryPlacements",
              id,
              attributes: {
                placementType: type ?? "APP_SCREENSHOT",
                placementGroup: group,
              },
              relationships: {
                image: {
                  data: { type: "appAssetLibraryImages", id: `I${id}` },
                },
              },
            })),
            included: placements.map(({ id, fileName }) => ({
              type: "appAssetLibraryImages",
              id: `I${id}`,
              attributes: {
                fileName,
                state: "COMPLETE",
                imageAsset: {
                  templateUrl: `https://is1.example.com/${id}/{w}x{h}bb.{f}`,
                  width: 1290,
                  height: 2796,
                },
              },
            })),
          };
        case "/v1/appAssetLibraryRefData":
          return {
            data: [
              {
                type: "appAssetLibraryRefData",
                id: "R",
                attributes: {
                  placementTypes: [
                    {
                      placementTypeId: "APP_SCREENSHOT",
                      specMappings: [
                        { placementGroupId: "IPHONE_67", specs: [] },
                      ],
                    },
                  ],
                  features: [
                    {
                      featureId: "APP_STORE_VERSIONS",
                      placementPolicies: [
                        {
                          placementType: "APP_SCREENSHOT",
                          groupLimits: [
                            { groupIds: ["IPHONE_67"], maxCount: 3 },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          };
        case "/v1/apps/123/assetLibrary":
          return { data: { type: "appAssetLibraries", id: "LIB" } };
        default:
          throw new Error(`unexpected GET ${path}`);
      }
    })();
    return Promise.resolve(body);
  });
  const post = vi.fn((path: string) => {
    next += 1;
    if (path === "/v1/appAssetLibraryImages") {
      return Promise.resolve({
        data: {
          type: "appAssetLibraryImages",
          id: `IMG${next}`,
          attributes: {
            uploadOperations: [
              {
                method: "PUT",
                url: "https://upload.example.com",
                offset: 0,
                length: 3,
              },
            ],
          },
        },
      });
    }
    return Promise.resolve({ data: { type: "x", id: `NEW${next}` } });
  });
  const client = {
    get,
    post,
    patch: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(() => Promise.resolve(undefined)),
    upload: vi.fn(() => Promise.resolve()),
    download: vi.fn(() => Promise.reject(new Error("unexpected download"))),
    downloadSigned: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]))),
  } as unknown as AscClient;
  return { client, get, post };
}

async function writeListing(
  fields: Record<string, unknown>,
  copyright = "2026 Example Ltd",
  files: string[] = [],
) {
  await writeFile(join(dir, "version.json"), JSON.stringify({ copyright }));
  for (const [locale, values] of Object.entries(fields)) {
    await mkdir(join(dir, locale), { recursive: true });
    await writeFile(join(dir, locale, "metadata.json"), JSON.stringify(values));
  }
  for (const file of files) {
    await writeFile(join(dir, file), new Uint8Array([1, 2, 3]));
  }
}

describe("metadata pull", () => {
  it("writes the editable version's listing and screenshots into a new folder", async () => {
    const { client } = listingClient({
      placements: [
        { id: "P1", group: "IPHONE_67", fileName: "home.png" },
        { id: "P2", group: "IPHONE_67", fileName: "IPHONE_67-02-list.png" },
      ],
    });
    const out = join(dir, "listing");
    const result = await run(
      ["metadata", "pull", "123", "--dir", out],
      client,
      options,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: { id: "V1" },
      appInfo: { id: "AI1" },
      locales: ["en-US"],
      files: ["en-US/IPHONE_67-01-home.png", "en-US/IPHONE_67-02-list.png"],
    });
    expect(
      JSON.parse(await readFile(join(out, "version.json"), "utf8")),
    ).toEqual({
      copyright: "2025 Example Ltd",
    });
    expect(
      JSON.parse(await readFile(join(out, "en-US", "metadata.json"), "utf8")),
    ).toMatchObject({
      name: "Puzzler",
      description: "A puzzle game.",
      marketingUrl: null,
      privacyChoicesUrl: null,
    });
    expect(client.downloadSigned).toHaveBeenCalledWith(
      "https://is1.example.com/P1/1290x2796bb.png",
    );
  });

  it("refuses a folder that is not empty", async () => {
    await writeFile(join(dir, "old.txt"), "x");
    const { client } = listingClient();
    const result = await run(
      ["metadata", "pull", "123", "--dir", dir],
      client,
      options,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("not empty");
  });
});

describe("metadata push", () => {
  it("plans only the differences and writes nothing without --yes", async () => {
    await writeListing(
      {
        "en-US": {
          description: "A better puzzle game.",
          keywords: "puzzle,game",
          marketingUrl: "https://example.com",
          subtitle: null,
        },
        "fr-FR": { name: "Puzzleur", description: "Un jeu." },
      },
      "2026 Example Ltd",
      ["en-US/IPHONE_67-01-home.png", "en-US/IPHONE_67-02-new.png"],
    );
    const { client } = listingClient({
      placements: [{ id: "P1", group: "IPHONE_67", fileName: "home.png" }],
    });
    const result = await run(
      ["metadata", "push", "123", dir, "--no-url-check"],
      client,
      options,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Dry run");
    const output = JSON.parse(result.stdout);
    expect(output.plan.copyright).toEqual({
      from: "2025 Example Ltd",
      to: "2026 Example Ltd",
    });
    const [en, fr] = output.plan.locales;
    expect(en.version).toEqual([
      {
        field: "description",
        change: "changed",
        from: "A puzzle game.",
        to: "A better puzzle game.",
      },
      {
        field: "marketingUrl",
        change: "added",
        from: null,
        to: "https://example.com",
      },
    ]);
    expect(en.appInfo).toEqual([
      { field: "subtitle", change: "removed", from: "Brain teasers", to: null },
    ]);
    expect(en.add.map(({ file }: { file: string }) => file)).toEqual([
      "IPHONE_67-02-new.png",
    ]);
    expect(fr).toMatchObject({
      locale: "fr-FR",
      createVersionLocalization: true,
      createAppInfoLocalization: true,
    });
    expect(client.patch).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("applies the differences with --yes and syncs screenshots when asked", async () => {
    await writeListing(
      { "en-US": { promotionalText: "New season" } },
      "2025 Example Ltd",
      ["en-US/IPHONE_67-01-new.png", "en-US/IPHONE_67-02-home.png"],
    );
    const { client, post } = listingClient({
      placements: [
        { id: "P1", group: "IPHONE_67", fileName: "home.png" },
        { id: "P2", group: "IPHONE_67", fileName: "gone.png" },
      ],
    });
    const result = await run(
      [
        "metadata",
        "push",
        "123",
        dir,
        "--no-url-check",
        "--sync-screenshots",
        "--yes",
      ],
      client,
      options,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appStoreVersionLocalizations/VL1",
      {
        data: {
          type: "appStoreVersionLocalizations",
          id: "VL1",
          attributes: { promotionalText: "New season" },
        },
      },
    );
    expect(client.delete).toHaveBeenCalledWith(
      "/v1/appAssetLibraryPlacements/P2",
    );
    const ordering = post.mock.calls.find(
      ([path]) => path === "/v1/appAssetLibraryPlacementOrderingRequests",
    ) as unknown as [
      string,
      {
        data: {
          relationships: { orderedPlacements: { data: { id: string }[] } };
        };
      },
    ];
    const newPlacement = JSON.parse(result.stdout).uploaded[0].placementId;
    expect(
      ordering[1].data.relationships.orderedPlacements.data.map(({ id }) => id),
    ).toEqual([newPlacement, "P1"]);
  });

  it("stops on lint errors before reading App Store Connect", async () => {
    await writeListing({ "en-US": { description: "Lorem ipsum dolor." } });
    const { client, get } = listingClient();
    const result = await run(
      ["metadata", "push", "123", dir, "--no-url-check"],
      client,
      options,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("placeholder");
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses non-promotional changes to a version past review", async () => {
    await writeListing(
      { "en-US": { whatsNew: "More fixes" } },
      "2025 Example Ltd",
    );
    const { client } = listingClient({
      versionState: "READY_FOR_DISTRIBUTION",
    });
    const result = await run(
      ["metadata", "push", "123", dir, "--no-url-check", "--version-id", "V1"],
      client,
      options,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("en-US whatsNew");
  });

  it("rejects unknown fields in metadata.json", async () => {
    await writeListing({ "en-US": { descripton: "typo" } });
    const { client } = listingClient();
    const result = await run(["metadata", "push", "123", dir], client, options);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("descripton");
    expect(await readdir(dir)).toContain("en-US");
  });
});
