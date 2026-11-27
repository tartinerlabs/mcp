import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AscClient, createAscClient } from "../src/asc/client.ts";
import { createS3Uploader, type S3Uploader, signV4 } from "../src/asc/s3.ts";
import {
  type AscClientProvider,
  createProgram,
  type ProgramOptions,
} from "../src/cli.ts";
import { AscApiError, InvalidInputError } from "../src/utils/errors.ts";
import { generateP256Pem } from "./helpers.ts";

const ISSUER = "69a6de70-03db-47e3-e053-5b8c7c11a4d1";
const TEAM = ["--issuer-id", ISSUER];
const ID = "2efe2717-52ef-43a5-96dc-0797e4ca1041";
const NOTARY = "https://appstoreconnect.apple.com/notary/v2";
// Placeholders shaped like Apple's documented example; not real credentials.
const ATTRIBUTES = {
  awsAccessKeyId: "ASIA-EXAMPLE",
  awsSecretAccessKey: "secret-example",
  awsSessionToken: "session-example",
  bucket: "notary-submissions-prod",
  object: "prod/AAAA/upload.zip",
};

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
  vi.stubEnv("ASC_ISSUER_ID", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const content = "notarize me";

async function software(name = "App.zip") {
  const dir = await mkdtemp(join(tmpdir(), "asc-notarize-"));
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

/** A client whose submission reports the given statuses in turn. */
function notaryClient(statuses: string[] = ["In Progress"]) {
  let polls = 0;
  const client: AscClient = {
    get: vi.fn(async (path: string) => {
      if (path === `${NOTARY}/submissions/${ID}`) {
        const status = statuses[Math.min(polls++, statuses.length - 1)];
        return {
          data: {
            type: "submissions",
            id: ID,
            attributes: {
              name: "App.zip",
              status,
              createdDate: "2026-11-27T01:00:00.000Z",
            },
          },
        };
      }
      if (path === `${NOTARY}/submissions/${ID}/logs`) {
        return {
          data: { attributes: { developerLogUrl: "https://logs.example/1" } },
        };
      }
      if (path === `${NOTARY}/submissions`) {
        return {
          data: [
            {
              type: "submissions",
              id: ID,
              attributes: { name: "App.zip", status: "Accepted" },
            },
          ],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    }) as AscClient["get"],
    post: vi.fn(async () => ({
      data: { type: "newSubmissions", id: ID, attributes: ATTRIBUTES },
    })) as AscClient["post"],
    patch: vi.fn(() => Promise.reject(new Error("unexpected patch"))),
    delete: vi.fn(() => Promise.reject(new Error("unexpected delete"))),
    upload: vi.fn(() => Promise.reject(new Error("unexpected upload"))),
    download: vi.fn(() => Promise.reject(new Error("unexpected download"))),
    downloadSigned: vi.fn(async () =>
      new TextEncoder().encode(
        JSON.stringify({
          jobId: ID,
          status: "Invalid",
          statusSummary: "Archive contains critical validation errors",
          issues: [
            {
              severity: "error",
              path: "App.zip/App.app/Contents/MacOS/App",
              message: "The binary is not signed.",
              architecture: "arm64",
            },
          ],
          ticketContents: [{ path: "a" }, { path: "b" }],
        }),
      ),
    ),
  };
  return { client, provider: vi.fn<AscClientProvider>(() => client) };
}

const fakes = (upload: S3Uploader = vi.fn(async () => {})) => ({
  notaryUpload: upload,
  sleep: async () => {},
  now: () => 0,
});

describe("notarize submit", () => {
  it("should refuse an individual key before calling Apple", async () => {
    const { client, provider } = notaryClient();
    const result = await run(
      ["notarize", "submit", await software()],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[permission] Notarization needs a team API key",
    );
    expect(client.get).not.toHaveBeenCalled();
  });

  it("should print the file's name, size and SHA-256 without --yes", async () => {
    const { client, provider } = notaryClient();
    const upload = vi.fn<S3Uploader>(async () => {});
    const result = await run(
      [...TEAM, "notarize", "submit", await software()],
      provider,
      fakes(upload),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Dry run");
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "notarize",
      file: {
        name: "App.zip",
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    });
    expect(client.post).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("should create the submission, upload to Apple's bucket and print the status with --yes", async () => {
    const { client, provider } = notaryClient();
    const upload = vi.fn<S3Uploader>(async () => {});
    const file = await software();
    const result = await run(
      [...TEAM, "notarize", "submit", file, "--yes"],
      provider,
      fakes(upload),
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith(`${NOTARY}/submissions`, {
      submissionName: "App.zip",
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(upload).toHaveBeenCalledWith(
      {
        accessKeyId: ATTRIBUTES.awsAccessKeyId,
        secretAccessKey: ATTRIBUTES.awsSecretAccessKey,
        sessionToken: ATTRIBUTES.awsSessionToken,
        bucket: ATTRIBUTES.bucket,
        object: ATTRIBUTES.object,
      },
      { path: file, size: content.length },
    );
    const output = JSON.parse(result.stdout);
    expect(output.submission).toEqual({
      id: ID,
      name: "App.zip",
      status: "In Progress",
      createdDate: "2026-11-27T01:00:00.000Z",
    });
    // The temporary S3 credentials never reach the output.
    expect(result.stdout).not.toContain(ATTRIBUTES.awsSecretAccessKey);
    expect(result.stdout).not.toContain(ATTRIBUTES.awsSessionToken);
  });

  it("should wait until Apple finishes, and exit 1 when the file is Invalid", async () => {
    const accepted = notaryClient(["In Progress", "In Progress", "Accepted"]);
    let result = await run(
      [...TEAM, "notarize", "submit", await software(), "--yes", "--wait"],
      accepted.provider,
      fakes(),
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).submission.status).toBe("Accepted");
    expect(result.stderr).toContain(`${ID}: In Progress`);

    vi.mocked(console.log).mockClear();
    const invalid = notaryClient(["Invalid"]);
    result = await run(
      [...TEAM, "notarize", "submit", await software(), "--yes", "--wait"],
      invalid.provider,
      fakes(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Notarization finished as Invalid");
  });

  it("should give up after --timeout", async () => {
    const { provider } = notaryClient(["In Progress"]);
    let clock = 0;
    const result = await run(
      [
        ...TEAM,
        "notarize",
        "submit",
        await software(),
        "--yes",
        "--wait",
        "--timeout",
        "1",
      ],
      provider,
      {
        ...fakes(),
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[unavailable]");
    expect(result.stderr).toContain("still in progress after 1 minutes");
  });

  it("should name the submission when the upload fails, without the credentials", async () => {
    const { provider } = notaryClient();
    const upload = vi.fn<S3Uploader>(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    const result = await run(
      [...TEAM, "notarize", "submit", await software(), "--yes"],
      provider,
      fakes(upload),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(ID);
    expect(result.stderr).not.toContain(ATTRIBUTES.awsSecretAccessKey);
  });

  it("should refuse a file the notary service does not take", async () => {
    const { client, provider } = notaryClient();
    const result = await run(
      [...TEAM, "notarize", "submit", await software("App.ipa"), "--yes"],
      provider,
      fakes(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a .zip, .pkg or .dmg");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should explain a refused key as [permission]", async () => {
    const { client, provider } = notaryClient();
    vi.mocked(client.post).mockRejectedValueOnce(new AscApiError(403, {}));
    const result = await run(
      [...TEAM, "notarize", "submit", await software(), "--yes"],
      provider,
      fakes(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[permission] Apple's Notary API refused");
  });
});

describe("notarize status, log and history", () => {
  it("should print one submission's status", async () => {
    const { provider } = notaryClient(["Accepted"]);
    const result = await run([...TEAM, "notarize", "status", ID], provider);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: ID,
      status: "Accepted",
    });
  });

  it("should refuse a submission id that is not a UUID", async () => {
    const { client, provider } = notaryClient();
    const result = await run(
      [...TEAM, "notarize", "status", "../apps"],
      provider,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("should read the log from Apple's URL and count the ticket contents", async () => {
    const { client, provider } = notaryClient();
    const result = await run([...TEAM, "notarize", "log", ID], provider);
    expect(result.exitCode).toBe(0);
    expect(client.downloadSigned).toHaveBeenCalledWith(
      "https://logs.example/1",
    );
    const output = JSON.parse(result.stdout);
    expect(output.status).toBe("Invalid");
    expect(output.issues).toHaveLength(1);
    expect(output.issues[0].message).toBe("The binary is not signed.");
    expect(output.ticketContents).toBe(2);
  });

  it("should list recent submissions", async () => {
    const { provider } = notaryClient();
    const result = await run([...TEAM, "notarize", "history"], provider);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      submissions: [
        {
          id: ID,
          name: "App.zip",
          status: "Accepted",
          createdDate: undefined,
        },
      ],
    });
  });
});

describe("S3 upload", () => {
  it("should sign like AWS's documented SigV4 example", () => {
    // GET Object example from the Amazon S3 SigV4 documentation.
    const authorization = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: {
        range: "bytes=0-9",
        "x-amz-content-sha256":
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date": "20130524T000000Z",
      },
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "s3",
      amzDate: "20130524T000000Z",
      payloadHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("should send the file in parts to the bucket Apple named, then complete the upload", async () => {
    const file = await software();
    const sent: { url: URL; init: RequestInit }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init = {}) => {
      const target = new URL(String(url));
      sent.push({ url: target, init });
      if (target.searchParams.has("uploads")) {
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>U1</UploadId></InitiateMultipartUploadResult>",
        );
      }
      if (target.searchParams.has("partNumber")) {
        return new Response(null, {
          headers: { etag: `"e${target.searchParams.get("partNumber")}"` },
        });
      }
      return new Response("<CompleteMultipartUploadResult/>");
    });
    await createS3Uploader({ fetch, now: () => 0, partSize: 5 })(
      {
        accessKeyId: "ASIA-EXAMPLE",
        secretAccessKey: "secret-example",
        sessionToken: "session-example",
        bucket: "notary-submissions-prod",
        object: "prod/AAAA/upload.zip",
      },
      { path: file, size: content.length },
    );

    expect(
      sent.every(
        ({ url }) =>
          url.origin ===
            "https://notary-submissions-prod.s3-accelerate.amazonaws.com" &&
          url.pathname === "/prod/AAAA/upload.zip",
      ),
    ).toBe(true);
    // Start, three parts of at most 5 bytes, complete.
    expect(sent.map(({ init }) => init.method)).toEqual([
      "POST",
      "PUT",
      "PUT",
      "PUT",
      "POST",
    ]);
    const parts = sent.slice(1, 4).map(({ init }) => init.body as Uint8Array);
    expect(Buffer.concat(parts).toString()).toBe(content);
    expect(sent[4]?.init.body).toBe(
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"e1"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"e2"</ETag></Part><Part><PartNumber>3</PartNumber><ETag>"e3"</ETag></Part></CompleteMultipartUpload>',
    );
    for (const { init } of sent) {
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=ASIA-EXAMPLE\/19700101\/us-west-2\/s3\/aws4_request, /,
      );
      expect(headers["x-amz-security-token"]).toBe("session-example");
    }
  });

  it("should report an S3 error in a 200 response without the credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response("<Error><Code>AccessDenied</Code></Error>", {
          status: 403,
        }),
    );
    const upload = createS3Uploader({ fetch, now: () => 0 })(
      {
        accessKeyId: "ASIA-EXAMPLE",
        secretAccessKey: "secret-example",
        sessionToken: "session-example",
        bucket: "notary-submissions-prod",
        object: "upload.zip",
      },
      { path: await software(), size: content.length },
    );
    await expect(upload).rejects.toThrow(/HTTP 403 \(AccessDenied\)/);
    await expect(upload).rejects.not.toThrow(/secret-example/);
  });

  it("should refuse a destination that is not a bucket name", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createS3Uploader({ fetch })(
        {
          accessKeyId: "a",
          secretAccessKey: "b",
          sessionToken: "c",
          bucket: "evil.example/x",
          object: "o",
        },
        { path: await software(), size: content.length },
      ),
    ).rejects.toThrow(/not an S3 bucket/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("App Store Connect client host check", () => {
  it("should send the token to the API and the Notary API, and refuse any other host", async () => {
    const { pem } = await generateP256Pem();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json({ data: [] }));
    const client = await createAscClient(
      { keyId: "2X9R4HXF34", issuerId: ISSUER, privateKey: pem },
      { fetch },
    );
    await client.get("/v1/apps");
    await client.get(`${NOTARY}/submissions`);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.appstoreconnect.apple.com/v1/apps",
      `${NOTARY}/submissions`,
    ]);

    for (const path of [
      "https://evil.example/v1/apps",
      "//evil.example/v1/apps",
      "http://api.appstoreconnect.apple.com/v1/apps",
      "https://appstoreconnect.apple.com/v1/apps",
    ]) {
      await expect(client.get(path)).rejects.toBeInstanceOf(InvalidInputError);
      await expect(client.post(path, {})).rejects.toBeInstanceOf(
        InvalidInputError,
      );
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
