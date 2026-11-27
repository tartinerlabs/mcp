import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient, AscQuery } from "../src/asc/client.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";

/**
 * A client answering reads from `routes` (an unknown path is a 404) and
 * writes through the given mocks, which fail unless a test sets them.
 */
function routed(
  routes: Record<string, unknown>,
  writes: Partial<Pick<AscClient, "post" | "patch" | "delete" | "upload">> = {},
) {
  const fail = () => Promise.reject(new Error("unexpected write"));
  const client: AscClient = {
    get: vi.fn((path: string, _query?: AscQuery) =>
      path in routes
        ? Promise.resolve(routes[path])
        : Promise.reject(new AscApiError(404, { errors: [] })),
    ) as AscClient["get"],
    post: vi.fn(writes.post ?? fail) as AscClient["post"],
    patch: vi.fn(writes.patch ?? fail) as AscClient["patch"],
    delete: vi.fn(writes.delete ?? fail) as AscClient["delete"],
    upload: vi.fn(writes.upload ?? fail) as AscClient["upload"],
    download: vi.fn(fail) as AscClient["download"],
    downloadSigned: vi.fn(fail) as AscClient["downloadSigned"],
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

const detail = (group?: string) => ({
  data: {
    type: "gameCenterDetails",
    id: "GCD1",
    attributes: { arcadeEnabled: false },
    relationships: {
      gameCenterGroup: {
        data: group ? { type: "gameCenterGroups", id: group } : null,
      },
    },
  },
  included: group
    ? [
        {
          type: "gameCenterGroups",
          id: group,
          attributes: { referenceName: "Shared" },
        },
      ]
    : [],
});

const leaderboard = {
  type: "gameCenterLeaderboards",
  id: "LB1",
  attributes: {
    referenceName: "High Score",
    vendorIdentifier: "high_score",
    defaultFormatter: "INTEGER",
    submissionType: "BEST_SCORE",
    scoreSortType: "DESC",
    archived: false,
  },
};

const version = (id: string, number: number, state: string) => ({
  type: "gameCenterLeaderboardVersions",
  id,
  attributes: { version: number, state },
});

const localization = (id: string, locale: string, name: string) => ({
  type: "gameCenterLeaderboardLocalizations",
  id,
  attributes: { locale, name, description: null },
});

/** The header of a PNG of this size, which is all `imageSize` reads. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("game-center", () => {
  it("should say Game Center is off when the app has no Game Center detail", async () => {
    const { provider } = routed({});
    const result = await run(["game-center", "123"], provider);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      appId: "123",
      enabled: false,
    });
  });

  it("should list a group's items with each one's newest version", async () => {
    const { client, provider } = routed({
      "/v1/apps/123/gameCenterDetail": detail("GRP1"),
      "/v1/gameCenterGroups/GRP1/gameCenterLeaderboardsV2": {
        data: [
          {
            ...leaderboard,
            relationships: {
              versions: {
                data: [
                  { type: "gameCenterLeaderboardVersions", id: "V1" },
                  { type: "gameCenterLeaderboardVersions", id: "V2" },
                ],
              },
            },
          },
        ],
        included: [
          version("V1", 1, "LIVE"),
          version("V2", 2, "PREPARE_FOR_SUBMISSION"),
        ],
        links: { self: "x" },
        meta: { paging: { total: 1 } },
      },
      "/v1/gameCenterGroups/GRP1/gameCenterLeaderboardSetsV2": {
        data: [],
        links: { self: "x" },
      },
      "/v1/gameCenterGroups/GRP1/gameCenterAchievementsV2": {
        data: [],
        links: { self: "x" },
      },
    });
    const result = await run(["game-center", "123"], provider);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      enabled: true,
      gameCenterDetailId: "GCD1",
      group: { id: "GRP1", referenceName: "Shared" },
      leaderboards: {
        items: [
          {
            id: "LB1",
            vendorIdentifier: "high_score",
            latestVersion: { version: 2, state: "PREPARE_FOR_SUBMISSION" },
          },
        ],
        total: 1,
        hasMore: false,
      },
      leaderboardSets: { items: [], total: 0 },
      achievements: { items: [], total: 0 },
    });
    expect(client.get).toHaveBeenCalledWith(
      "/v1/gameCenterGroups/GRP1/gameCenterLeaderboardsV2",
      expect.objectContaining({
        include: "versions",
        "fields[gameCenterLeaderboardVersions]": ["version", "state"],
      }),
    );
  });

  it("should show a leaderboard with its versions, localizations and images", async () => {
    const { provider } = routed({
      "/v2/gameCenterLeaderboards/LB1": { data: leaderboard },
      "/v2/gameCenterLeaderboards/LB1/versions": {
        data: [version("V1", 1, "LIVE"), version("V2", 2, "REJECTED")],
      },
      "/v2/gameCenterLeaderboardVersions/V2/localizations": {
        data: [localization("L1", "en-US", "High Score")],
      },
      "/v2/gameCenterLeaderboardLocalizations/L1/image": {
        data: {
          type: "gameCenterLeaderboardImages",
          id: "IMG1",
          attributes: {
            fileName: "hs.png",
            fileSize: 10,
            imageAsset: { width: 512, height: 512 },
            assetDeliveryState: { state: "COMPLETE" },
          },
        },
      },
    });
    const result = await run(
      ["game-center", "leaderboards", "show", "LB1"],
      provider,
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.leaderboard).toMatchObject({
      id: "LB1",
      referenceName: "High Score",
    });
    expect(output.versions.map((item: { id: string }) => item.id)).toEqual([
      "V2",
      "V1",
    ]);
    expect(output.localizations).toEqual([
      {
        id: "L1",
        locale: "en-US",
        name: "High Score",
        description: null,
        formatterOverride: null,
        formatterSuffix: null,
        formatterSuffixSingular: null,
        image: {
          id: "IMG1",
          fileName: "hs.png",
          fileSize: 10,
          width: 512,
          height: 512,
          state: "COMPLETE",
        },
      },
    ]);
  });

  describe("leaderboards create", () => {
    const reads = {
      "/v1/apps/123/gameCenterDetail": detail(),
      "/v1/gameCenterDetails/GCD1/gameCenterLeaderboardsV2": {
        data: [leaderboard],
        links: { self: "x" },
        meta: { paging: { total: 1 } },
      },
    };
    const args = [
      "game-center",
      "leaderboards",
      "create",
      "123",
      "--vendor-id",
      "fastest_lap",
      "--reference-name",
      "Fastest Lap",
      "--formatter",
      "ELAPSED_TIME_CENTISECOND",
      "--sort",
      "ASC",
      "--locale",
      "en-US",
      "--name",
      "Fastest Lap",
    ];

    it("should print the leaderboard without writing", async () => {
      const { client, provider } = routed(reads);
      const result = await run(args, provider);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        dryRun: true,
        action: "create",
        appId: "123",
        owner: { gameCenterDetailId: "GCD1" },
        leaderboard: {
          vendorIdentifier: "fastest_lap",
          referenceName: "Fastest Lap",
          defaultFormatter: "ELAPSED_TIME_CENTISECOND",
          scoreSortType: "ASC",
          submissionType: "BEST_SCORE",
        },
        localization: { locale: "en-US", name: "Fastest Lap" },
        existing: 1,
      });
      expect(result.stderr).toContain("Dry run");
      expect(client.post).not.toHaveBeenCalled();
    });

    it("should refuse a vendor identifier already in use", async () => {
      const { provider } = routed(reads);
      const taken = [...args];
      taken[taken.indexOf("fastest_lap")] = "high_score";
      const result = await run(taken, provider);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[invalid_input]");
      expect(result.stderr).toContain("LB1 already has the vendor identifier");
    });

    it("should create it with an inline version, then its localization", async () => {
      const post = vi.fn((path: string) =>
        Promise.resolve(
          path === "/v2/gameCenterLeaderboards"
            ? { data: { ...leaderboard, id: "LB2" } }
            : { data: localization("L9", "en-US", "Fastest Lap") },
        ),
      );
      const { client, provider } = routed(
        {
          ...reads,
          "/v2/gameCenterLeaderboards/LB2/versions": {
            data: [version("V9", 1, "PREPARE_FOR_SUBMISSION")],
          },
        },
        { post: post as AscClient["post"] },
      );
      const result = await run([...args, "--yes"], provider);
      expect(result.exitCode).toBe(0);
      expect(client.post).toHaveBeenNthCalledWith(
        1,
        "/v2/gameCenterLeaderboards",
        {
          data: {
            type: "gameCenterLeaderboards",
            attributes: expect.objectContaining({
              vendorIdentifier: "fastest_lap",
            }),
            relationships: {
              gameCenterDetail: {
                data: { type: "gameCenterDetails", id: "GCD1" },
              },
              versions: {
                data: [
                  {
                    type: "gameCenterLeaderboardVersions",
                    id: "${new-version}",
                  },
                ],
              },
            },
          },
          included: [
            { type: "gameCenterLeaderboardVersions", id: "${new-version}" },
          ],
        },
      );
      expect(client.post).toHaveBeenNthCalledWith(
        2,
        "/v2/gameCenterLeaderboardLocalizations",
        {
          data: {
            type: "gameCenterLeaderboardLocalizations",
            attributes: { locale: "en-US", name: "Fastest Lap" },
            relationships: {
              version: {
                data: { type: "gameCenterLeaderboardVersions", id: "V9" },
              },
            },
          },
        },
      );
    });

    it("should refuse an app without Game Center", async () => {
      const { provider } = routed({});
      const result = await run(args, provider);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[not_found]");
    });

    it("should need --name with --locale", async () => {
      const { provider } = routed(reads);
      const result = await run(
        [...args.slice(0, -2), "--description", "Laps"],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Give --name for the locale.");
    });
  });

  describe("leaderboards set", () => {
    it("should start a new version to change a live leaderboard's locale", async () => {
      const post = vi.fn(() =>
        Promise.resolve({ data: version("V3", 3, "PREPARE_FOR_SUBMISSION") }),
      );
      const patch = vi.fn(() =>
        Promise.resolve({ data: localization("L3", "en-US", "Best Score") }),
      );
      const { client, provider } = routed(
        {
          "/v2/gameCenterLeaderboards/LB1": { data: leaderboard },
          "/v2/gameCenterLeaderboards/LB1/versions": {
            data: [version("V2", 2, "LIVE")],
          },
          "/v2/gameCenterLeaderboardVersions/V2/localizations": {
            data: [localization("L2", "en-US", "High Score")],
          },
          "/v2/gameCenterLeaderboardVersions/V3/localizations": {
            data: [localization("L3", "en-US", "High Score")],
          },
        },
        {
          post: post as AscClient["post"],
          patch: patch as AscClient["patch"],
        },
      );
      const args = [
        "game-center",
        "leaderboards",
        "set",
        "LB1",
        "--locale",
        "en-US",
        "--name",
        "Best Score",
      ];
      const dry = await run(args, provider);
      expect(dry.exitCode).toBe(0);
      expect(JSON.parse(dry.stdout).localization).toEqual({
        locale: "en-US",
        newLocale: false,
        newVersion: true,
        current: { name: "High Score" },
        update: { name: "Best Score" },
      });
      expect(client.post).not.toHaveBeenCalled();
      vi.mocked(console.log).mockClear();

      const result = await run([...args, "--yes"], provider);
      expect(result.exitCode).toBe(0);
      expect(client.post).toHaveBeenCalledWith(
        "/v2/gameCenterLeaderboardVersions",
        {
          data: {
            type: "gameCenterLeaderboardVersions",
            relationships: {
              leaderboard: {
                data: { type: "gameCenterLeaderboards", id: "LB1" },
              },
            },
          },
        },
      );
      expect(client.patch).toHaveBeenCalledWith(
        "/v2/gameCenterLeaderboardLocalizations/L3",
        {
          data: {
            type: "gameCenterLeaderboardLocalizations",
            id: "L3",
            attributes: { name: "Best Score" },
          },
        },
      );
    });

    it("should patch only attributes that differ", async () => {
      const patch = vi.fn(() => Promise.resolve({ data: leaderboard }));
      const { client, provider } = routed(
        { "/v2/gameCenterLeaderboards/LB1": { data: leaderboard } },
        { patch: patch as AscClient["patch"] },
      );
      const result = await run(
        [
          "game-center",
          "leaderboards",
          "set",
          "LB1",
          "--sort",
          "DESC",
          "--archived",
          "true",
          "--yes",
        ],
        provider,
      );
      expect(result.exitCode).toBe(0);
      expect(client.patch).toHaveBeenCalledWith(
        "/v2/gameCenterLeaderboards/LB1",
        {
          data: {
            type: "gameCenterLeaderboards",
            id: "LB1",
            attributes: { archived: true },
          },
        },
      );
    });

    it("should refuse a locale change while a version is in review", async () => {
      const { provider } = routed({
        "/v2/gameCenterLeaderboards/LB1": { data: leaderboard },
        "/v2/gameCenterLeaderboards/LB1/versions": {
          data: [version("V2", 2, "IN_REVIEW")],
        },
      });
      const result = await run(
        [
          "game-center",
          "leaderboards",
          "set",
          "LB1",
          "--locale",
          "en-US",
          "--name",
          "X",
        ],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[invalid_input]");
      expect(result.stderr).toContain("IN_REVIEW");
    });

    it("should need something to change", async () => {
      const { provider } = routed({});
      const result = await run(
        ["game-center", "leaderboards", "set", "LB1"],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Give at least one thing to change.");
    });
  });

  describe("leaderboards upload-image", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "asc-gc-"));
      await writeFile(join(dir, "hs.png"), png(512, 512));
      await writeFile(join(dir, "notes.txt"), "not an image");
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const reads = {
      "/v2/gameCenterLeaderboards/LB1": { data: leaderboard },
      "/v2/gameCenterLeaderboards/LB1/versions": {
        data: [version("V2", 2, "PREPARE_FOR_SUBMISSION")],
      },
      "/v2/gameCenterLeaderboardVersions/V2/localizations": {
        data: [localization("L2", "en-US", "High Score")],
      },
      "/v2/gameCenterLeaderboardLocalizations/L2/image": {
        data: {
          type: "gameCenterLeaderboardImages",
          id: "OLD",
          attributes: { fileName: "old.png" },
        },
      },
    };

    it("should replace the locale's image", async () => {
      const post = vi.fn(() =>
        Promise.resolve({
          data: {
            type: "gameCenterLeaderboardImages",
            id: "NEW",
            attributes: {
              uploadOperations: [
                {
                  method: "PUT",
                  url: "https://upload.example.com/1",
                  offset: 0,
                  length: 33,
                },
              ],
            },
          },
        }),
      );
      const { client, provider } = routed(reads, {
        post: post as AscClient["post"],
        patch: vi.fn(() => Promise.resolve({})) as AscClient["patch"],
        delete: vi.fn(() => Promise.resolve()),
        upload: vi.fn(() => Promise.resolve()),
      });
      const args = [
        "game-center",
        "leaderboards",
        "upload-image",
        "LB1",
        "--locale",
        "en-US",
        "--file",
        join(dir, "hs.png"),
      ];
      const dry = await run(args, provider);
      expect(dry.exitCode).toBe(0);
      expect(JSON.parse(dry.stdout)).toMatchObject({
        dryRun: true,
        file: { fileName: "hs.png", fileSize: 33, width: 512, height: 512 },
        replaces: { id: "OLD", fileName: "old.png" },
        newVersion: false,
      });
      expect(client.delete).not.toHaveBeenCalled();
      vi.mocked(console.log).mockClear();

      const result = await run([...args, "--yes"], provider);
      expect(result.exitCode).toBe(0);
      expect(client.delete).toHaveBeenCalledWith(
        "/v2/gameCenterLeaderboardImages/OLD",
      );
      expect(client.post).toHaveBeenCalledWith(
        "/v2/gameCenterLeaderboardImages",
        {
          data: {
            type: "gameCenterLeaderboardImages",
            attributes: { fileName: "hs.png", fileSize: 33 },
            relationships: {
              localization: {
                data: { type: "gameCenterLeaderboardLocalizations", id: "L2" },
              },
            },
          },
        },
      );
      expect(client.upload).toHaveBeenCalledTimes(1);
      expect(client.patch).toHaveBeenCalledWith(
        "/v2/gameCenterLeaderboardImages/NEW",
        {
          data: {
            type: "gameCenterLeaderboardImages",
            id: "NEW",
            attributes: { uploaded: true },
          },
        },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        imageId: "NEW",
        replaced: "OLD",
      });
    });

    it("should refuse a file that is not a PNG or JPEG", async () => {
      const { provider } = routed(reads);
      const result = await run(
        [
          "game-center",
          "leaderboards",
          "upload-image",
          "LB1",
          "--locale",
          "en-US",
          "--file",
          join(dir, "notes.txt"),
        ],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not a PNG or JPEG");
    });

    it("should refuse a locale the leaderboard does not have", async () => {
      const { provider } = routed(reads);
      const result = await run(
        [
          "game-center",
          "leaderboards",
          "upload-image",
          "LB1",
          "--locale",
          "fr-FR",
          "--file",
          join(dir, "hs.png"),
        ],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("has no fr-FR localization");
    });
  });

  it("should suggest archiving when Apple will not delete a leaderboard", async () => {
    const { provider } = routed(
      { "/v2/gameCenterLeaderboards/LB1": { data: leaderboard } },
      {
        delete: vi.fn(() =>
          Promise.reject(new AscApiError(409, { errors: [] })),
        ),
      },
    );
    const result = await run(
      ["game-center", "leaderboards", "delete", "LB1", "--yes"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("--archived true");
  });

  it("should delete a locale from an editable version", async () => {
    const { client, provider } = routed(
      {
        "/v2/gameCenterLeaderboards/LB1": { data: leaderboard },
        "/v2/gameCenterLeaderboards/LB1/versions": {
          data: [version("V2", 2, "PREPARE_FOR_SUBMISSION")],
        },
        "/v2/gameCenterLeaderboardVersions/V2/localizations": {
          data: [localization("L2", "fr-FR", "Meilleur score")],
        },
      },
      { delete: vi.fn(() => Promise.resolve()) },
    );
    const result = await run(
      [
        "game-center",
        "leaderboards",
        "delete-locale",
        "LB1",
        "--locale",
        "fr-FR",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith(
      "/v2/gameCenterLeaderboardLocalizations/L2",
    );
  });

  it("should add only leaderboards a set does not have", async () => {
    const { client, provider } = routed(
      {
        "/v2/gameCenterLeaderboardSets/SET1": {
          data: {
            type: "gameCenterLeaderboardSets",
            id: "SET1",
            attributes: { referenceName: "Season", vendorIdentifier: "s1" },
          },
        },
        "/v2/gameCenterLeaderboardSets/SET1/gameCenterLeaderboards": {
          data: [leaderboard],
        },
      },
      { post: vi.fn(() => Promise.resolve(undefined)) as AscClient["post"] },
    );
    const result = await run(
      [
        "game-center",
        "leaderboard-sets",
        "add",
        "SET1",
        "--leaderboards",
        "LB1,LB2",
        "--yes",
      ],
      provider,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith(
      "/v2/gameCenterLeaderboardSets/SET1/relationships/gameCenterLeaderboards",
      { data: [{ type: "gameCenterLeaderboards", id: "LB2" }] },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: false,
      action: "add",
      id: "SET1",
      added: ["LB2"],
    });
  });

  describe("achievements create", () => {
    const base = [
      "game-center",
      "achievements",
      "create",
      "123",
      "--vendor-id",
      "first_win",
      "--reference-name",
      "First Win",
    ];

    it("should need points from 1 to 100", async () => {
      const { provider } = routed({});
      const missing = await run(base, provider);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("Give --points, 1 to 100.");
      const high = await run([...base, "--points", "101"], provider);
      expect(high.exitCode).toBe(1);
      expect(high.stderr).toContain("Must be 1 to 100 points.");
    });

    it("should need both descriptions to add a locale", async () => {
      const { provider } = routed({});
      const result = await run(
        [...base, "--points", "10", "--locale", "en-US", "--name", "Winner"],
        provider,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Give --before-earned-description, --after-earned-description for the locale.",
      );
    });

    it("should print the achievement with its defaults", async () => {
      const { provider } = routed({
        "/v1/apps/123/gameCenterDetail": detail(),
        "/v1/gameCenterDetails/GCD1/gameCenterAchievementsV2": {
          data: [],
          links: { self: "x" },
          meta: { paging: { total: 0 } },
        },
      });
      const result = await run(
        [...base, "--points", "10", "--repeatable", "true"],
        provider,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).achievement).toEqual({
        vendorIdentifier: "first_win",
        referenceName: "First Win",
        points: 10,
        showBeforeEarned: true,
        repeatable: true,
      });
    });
  });
});
