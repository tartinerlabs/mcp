import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppStoreClient,
  StoreApp,
  StoreListing,
} from "../src/appstore/client.ts";
import { createProgram } from "../src/cli.ts";
import { AppStoreApiError } from "../src/utils/errors.ts";

const NOW = Date.parse("2026-11-22T00:00:00Z");
let dir: string;

const app = (id: number, name = `App ${id}`): StoreApp => ({
  id,
  name,
  developer: `Dev ${id}`,
});

const listing = (id: number, overrides: Partial<StoreListing> = {}) => ({
  ...app(id),
  version: "1.0",
  versionReleaseDate: "2026-11-01T00:00:00Z",
  releaseNotes: "Fixes.",
  description: "A habit tracker.",
  genre: "Productivity",
  price: "Free",
  rating: 4.5,
  ratingCount: 100,
  screenshotCount: 5,
  url: `https://apps.apple.com/us/app/id${id}`,
  ...overrides,
});

/** Runs the CLI with a mocked client, capturing stdout, stderr and the exit code. */
async function run(args: string[], client: Partial<AppStoreClient> = {}) {
  const notMocked = () => Promise.reject(new Error("not mocked"));
  let stderr = "";
  const program = createProgram(
    { search: notMocked, lookup: notMocked, ...client },
    { now: () => NOW },
  );
  const commands = [program];
  for (let i = 0; i < commands.length; i++) {
    commands.push(...(commands[i]?.commands ?? []));
  }
  for (const command of commands) {
    command.exitOverride().configureOutput({
      writeErr: (text) => {
        stderr += text;
      },
    });
  }
  const exitCode = await program
    .parseAsync(args, { from: "user" })
    .then(() => process.exitCode ?? 0)
    .catch((error: { exitCode?: number }) => error.exitCode ?? 1);
  const stdout = vi
    .mocked(console.log)
    .mock.calls.map(([text]) => text)
    .join("\n");
  return { exitCode, stdout, stderr };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aso-test-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("keywords lint", () => {
  it("should pass a clean keyword field", async () => {
    const result = await run([
      "keywords",
      "lint",
      "--keywords",
      "habit,tracker,routine,streak",
      "--name",
      "Daily",
    ]);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      bytes: 28,
      remainingBytes: 72,
      valid: true,
      issues: [],
    });
  });

  it("should report wasted space without failing", async () => {
    const result = await run([
      "keywords",
      "lint",
      "--keywords",
      "habits, habit,tracker,tracker,the,app,#goals,,daily",
      "--name",
      "Daily Planner",
      "--subtitle",
      "Track routines",
    ]);

    expect(result.exitCode).toBe(0);
    const issues = JSON.parse(result.stdout).issues;
    const byRule = Object.fromEntries(
      issues.map((issue: { rule: string; terms?: string[] }) => [
        issue.rule,
        issue.terms ?? true,
      ]),
    );
    expect(byRule).toEqual({
      "empty-term": true,
      "space-after-comma": true,
      "duplicate-word": ["tracker"],
      plural: ["habits/habit"],
      "already-in-metadata": ["daily"],
      "generic-word": ["app"],
      "filler-word": ["the"],
      "special-character": ["#goals"],
    });
  });

  it("should fail when a limit is broken", async () => {
    const result = await run([
      "keywords",
      "lint",
      "--keywords",
      `${"é".repeat(51)},go`,
      "--subtitle",
      "x".repeat(31),
    ]);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.valid).toBe(false);
    expect(output.bytes).toBe(105);
    expect(
      output.issues
        .filter((issue: { severity: string }) => issue.severity === "error")
        .map((issue: { rule: string }) => issue.rule),
    ).toEqual(["subtitle-length", "keywords-length", "short-term"]);
  });
});

describe("ranks check", () => {
  it("should report the app's position and the top apps for each term", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce([app(1), app(2), app(42), app(3)])
      .mockResolvedValueOnce([app(1), app(2)]);

    const result = await run(
      [
        "ranks",
        "check",
        "habit tracker",
        "streaks",
        "--app-id",
        "42",
        "--country",
        "GB",
      ],
      { search },
    );

    expect(result.exitCode).toBe(0);
    expect(search).toHaveBeenNthCalledWith(1, "habit tracker", "gb", 200);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      appId: 42,
      country: "gb",
      checkedAt: "2026-11-22T00:00:00.000Z",
    });
    expect(output.results).toEqual([
      {
        term: "habit tracker",
        rank: 3,
        resultCount: 4,
        top: [app(1), app(2), app(42)],
      },
      { term: "streaks", rank: null, resultCount: 2, top: [app(1), app(2)] },
    ]);
  });

  it("should compare with and append to the history file", async () => {
    const history = join(dir, "ranks.jsonl");
    const search = vi
      .fn()
      .mockResolvedValueOnce([app(1), app(42)])
      .mockResolvedValueOnce([app(42)])
      .mockResolvedValueOnce([app(42), app(1)]);

    await run(
      ["ranks", "check", "habit", "--app-id", "42", "--history", history],
      {
        search,
      },
    );
    vi.mocked(console.log).mockClear();
    const result = await run(
      [
        "ranks",
        "check",
        "habit",
        "streak",
        "--app-id",
        "42",
        "--history",
        history,
      ],
      { search },
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(
      output.results.map((r: object) => ({ ...r, top: undefined })),
    ).toEqual([
      {
        term: "habit",
        rank: 1,
        previousRank: 2,
        change: 1,
        resultCount: 1,
        top: undefined,
      },
      {
        term: "streak",
        rank: 1,
        previousRank: null,
        change: null,
        resultCount: 2,
        top: undefined,
      },
    ]);
    const lines = (await readFile(history, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        checkedAt: "2026-11-22T00:00:00.000Z",
        country: "us",
        appId: 42,
        term: "habit",
        rank: 2,
      },
      {
        checkedAt: "2026-11-22T00:00:00.000Z",
        country: "us",
        appId: 42,
        term: "habit",
        rank: 1,
      },
      {
        checkedAt: "2026-11-22T00:00:00.000Z",
        country: "us",
        appId: 42,
        term: "streak",
        rank: 1,
      },
    ]);
  });

  it("should refuse a history file it did not write", async () => {
    const history = join(dir, "ranks.jsonl");
    await writeFile(history, "not json\n");

    const result = await run(
      ["ranks", "check", "habit", "--app-id", "42", "--history", history],
      { search: vi.fn().mockResolvedValue([]) },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[file]");
    expect(result.stderr).toContain("line 1 is not JSON");
  });

  it("should reject a bad app ID or country", async () => {
    const badId = await run(["ranks", "check", "habit", "--app-id", "abc"]);
    const badCountry = await run([
      "ranks",
      "check",
      "habit",
      "--app-id",
      "42",
      "--country",
      "usa",
    ]);

    expect(badId.exitCode).toBe(1);
    expect(badId.stderr).toContain("[invalid_input]");
    expect(badCountry.stderr).toContain("two-letter App Store storefront code");
  });

  it("should classify a rate limit", async () => {
    const result = await run(["ranks", "check", "habit", "--app-id", "42"], {
      search: vi.fn().mockRejectedValue(new AppStoreApiError(403)),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[quota]");
  });
});

describe("competitors diff", () => {
  it("should record on the first run and report changes on the next", async () => {
    const snapshot = join(dir, "us.json");
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([listing(1), listing(2)])
      .mockResolvedValueOnce([
        listing(1, { version: "1.1", description: "A better habit tracker." }),
        listing(2),
        listing(3),
      ]);

    const first = await run(
      ["competitors", "diff", "1", "2", "--snapshot", snapshot],
      { lookup },
    );
    expect(JSON.parse(first.stdout)).toEqual({
      country: "us",
      takenAt: "2026-11-22T00:00:00.000Z",
      comparedWith: null,
      apps: [
        { id: 1, name: "App 1", status: "new" },
        { id: 2, name: "App 2", status: "new" },
      ],
      notFound: [],
    });

    vi.mocked(console.log).mockClear();
    const second = await run(
      ["competitors", "diff", "1", "2", "3", "4", "--snapshot", snapshot],
      { lookup },
    );

    expect(lookup).toHaveBeenLastCalledWith([1, 2, 3, 4], "us");
    expect(JSON.parse(second.stdout)).toMatchObject({
      comparedWith: "2026-11-22T00:00:00.000Z",
      apps: [
        {
          id: 1,
          status: "changed",
          changes: [
            { field: "version", before: "1.0", after: "1.1" },
            {
              field: "description",
              before: { length: 16 },
              after: { length: 23 },
            },
          ],
        },
        { id: 2, status: "unchanged" },
        { id: 3, status: "new" },
      ],
      notFound: [4],
    });
  });

  it("should refuse a snapshot from another storefront", async () => {
    const snapshot = join(dir, "us.json");
    const lookup = vi.fn().mockResolvedValue([listing(1)]);
    await run(["competitors", "diff", "1", "--snapshot", snapshot], { lookup });

    const result = await run(
      ["competitors", "diff", "1", "--snapshot", snapshot, "--country", "gb"],
      { lookup },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("holds the us storefront, not gb");
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
