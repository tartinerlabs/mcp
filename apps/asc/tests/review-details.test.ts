import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { createProgram } from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";

const SECRET = "hunter2-demo-secret";

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

let dir: string;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "asc-review-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

interface Setup {
  state?: string;
  detail?: Record<string, unknown> | null;
  /** Answer the detail read with 404 instead of null data. */
  missing404?: boolean;
}

function reviewClient({
  state = "PREPARE_FOR_SUBMISSION",
  detail = {
    contactFirstName: "Ada",
    contactLastName: "Lovelace",
    contactPhone: "+44 20 7946 0000",
    contactEmail: "ada@example.com",
    demoAccountRequired: true,
    demoAccountName: "demo",
    demoAccountPassword: SECRET,
    notes: "Tap Start.",
  },
  missing404 = false,
}: Setup = {}) {
  const get = vi.fn((path: string) => {
    if (path === "/v1/appStoreVersions/V1") {
      return Promise.resolve({
        data: {
          type: "appStoreVersions",
          id: "V1",
          attributes: {
            platform: "IOS",
            versionString: "2.0",
            appVersionState: state,
          },
        },
      });
    }
    if (path === "/v1/appStoreVersions/V1/appStoreReviewDetail") {
      if (missing404) return Promise.reject(new AscApiError(404, {}));
      return Promise.resolve({
        data: detail && {
          type: "appStoreReviewDetails",
          id: "RD1",
          attributes: detail,
        },
        included: detail
          ? [
              {
                type: "appStoreReviewAttachments",
                id: "AT1",
                attributes: {
                  fileName: "demo.mov",
                  fileSize: 10,
                  assetDeliveryState: { state: "COMPLETE" },
                  uploadOperations: [{ url: "https://upload.example/x" }],
                },
              },
            ]
          : [],
      });
    }
    if (path === "/v1/appStoreReviewAttachments/AT1") {
      return Promise.resolve({
        data: {
          type: "appStoreReviewAttachments",
          id: "AT1",
          attributes: {
            fileName: "demo.mov",
            fileSize: 10,
            assetDeliveryState: { state: "COMPLETE" },
          },
          relationships: {
            appStoreReviewDetail: {
              data: { type: "appStoreReviewDetails", id: "RD1" },
            },
          },
        },
      });
    }
    if (path === "/v1/appStoreReviewDetails/RD1") {
      return Promise.resolve({
        data: {
          type: "appStoreReviewDetails",
          id: "RD1",
          relationships: {
            appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } },
          },
        },
      });
    }
    if (path === "/v1/appStoreReviewAttachments/AT9") {
      return Promise.resolve({
        data: {
          type: "appStoreReviewAttachments",
          id: "AT9",
          attributes: {
            fileName: "demo.mov",
            fileSize: 6,
            assetDeliveryState: { state: "UPLOAD_COMPLETE" },
          },
        },
      });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  const client: AscClient = {
    get: get as AscClient["get"],
    post: vi.fn((path: string) =>
      Promise.resolve(
        path === "/v1/appStoreReviewDetails"
          ? { data: { type: "appStoreReviewDetails", id: "RD9" } }
          : {
              data: {
                type: "appStoreReviewAttachments",
                id: "AT9",
                attributes: {
                  uploadOperations: [
                    {
                      method: "PUT",
                      url: "https://upload.example/part1",
                      offset: 0,
                      length: 3,
                    },
                    {
                      method: "PUT",
                      url: "https://upload.example/part2",
                      offset: 3,
                      length: 3,
                    },
                  ],
                },
              },
            },
      ),
    ) as AscClient["post"],
    patch: vi.fn(() => Promise.resolve({})) as AscClient["patch"],
    delete: vi.fn(() => Promise.resolve()),
    upload: vi.fn(() => Promise.resolve()),
    download: vi.fn(() => Promise.reject(new Error("unexpected download"))),
    downloadSigned: vi.fn(() =>
      Promise.reject(new Error("unexpected download")),
    ),
  };
  return client;
}

describe("review-details", () => {
  it("shows the details and attachments without the password", async () => {
    const client = reviewClient();
    const result = await run(["review-details", "V1"], client);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stdout).not.toContain("upload.example");
    expect(result.json()).toMatchObject({
      version: { id: "V1", version: "2.0" },
      reviewDetail: {
        id: "RD1",
        contactEmail: "ada@example.com",
        demoAccountName: "demo",
        demoAccountPasswordSet: true,
        attachments: [{ id: "AT1", fileName: "demo.mov", state: "COMPLETE" }],
      },
      missing: [],
    });
  });

  it.each([[{ detail: null }], [{ missing404: true }]] as [Setup][])(
    "reports what is missing for a version without details (%o)",
    async (setup) => {
      const client = reviewClient(setup);
      const result = await run(["review-details", "V1"], client);
      expect(result.exitCode).toBe(0);
      expect(result.json()).toMatchObject({
        reviewDetail: null,
        missing: [
          "contactFirstName",
          "contactLastName",
          "contactPhone",
          "contactEmail",
        ],
      });
    },
  );
});

describe("review-details set", () => {
  it("hides the password in a dry run", async () => {
    const client = reviewClient();
    const result = await run(
      [
        "review-details",
        "set",
        "V1",
        "--notes",
        "Tap Begin.",
        "--contact-email",
        "ada@example.com",
        "--demo-account-password",
        SECRET,
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).not.toHaveBeenCalled();
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
    expect(result.json()).toMatchObject({
      dryRun: true,
      current: { notes: "Tap Start.", contactEmail: "ada@example.com" },
      update: { notes: "Tap Begin.", demoAccountPassword: "[hidden]" },
      changes: true,
    });
    expect(result.json().update).not.toHaveProperty("contactEmail");
  });

  it("patches the changes, taking the password from the environment", async () => {
    vi.stubEnv("ASC_DEMO_ACCOUNT_PASSWORD", SECRET);
    const client = reviewClient();
    const result = await run(
      ["review-details", "set", "V1", "--no-demo-account-required", "--yes"],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.patch).toHaveBeenCalledWith("/v1/appStoreReviewDetails/RD1", {
      data: {
        type: "appStoreReviewDetails",
        id: "RD1",
        attributes: { demoAccountRequired: false, demoAccountPassword: SECRET },
      },
    });
    expect(result.stdout).not.toContain(SECRET);
    expect(result.json()).toMatchObject({
      dryRun: false,
      changed: ["demoAccountRequired", "demoAccountPassword"],
    });
  });

  it("creates the details when the version has none", async () => {
    const client = reviewClient({ detail: null });
    const result = await run(
      [
        "review-details",
        "set",
        "V1",
        "--contact-first-name",
        "Ada",
        "--contact-phone",
        "+44 20 7946 0000",
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/appStoreReviewDetails", {
      data: {
        type: "appStoreReviewDetails",
        attributes: {
          contactFirstName: "Ada",
          contactPhone: "+44 20 7946 0000",
        },
        relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } },
        },
      },
    });
    expect(result.json()).toMatchObject({ reviewDetailId: "RD9" });
  });

  it("keeps the password out of Apple's error message", async () => {
    const client = reviewClient();
    vi.mocked(client.patch).mockRejectedValue(
      new AscApiError(409, {
        errors: [{ detail: `The password '${SECRET}' is too short.` }],
      }),
    );
    const result = await run(
      [
        "review-details",
        "set",
        "V1",
        "--demo-account-password",
        SECRET,
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[hidden]");
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
  });

  it("refuses a version past the editable states", async () => {
    const client = reviewClient({ state: "IN_REVIEW" });
    const result = await run(
      ["review-details", "set", "V1", "--notes", "x", "--yes"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("refuses an invalid email without echoing a password", async () => {
    const client = reviewClient();
    const result = await run(
      [
        "review-details",
        "set",
        "V1",
        "--contact-email",
        "nope",
        "--demo-account-password",
        SECRET,
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("email address");
    expect(result.stderr).not.toContain(SECRET);
  });
});

describe("review-details attach and detach", () => {
  it("shows the file without uploading", async () => {
    const file = join(dir, "demo.mov");
    await writeFile(file, "abcdef");
    const client = reviewClient();
    const result = await run(["review-details", "attach", "V1", file], client);
    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
    expect(result.json()).toMatchObject({
      dryRun: true,
      reviewDetailId: "RD1",
      file: { fileName: "demo.mov", fileSize: 6 },
    });
  });

  it("reserves, sends each part and commits the attachment", async () => {
    const file = join(dir, "demo.mov");
    await writeFile(file, "abcdef");
    const client = reviewClient({ detail: null });
    const result = await run(
      ["review-details", "attach", "V1", file, "--yes"],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/appStoreReviewAttachments", {
      data: {
        type: "appStoreReviewAttachments",
        attributes: { fileName: "demo.mov", fileSize: 6 },
        relationships: {
          appStoreReviewDetail: {
            data: { type: "appStoreReviewDetails", id: "RD9" },
          },
        },
      },
    });
    const parts = vi
      .mocked(client.upload)
      .mock.calls.map(([op, part]) => [op.url, new TextDecoder().decode(part)]);
    expect(parts).toEqual([
      ["https://upload.example/part1", "abc"],
      ["https://upload.example/part2", "def"],
    ]);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/appStoreReviewAttachments/AT9",
      {
        data: {
          type: "appStoreReviewAttachments",
          id: "AT9",
          attributes: {
            uploaded: true,
            sourceFileChecksum: createHash("md5")
              .update("abcdef")
              .digest("hex"),
          },
        },
      },
    );
    expect(result.json()).toMatchObject({
      dryRun: false,
      reviewDetailId: "RD9",
      attachment: { id: "AT9", state: "UPLOAD_COMPLETE" },
    });
  });

  it("names the reserved attachment when the upload fails", async () => {
    const file = join(dir, "demo.mov");
    await writeFile(file, "abcdef");
    const client = reviewClient();
    vi.mocked(client.upload).mockRejectedValue(new AscApiError(500, {}));
    const result = await run(
      ["review-details", "attach", "V1", file, "--yes"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("review-details detach AT9");
  });

  it("removes an attachment after showing it", async () => {
    const client = reviewClient();
    const dry = await run(["review-details", "detach", "AT1"], client);
    expect(dry.exitCode).toBe(0);
    expect(client.delete).not.toHaveBeenCalled();
    expect(dry.json()).toMatchObject({
      dryRun: true,
      version: { id: "V1" },
      attachment: { id: "AT1", fileName: "demo.mov" },
    });
    const done = await run(
      ["review-details", "detach", "AT1", "--yes"],
      client,
    );
    expect(done.exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith(
      "/v1/appStoreReviewAttachments/AT1",
    );
  });
});
