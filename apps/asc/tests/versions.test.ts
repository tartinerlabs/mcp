import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { createProgram } from "../src/cli.ts";
import { appleIncludes } from "./apple-includes.ts";

/** Runs the CLI, capturing stdout, stderr and the exit code. */
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
  return { exitCode, stdout, stderr, json: () => JSON.parse(stdout) };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const links = { self: "https://api.appstoreconnect.apple.com/v1/x" };

interface Setup {
  existing?: boolean;
  sourceApp?: string;
  /** Locales Apple creates with the new version. */
  targetLocales?: { locale: string; description?: string }[];
  state?: string;
  current?: Record<string, unknown>;
  failPost?: string;
}

function versionsClient({
  existing = false,
  sourceApp = "123",
  targetLocales = [{ locale: "en-US" }],
  state = "PREPARE_FOR_SUBMISSION",
  current = { releaseType: "MANUAL", earliestReleaseDate: null },
  failPost,
}: Setup = {}) {
  const get = vi.fn((path: string) => {
    if (path === "/v1/apps/123/appStoreVersions") {
      return Promise.resolve({
        data: existing
          ? [
              {
                type: "appStoreVersions",
                id: "V0",
                attributes: { appVersionState: "READY_FOR_DISTRIBUTION" },
              },
            ]
          : [],
        links,
      });
    }
    if (path === "/v1/appStoreVersions/V1") {
      return Promise.resolve({
        data: {
          type: "appStoreVersions",
          id: "V1",
          attributes: {
            platform: "IOS",
            versionString: "2.4.0",
            appVersionState: state,
            copyright: "2025 Example",
            ...current,
          },
          relationships: { app: { data: { type: "apps", id: sourceApp } } },
        },
      });
    }
    if (path === "/v1/appStoreVersions/V1/appStoreVersionLocalizations") {
      return Promise.resolve({
        data: [
          {
            type: "appStoreVersionLocalizations",
            id: "L1",
            attributes: {
              locale: "en-US",
              description: "An app",
              keywords: "app,tool",
              whatsNew: "Old notes",
              supportUrl: "https://example.com/help",
              promotionalText: null,
            },
          },
          {
            type: "appStoreVersionLocalizations",
            id: "L2",
            attributes: { locale: "fr-FR", description: "Une app" },
          },
        ],
        links,
      });
    }
    if (path === "/v1/appStoreVersions/V9/appStoreVersionLocalizations") {
      return Promise.resolve({
        data: targetLocales.map((attributes, index) => ({
          type: "appStoreVersionLocalizations",
          id: `N${index}`,
          attributes,
        })),
        links,
      });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  const client: AscClient = {
    get: vi.fn(appleIncludes(get)) as AscClient["get"],
    post: vi.fn((path: string) => {
      if (path === failPost) return Promise.reject(new Error("boom"));
      return Promise.resolve(
        path === "/v1/appStoreVersions"
          ? {
              data: {
                type: "appStoreVersions",
                id: "V9",
                attributes: { appVersionState: "PREPARE_FOR_SUBMISSION" },
              },
            }
          : { data: { type: "appStoreVersionLocalizations", id: "N9" } },
      );
    }) as AscClient["post"],
    patch: vi.fn(() => Promise.resolve({})) as AscClient["patch"],
    delete: vi.fn(() => Promise.reject(new Error("unexpected delete"))),
    upload: vi.fn(() => Promise.reject(new Error("unexpected upload"))),
    download: vi.fn(() => Promise.reject(new Error("unexpected download"))),
    downloadSigned: vi.fn(() =>
      Promise.reject(new Error("unexpected download")),
    ),
  };
  return client;
}

describe("versions create", () => {
  it("shows the version and what would be copied without writing", async () => {
    const client = versionsClient();
    const result = await run(
      [
        "versions",
        "create",
        "123",
        "--app-version",
        "2.5.0",
        "--copy-from",
        "V1",
        "--copyright",
        "2026 Example",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Dry run");
    expect(client.post).not.toHaveBeenCalled();
    expect(client.get).toHaveBeenCalledWith(
      "/v1/apps/123/appStoreVersions",
      expect.objectContaining({
        "filter[versionString]": "2.5.0",
        "filter[platform]": "IOS",
      }),
    );
    expect(result.json()).toMatchObject({
      dryRun: true,
      attributes: {
        platform: "IOS",
        versionString: "2.5.0",
        copyright: "2026 Example",
      },
      copyFrom: {
        versionId: "V1",
        version: "2.4.0",
        locales: [
          {
            locale: "en-US",
            fields: ["description", "keywords", "supportUrl"],
          },
          { locale: "fr-FR", fields: ["description"] },
        ],
      },
    });
  });

  it("creates the version and copies each locale, leaving What's New out", async () => {
    const client = versionsClient({
      targetLocales: [{ locale: "en-US", description: "An app" }],
    });
    const result = await run(
      [
        "versions",
        "create",
        "123",
        "--app-version",
        "2.5.0",
        "--platform",
        "IOS",
        "--copy-from",
        "V1",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/appStoreVersions", {
      data: {
        type: "appStoreVersions",
        attributes: { platform: "IOS", versionString: "2.5.0" },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appStoreVersionLocalizations/N0",
      {
        data: {
          type: "appStoreVersionLocalizations",
          id: "N0",
          attributes: {
            keywords: "app,tool",
            supportUrl: "https://example.com/help",
          },
        },
      },
    );
    expect(client.post).toHaveBeenCalledWith(
      "/v1/appStoreVersionLocalizations",
      {
        data: {
          type: "appStoreVersionLocalizations",
          attributes: { locale: "fr-FR", description: "Une app" },
          relationships: {
            appStoreVersion: { data: { type: "appStoreVersions", id: "V9" } },
          },
        },
      },
    );
    expect(result.json()).toMatchObject({
      dryRun: false,
      versionId: "V9",
      copied: [
        {
          locale: "en-US",
          action: "updated",
          fields: ["keywords", "supportUrl"],
        },
        { locale: "fr-FR", action: "created", fields: ["description"] },
      ],
    });
    expect(result.stdout).not.toContain("Old notes");
  });

  it("refuses a version string the app already has", async () => {
    const client = versionsClient({ existing: true });
    const result = await run(
      ["versions", "create", "123", "--app-version", "2.5.0", "--yes"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("already has IOS version 2.5.0");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("refuses to copy from another app's version", async () => {
    const client = versionsClient({ sourceApp: "999" });
    const result = await run(
      [
        "versions",
        "create",
        "123",
        "--app-version",
        "2.5.0",
        "--copy-from",
        "V1",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("belongs to app 999");
  });

  it("checks the release options", async () => {
    const client = versionsClient();
    const scheduled = await run(
      [
        "versions",
        "create",
        "123",
        "--app-version",
        "2.5.0",
        "--release-type",
        "SCHEDULED",
      ],
      client,
    );
    expect(scheduled.exitCode).toBe(1);
    expect(scheduled.stderr).toContain("needs --release-date");
    const past = await run(
      [
        "versions",
        "create",
        "123",
        "--app-version",
        "2.5.0",
        "--release-type",
        "SCHEDULED",
        "--release-date",
        "2020-01-01T00:00:00Z",
      ],
      client,
    );
    expect(past.exitCode).toBe(1);
    expect(past.stderr).toContain("has already passed");
    expect(client.get).not.toHaveBeenCalledWith(
      "/v1/appStoreVersions/V1",
      expect.anything(),
    );
  });

  it("names the locales already copied when copying stops partway", async () => {
    const client = versionsClient({
      failPost: "/v1/appStoreVersionLocalizations",
    });
    const result = await run(
      [
        "versions",
        "create",
        "123",
        "--app-version",
        "2.5.0",
        "--copy-from",
        "V1",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("was created (V9)");
    expect(result.stderr).toContain("copied only for en-US");
  });
});

describe("versions set", () => {
  it("shows the current and new release options without writing", async () => {
    const client = versionsClient();
    const result = await run(
      [
        "versions",
        "set",
        "V1",
        "--release-type",
        "SCHEDULED",
        "--release-date",
        "2099-01-01T09:00:00+08:00",
        "--copyright",
        "2025 Example",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).not.toHaveBeenCalled();
    expect(result.json()).toMatchObject({
      dryRun: true,
      current: { releaseType: "MANUAL", earliestReleaseDate: null },
      update: {
        releaseType: "SCHEDULED",
        earliestReleaseDate: "2099-01-01T01:00:00.000Z",
      },
      changes: true,
    });
    expect(result.json().update).not.toHaveProperty("copyright");
  });

  it("patches only what changed", async () => {
    const client = versionsClient();
    const result = await run(
      ["versions", "set", "V1", "--release-type", "AFTER_APPROVAL", "--yes"],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/appStoreVersions/V1", {
      data: {
        type: "appStoreVersions",
        id: "V1",
        attributes: { releaseType: "AFTER_APPROVAL" },
      },
    });
    expect(result.json()).toMatchObject({
      dryRun: false,
      changed: ["releaseType"],
    });
  });

  it("refuses a release date unless the release is scheduled", async () => {
    const client = versionsClient();
    const result = await run(
      ["versions", "set", "V1", "--release-date", "2099-01-01T00:00:00Z"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("give --release-type SCHEDULED");
  });

  it("refuses a version past the editable states", async () => {
    const client = versionsClient({ state: "WAITING_FOR_REVIEW" });
    const result = await run(
      [
        "versions",
        "set",
        "V1",
        "--release-type",
        "SCHEDULED",
        "--release-date",
        "2099-01-01T00:00:00Z",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("WAITING_FOR_REVIEW");
    expect(client.patch).not.toHaveBeenCalled();
  });
});
