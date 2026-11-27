import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { createProgram } from "../src/cli.ts";

async function run(args: string[], client: AscClient) {
  let stderr = "";
  const program = createProgram(() => client);
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

const rel = (id: string | null) => ({
  data: id ? { type: "appCategories", id } : null,
});

function categoriesClient(state = "PREPARE_FOR_SUBMISSION") {
  const get = vi.fn((path: string) => {
    if (path === "/v1/appInfos/AI1") {
      return Promise.resolve({
        data: {
          type: "appInfos",
          id: "AI1",
          attributes: { state },
          relationships: {
            primaryCategory: rel("GAMES"),
            primarySubcategoryOne: rel("GAMES_ACTION"),
            primarySubcategoryTwo: rel(null),
            secondaryCategory: rel(null),
            secondarySubcategoryOne: rel(null),
            secondarySubcategoryTwo: rel(null),
          },
        },
      });
    }
    if (path === "/v1/appCategories") {
      const subs = (ids: string[]) => ({
        data: ids.map((id) => ({ type: "appCategories", id })),
      });
      return Promise.resolve({
        data: [
          {
            type: "appCategories",
            id: "GAMES",
            relationships: {
              subcategories: subs(["GAMES_ACTION", "GAMES_PUZZLE"]),
            },
          },
          {
            type: "appCategories",
            id: "EDUCATION",
            relationships: { subcategories: subs([]) },
          },
        ],
      });
    }
    return Promise.reject(new Error(`GET ${path}`));
  });
  const patch = vi.fn(() => Promise.resolve({}));
  return { client: { get, patch } as unknown as AscClient, patch };
}

describe("app-info categories", () => {
  it("shows the current and new categories without --yes", async () => {
    const { client, patch } = categoriesClient();
    const result = await run(
      [
        "app-info",
        "categories",
        "AI1",
        "--primary-sub",
        "games_puzzle",
        "--secondary",
        "EDUCATION",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      current: {
        primarySubcategoryOne: "GAMES_ACTION",
        secondaryCategory: null,
      },
      update: {
        primaryCategory: "GAMES",
        primarySubcategoryOne: "GAMES_PUZZLE",
        secondaryCategory: "EDUCATION",
      },
      changes: true,
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it("patches only the changed relationships with --yes", async () => {
    const { client, patch } = categoriesClient();
    const result = await run(
      [
        "app-info",
        "categories",
        "AI1",
        "--primary-sub",
        "none",
        "--secondary",
        "EDUCATION",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(patch).toHaveBeenCalledWith("/v1/appInfos/AI1", {
      data: {
        type: "appInfos",
        id: "AI1",
        relationships: {
          primarySubcategoryOne: { data: null },
          secondaryCategory: {
            data: { type: "appCategories", id: "EDUCATION" },
          },
        },
      },
    });
  });

  it("names the valid categories and subcategories", async () => {
    const { client } = categoriesClient();
    const unknown = await run(
      ["app-info", "categories", "AI1", "--primary", "FOOD"],
      client,
    );
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain(
      "[invalid_input] FOOD is not an App Store category. Categories are EDUCATION, GAMES.",
    );
    // Changing the primary leaves its old subcategory behind.
    const orphan = await run(
      ["app-info", "categories", "AI1", "--primary", "EDUCATION"],
      client,
    );
    expect(orphan.stderr).toContain("EDUCATION has no subcategories");
  });

  it("refuses an app info that is live", async () => {
    const { client } = categoriesClient("READY_FOR_DISTRIBUTION");
    const result = await run(
      ["app-info", "categories", "AI1", "--primary", "GAMES"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("can no longer be changed");
  });
});

describe("apps content-rights", () => {
  function appClient() {
    const get = vi.fn(() =>
      Promise.resolve({
        data: {
          type: "apps",
          id: "123",
          attributes: { name: "Puzzler", contentRightsDeclaration: null },
        },
      }),
    );
    const patch = vi.fn(() => Promise.resolve({}));
    return { client: { get, patch } as unknown as AscClient, patch };
  }

  it("shows the current and new declaration without --yes", async () => {
    const { client, patch } = appClient();
    const result = await run(
      ["apps", "content-rights", "123", "--no-third-party-content"],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      current: null,
      update: "DOES_NOT_USE_THIRD_PARTY_CONTENT",
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it("sets the declaration with --yes", async () => {
    const { client, patch } = appClient();
    const result = await run(
      ["apps", "content-rights", "123", "--uses-third-party-content", "--yes"],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(patch).toHaveBeenCalledWith("/v1/apps/123", {
      data: {
        type: "apps",
        id: "123",
        attributes: { contentRightsDeclaration: "USES_THIRD_PARTY_CONTENT" },
      },
    });
  });

  it("needs one of the two flags", async () => {
    const { client } = appClient();
    const result = await run(["apps", "content-rights", "123"], client);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "--uses-third-party-content or --no-third-party-content",
    );
  });
});
