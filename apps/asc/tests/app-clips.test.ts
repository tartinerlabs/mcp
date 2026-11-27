import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient, AscQuery } from "../src/asc/client.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";

/** A client answering reads from `routes` (unknown paths are a 404) and recording writes. */
function routed(routes: Record<string, unknown>) {
  const client: AscClient = {
    get: vi.fn((path: string, _query?: AscQuery) =>
      path in routes
        ? Promise.resolve(routes[path])
        : Promise.reject(new AscApiError(404, { errors: [] })),
    ) as AscClient["get"],
    post: vi.fn((path: string, body: unknown) => {
      const data = (body as { data: { type: string } }).data;
      if (path.endsWith("Images")) {
        return Promise.resolve({
          data: {
            type: data.type,
            id: "IMG1",
            attributes: {
              uploadOperations: [
                {
                  method: "PUT",
                  url: "https://upload.example/1",
                  offset: 0,
                  length: 10,
                },
              ],
            },
          },
        });
      }
      return Promise.resolve({
        data: { ...data, id: "NEW1", attributes: { status: "RECEIVED" } },
      });
    }) as AscClient["post"],
    patch: vi.fn(() => Promise.resolve({})) as AscClient["patch"],
    delete: vi.fn(() => Promise.resolve()) as AscClient["delete"],
    upload: vi.fn(() => Promise.resolve()),
    download: vi.fn(() => Promise.reject(new Error("unexpected"))),
    downloadSigned: vi.fn(() => Promise.reject(new Error("unexpected"))),
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

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A default experience with an en-US localization (with a header image) and, optionally, a review detail. */
function defaultExperience(review = true) {
  const experience = {
    type: "appClipDefaultExperiences",
    id: "D1",
    attributes: { action: "OPEN" },
    relationships: {
      appClipDefaultExperienceLocalizations: {
        data: [
          { type: "appClipDefaultExperienceLocalizations", id: "L1" },
          { type: "appClipDefaultExperienceLocalizations", id: "L2" },
        ],
      },
      appClipAppStoreReviewDetail: {
        data: review
          ? { type: "appClipAppStoreReviewDetails", id: "R1" }
          : null,
      },
      releaseWithAppStoreVersion: { data: null },
    },
  };
  const included = [
    {
      type: "appClipDefaultExperienceLocalizations",
      id: "L1",
      attributes: { locale: "en-US", subtitle: "Order coffee" },
    },
    {
      type: "appClipDefaultExperienceLocalizations",
      id: "L2",
      attributes: { locale: "ja", subtitle: null },
    },
    ...(review
      ? [
          {
            type: "appClipAppStoreReviewDetails",
            id: "R1",
            attributes: { invocationUrls: ["https://example.com/clip"] },
          },
        ]
      : []),
  ];
  return { experience, included };
}

const headerImage = {
  data: {
    type: "appClipHeaderImages",
    id: "H1",
    attributes: {
      fileName: "header.png",
      assetDeliveryState: { state: "COMPLETE", errors: [] },
    },
  },
};

const advancedExperience = {
  type: "appClipAdvancedExperiences",
  id: "A1",
  attributes: {
    link: "https://example.com/store/1",
    status: "RECEIVED",
    placeStatus: "MATCHED",
    action: "VIEW",
    businessCategory: "FOOD_AND_DRINK",
    defaultLanguage: "EN",
    isPoweredBy: false,
    place: { names: ["Example Café"] },
  },
  relationships: {
    localizations: {
      data: [{ type: "appClipAdvancedExperienceLocalizations", id: "AL1" }],
    },
    headerImage: { data: null },
  },
};

const advancedIncluded = [
  {
    type: "appClipAdvancedExperienceLocalizations",
    id: "AL1",
    attributes: { language: "EN", title: "Café", subtitle: "Order ahead" },
  },
];

function defaultRoutes(review = true) {
  const { experience, included } = defaultExperience(review);
  return {
    "/v1/appClipDefaultExperiences/D1": { data: experience, included },
    "/v1/appClipDefaultExperienceLocalizations/L1/appClipHeaderImage":
      headerImage,
  };
}

async function image(name = "header.png") {
  const dir = await mkdtemp(join(tmpdir(), "asc-app-clips-"));
  const path = join(dir, name);
  await writeFile(path, "0123456789");
  return path;
}

describe("app-clips", () => {
  it("should list each App Clip with its default and advanced experiences", async () => {
    const { experience, included } = defaultExperience();
    const { provider } = routed({
      "/v1/apps/123/appClips": {
        data: [
          {
            type: "appClips",
            id: "C1",
            attributes: { bundleId: "com.example.app.Clip" },
          },
        ],
      },
      "/v1/appClips/C1/appClipDefaultExperiences": {
        data: [experience],
        included,
      },
      "/v1/appClipDefaultExperienceLocalizations/L1/appClipHeaderImage":
        headerImage,
      "/v1/appClips/C1/appClipAdvancedExperiences": {
        data: [advancedExperience],
        included: advancedIncluded,
      },
    });
    const { exitCode, stdout } = await run(["app-clips", "123"], provider);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).appClips).toEqual([
      {
        id: "C1",
        bundleId: "com.example.app.Clip",
        defaultExperiences: [
          {
            id: "D1",
            action: "OPEN",
            releaseWithVersion: null,
            localizations: [
              {
                id: "L1",
                locale: "en-US",
                subtitle: "Order coffee",
                headerImage: {
                  id: "H1",
                  fileName: "header.png",
                  state: "COMPLETE",
                  errors: [],
                },
              },
              { id: "L2", locale: "ja", subtitle: null, headerImage: null },
            ],
            reviewDetail: {
              id: "R1",
              invocationUrls: ["https://example.com/clip"],
            },
          },
        ],
        advancedExperiences: [
          {
            id: "A1",
            link: "https://example.com/store/1",
            status: "RECEIVED",
            placeStatus: "MATCHED",
            action: "VIEW",
            businessCategory: "FOOD_AND_DRINK",
            defaultLanguage: "EN",
            isPoweredBy: false,
            place: "Example Café",
            localizations: [
              { language: "EN", title: "Café", subtitle: "Order ahead" },
            ],
            headerImage: null,
          },
        ],
      },
    ]);
  });

  it("should print the change to a default experience without --yes", async () => {
    const { client, provider } = routed(defaultRoutes());
    const { exitCode, stdout, stderr } = await run(
      [
        "app-clips",
        "default",
        "set",
        "D1",
        "--locale",
        "fr-FR",
        "--subtitle",
        "Commander",
      ],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Dry run");
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toMatchObject({
      newLocale: true,
      changes: true,
    });
  });

  it("should change the action and add a locale's subtitle", async () => {
    const { client, provider } = routed(defaultRoutes());
    const { exitCode, stdout } = await run(
      [
        "app-clips",
        "default",
        "set",
        "D1",
        "--action",
        "PLAY",
        "--locale",
        "fr-FR",
        "--subtitle",
        "Commander",
        "--yes",
      ],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appClipDefaultExperiences/D1",
      {
        data: {
          type: "appClipDefaultExperiences",
          id: "D1",
          attributes: { action: "PLAY" },
        },
      },
    );
    expect(client.post).toHaveBeenCalledWith(
      "/v1/appClipDefaultExperienceLocalizations",
      {
        data: {
          type: "appClipDefaultExperienceLocalizations",
          attributes: { locale: "fr-FR", subtitle: "Commander" },
          relationships: {
            appClipDefaultExperience: {
              data: { type: "appClipDefaultExperiences", id: "D1" },
            },
          },
        },
      },
    );
    expect(JSON.parse(stdout).changed).toEqual(["action", "subtitle"]);
  });

  it("should patch an existing locale's subtitle only when it changes", async () => {
    const { client, provider } = routed(defaultRoutes());
    await run(
      [
        "app-clips",
        "default",
        "set",
        "D1",
        "--action",
        "OPEN",
        "--locale",
        "en-US",
        "--subtitle",
        "Order tea",
        "--yes",
      ],
      provider,
    );
    expect(client.patch).toHaveBeenCalledTimes(1);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appClipDefaultExperienceLocalizations/L1",
      {
        data: {
          type: "appClipDefaultExperienceLocalizations",
          id: "L1",
          attributes: { subtitle: "Order tea" },
        },
      },
    );
  });

  it("should replace a locale's header image", async () => {
    const file = await image();
    const { client, provider } = routed(defaultRoutes());
    const { exitCode, stdout } = await run(
      [
        "app-clips",
        "header-image",
        "upload",
        "D1",
        "--locale",
        "en-US",
        "--file",
        file,
        "--yes",
      ],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith("/v1/appClipHeaderImages/H1");
    expect(client.post).toHaveBeenCalledWith("/v1/appClipHeaderImages", {
      data: {
        type: "appClipHeaderImages",
        attributes: { fileName: "header.png", fileSize: 10 },
        relationships: {
          appClipDefaultExperienceLocalization: {
            data: { type: "appClipDefaultExperienceLocalizations", id: "L1" },
          },
        },
      },
    });
    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(client.patch).toHaveBeenCalledWith("/v1/appClipHeaderImages/IMG1", {
      data: {
        type: "appClipHeaderImages",
        id: "IMG1",
        attributes: {
          uploaded: true,
          sourceFileChecksum: createHash("md5")
            .update("0123456789")
            .digest("hex"),
        },
      },
    });
    expect(JSON.parse(stdout).imageId).toBe("IMG1");
  });

  it("should refuse a header image for a locale the experience lacks", async () => {
    const file = await image();
    const { client, provider } = routed(defaultRoutes());
    const { exitCode, stderr } = await run(
      [
        "app-clips",
        "header-image",
        "upload",
        "D1",
        "--locale",
        "de-DE",
        "--file",
        file,
        "--yes",
      ],
      provider,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("[not_found]");
    expect(stderr).toContain("app-clips default set --locale de-DE");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should refuse a header image that is not a PNG or JPEG", async () => {
    const file = await image("header.gif");
    const { client, provider } = routed(defaultRoutes());
    const { exitCode, stderr } = await run(
      [
        "app-clips",
        "header-image",
        "upload",
        "D1",
        "--locale",
        "en-US",
        "--file",
        file,
      ],
      provider,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("should update or create the review detail's invocation URLs", async () => {
    const existing = routed(defaultRoutes());
    await run(
      [
        "app-clips",
        "review-detail",
        "set",
        "D1",
        "--invocation-url",
        "https://example.com/a,https://example.com/b",
        "--yes",
      ],
      existing.provider,
    );
    expect(existing.client.patch).toHaveBeenCalledWith(
      "/v1/appClipAppStoreReviewDetails/R1",
      {
        data: {
          type: "appClipAppStoreReviewDetails",
          id: "R1",
          attributes: {
            invocationUrls: ["https://example.com/a", "https://example.com/b"],
          },
        },
      },
    );

    const missing = routed(defaultRoutes(false));
    await run(
      [
        "app-clips",
        "review-detail",
        "set",
        "D1",
        "--invocation-url",
        "https://example.com/a",
        "--yes",
      ],
      missing.provider,
    );
    expect(missing.client.post).toHaveBeenCalledWith(
      "/v1/appClipAppStoreReviewDetails",
      {
        data: {
          type: "appClipAppStoreReviewDetails",
          attributes: { invocationUrls: ["https://example.com/a"] },
          relationships: {
            appClipDefaultExperience: {
              data: { type: "appClipDefaultExperiences", id: "D1" },
            },
          },
        },
      },
    );
  });

  it("should upload the header image, then create the advanced experience", async () => {
    const file = await image();
    const { client, provider } = routed({
      "/v1/appClips/C1": {
        data: { type: "appClips", id: "C1", attributes: {} },
      },
    });
    const { exitCode, stdout } = await run(
      [
        "app-clips",
        "advanced",
        "create",
        "C1",
        "--link",
        "https://example.com/store/2",
        "--default-language",
        "EN",
        "--title",
        "Café",
        "--subtitle",
        "Order ahead",
        "--image",
        file,
        "--business-category",
        "FOOD_AND_DRINK",
        "--yes",
      ],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      "/v1/appClipAdvancedExperienceImages",
      {
        data: {
          type: "appClipAdvancedExperienceImages",
          attributes: { fileName: "header.png", fileSize: 10 },
        },
      },
    );
    const body = vi.mocked(client.post).mock.calls[1]?.[1] as {
      data: {
        attributes: unknown;
        relationships: Record<string, { data: unknown }>;
      };
      included: { id: string; attributes: unknown }[];
    };
    expect(body.data.attributes).toEqual({
      link: "https://example.com/store/2",
      defaultLanguage: "EN",
      isPoweredBy: false,
      businessCategory: "FOOD_AND_DRINK",
    });
    expect(body.data.relationships.headerImage?.data).toEqual({
      type: "appClipAdvancedExperienceImages",
      id: "IMG1",
    });
    const localization = body.included[0];
    expect(body.data.relationships.localizations?.data).toEqual([
      { type: "appClipAdvancedExperienceLocalizations", id: localization?.id },
    ]);
    expect(localization?.attributes).toEqual({
      language: "EN",
      title: "Café",
      subtitle: "Order ahead",
    });
    expect(JSON.parse(stdout)).toMatchObject({
      experienceId: "NEW1",
      status: "RECEIVED",
    });
  });

  it("should patch only the changed fields of an advanced experience", async () => {
    const { client, provider } = routed({
      "/v1/appClipAdvancedExperiences/A1": {
        data: advancedExperience,
        included: advancedIncluded,
      },
    });
    const { exitCode, stdout } = await run(
      [
        "app-clips",
        "advanced",
        "set",
        "A1",
        "--action",
        "VIEW",
        "--powered-by",
        "true",
        "--yes",
      ],
      provider,
    );
    expect(exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appClipAdvancedExperiences/A1",
      {
        data: {
          type: "appClipAdvancedExperiences",
          id: "A1",
          attributes: { isPoweredBy: true },
        },
      },
    );
    expect(JSON.parse(stdout).changed).toEqual(["isPoweredBy"]);
  });

  it("should mark an advanced experience removed", async () => {
    const { client, provider } = routed({
      "/v1/appClipAdvancedExperiences/A1": {
        data: advancedExperience,
        included: advancedIncluded,
      },
    });
    const dry = await run(["app-clips", "advanced", "remove", "A1"], provider);
    expect(dry.exitCode).toBe(0);
    expect(client.patch).not.toHaveBeenCalled();
    await run(["app-clips", "advanced", "remove", "A1", "--yes"], provider);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appClipAdvancedExperiences/A1",
      {
        data: {
          type: "appClipAdvancedExperiences",
          id: "A1",
          attributes: { removed: true },
        },
      },
    );
  });
});
