import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { createProgram, type ProgramOptions } from "../src/cli.ts";
import { lintListing } from "../src/commands/metadata-lint.ts";

async function run(
  args: string[],
  provider: () => AscClient,
  options: ProgramOptions = {},
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

let dir: string;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "asc-lint-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 27);
const noFetch = (() =>
  Promise.reject(new Error("unexpected fetch"))) as unknown as typeof fetch;
const deps = { fetch: noFetch, now: () => NOW };
const lint = (
  listing: Parameters<typeof lintListing>[0],
  rules: string[] = [],
  dependencies = deps,
) => lintListing(listing, { rules, checkUrls: true }, dependencies);

describe("lintListing", () => {
  it("finds placeholder text, other platforms, future features and Apple bashing", async () => {
    const result = await lint({
      locales: [
        {
          locale: "en-US",
          fields: {
            description:
              "Lorem ipsum. Also on Android. Dark mode coming soon! The iPhone keyboard sucks.",
            whatsNew: "TODO",
          },
        },
      ],
    });
    expect(
      result.findings.map(({ field, rule, severity }) => [
        field,
        rule,
        severity,
      ]),
    ).toEqual([
      ["description", "placeholder", "error"],
      ["description", "other-platforms", "error"],
      ["description", "future-features", "warning"],
      ["description", "apple-negative", "warning"],
      ["whatsNew", "placeholder", "error"],
    ]);
    expect(result).toMatchObject({ errors: 3, warnings: 2 });
  });

  it("does not flag ordinary words", async () => {
    const result = await lint({
      locales: [
        {
          locale: "en-US",
          fields: {
            description: "Tested by teachers. Works great on iPhone and iPad.",
            name: "Contest Timer",
          },
        },
      ],
      copyright: "© 2026 Example Ltd",
    });
    expect(result.findings).toEqual([]);
  });

  it("checks lengths, keyword bytes, the copyright year and IAP names", async () => {
    const result = await lint({
      locales: [
        {
          locale: "ja",
          fields: { name: "a".repeat(31), keywords: "パズル,".repeat(12) },
        },
      ],
      copyright: "2025 Example Ltd",
      inAppPurchases: [{ id: "I1", name: "Free Coins" }],
    });
    expect(result.findings).toEqual([
      expect.objectContaining({ locale: "ja", field: "name", rule: "length" }),
      expect.objectContaining({
        locale: "ja",
        field: "keywords",
        rule: "length",
        severity: "warning",
      }),
      expect.objectContaining({
        field: "copyright",
        rule: "copyright-year",
        severity: "warning",
      }),
      expect.objectContaining({ field: "inAppPurchases.I1", rule: "free-iap" }),
    ]);
  });

  it("blocks a keyword field over 100 characters", async () => {
    const result = await lint({
      locales: [{ locale: "en-US", fields: { keywords: "ab,".repeat(34) } }],
      copyright: `${new Date().getFullYear()} Example Ltd`,
    });
    expect(result.findings).toEqual([
      expect.objectContaining({
        locale: "en-US",
        field: "keywords",
        rule: "length",
        severity: "error",
        message: "102 characters, past Apple's limit of 100.",
      }),
    ]);
  });

  it("lets a rule be turned off or made a warning", async () => {
    const result = await lint(
      {
        locales: [
          {
            locale: "en-US",
            fields: { description: "Lorem ipsum on Android" },
          },
        ],
      },
      ["placeholder=off", "other-platforms=warning"],
    );
    expect(result.findings).toEqual([
      expect.objectContaining({ rule: "other-platforms", severity: "warning" }),
    ]);
    expect(result.errors).toBe(0);
  });

  it("requests each listing URL once, failing on 4xx and warning on network errors", async () => {
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("down"))
        return Promise.reject(new TypeError("fetch failed"));
      const status = url.includes("missing")
        ? 404
        : init?.method === "HEAD"
          ? 405
          : 200;
      return Promise.resolve(new Response(null, { status }));
    });
    const result = await lint(
      {
        locales: [
          {
            locale: "en-US",
            fields: {
              supportUrl: "https://example.com/missing",
              marketingUrl: "https://example.com/ok",
              privacyPolicyUrl: "https://down.example.com",
            },
          },
          {
            locale: "fr-FR",
            fields: { supportUrl: "https://example.com/missing" },
          },
        ],
      },
      [],
      { fetch: fetcher as unknown as typeof fetch, now: () => NOW },
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        locale: "en-US",
        field: "supportUrl",
        severity: "error",
      }),
      expect.objectContaining({
        locale: "fr-FR",
        field: "supportUrl",
        severity: "error",
      }),
      expect.objectContaining({
        field: "privacyPolicyUrl",
        severity: "warning",
      }),
    ]);
    const missing = fetcher.mock.calls.filter(([url]) =>
      url.includes("missing"),
    );
    expect(missing).toHaveLength(1);
    // HEAD refused with 405, then GET.
    expect(
      fetcher.mock.calls
        .filter(([url]) => url.endsWith("/ok"))
        .map(([, init]) => init?.method),
    ).toEqual(["HEAD", "GET"]);
  });
});

describe("metadata lint", () => {
  it("lints a folder without a key and exits 1 on errors", async () => {
    await mkdir(join(dir, "en-US"));
    await writeFile(
      join(dir, "en-US", "metadata.json"),
      JSON.stringify({ description: "Lorem ipsum" }),
    );
    const provider = vi.fn(() => {
      throw new Error("no key");
    });
    const result = await run(
      ["metadata", "lint", "--dir", dir, "--no-url-check"],
      provider,
      deps,
    );
    expect(provider).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dir,
      errors: 1,
      findings: [
        { locale: "en-US", field: "description", rule: "placeholder" },
      ],
    });
    expect(result.stderr).toContain("found 1 error");
  });

  it("lints a version with its app info and in-app purchases", async () => {
    const get = vi.fn((path: string) => {
      const bodies: Record<string, unknown> = {
        "/v1/appStoreVersions/V1": {
          data: {
            type: "appStoreVersions",
            id: "V1",
            attributes: { copyright: "2026 Example" },
            relationships: { app: { data: { type: "apps", id: "123" } } },
          },
        },
        "/v1/apps/123/appInfos": {
          data: [
            {
              type: "appInfos",
              id: "AI1",
              attributes: { state: "READY_FOR_DISTRIBUTION" },
            },
          ],
        },
        "/v1/appStoreVersions/V1/appStoreVersionLocalizations": {
          data: [
            {
              type: "appStoreVersionLocalizations",
              id: "VL1",
              attributes: { locale: "en-US", description: "A fine app." },
            },
          ],
        },
        "/v1/appInfos/AI1/appInfoLocalizations": {
          data: [
            {
              type: "appInfoLocalizations",
              id: "IL1",
              attributes: { locale: "en-US", name: "Fine" },
            },
          ],
        },
        "/v1/apps/123/inAppPurchasesV2": {
          data: [
            { type: "inAppPurchases", id: "I1", attributes: { name: "Pro" } },
          ],
        },
      };
      if (!(path in bodies)) return Promise.reject(new Error(`GET ${path}`));
      return Promise.resolve(bodies[path]);
    });
    const client = { get } as unknown as AscClient;
    const result = await run(["metadata", "lint", "V1"], () => client, deps);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      versionId: "V1",
      appInfoId: "AI1",
      findings: [],
      errors: 0,
      warnings: 0,
    });
  });

  it("refuses an unknown rule", async () => {
    const result = await run(
      ["metadata", "lint", "--dir", dir, "--rule", "spelling=off"],
      () => ({}) as AscClient,
      deps,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
  });
});
