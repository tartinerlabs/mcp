import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAscClient } from "../src/asc/client.ts";
import { readCredentials } from "../src/asc/credentials.ts";
import { createProgram } from "../src/cli.ts";
import { type AscKey, keySchema } from "../src/schemas/common.ts";
import {
  AscApiError,
  CredentialsError,
  NetworkError,
  UnexpectedResponseError,
} from "../src/utils/errors.ts";

const ISSUER = "69a6de70-03db-47e3-e053-5b8c7c11a4d1";
const NOW = 1_800_000_000_000;

let pem: string;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
  publicKey = pair.publicKey;
});

function key(keyId: string, issuerId: string): AscKey {
  return { keyId, issuerId, privateKey: pem };
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(
    atob(part.replaceAll("-", "+").replaceAll("_", "/")),
  ) as Record<string, unknown>;
}

function stubFetch(response: Response) {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
}

function clientFor(key: AscKey, fetch: typeof globalThis.fetch) {
  return createAscClient(key, { fetch, now: () => NOW });
}

/** The bearer token the client sent on a request (the first by default). */
function sentToken(fetch: ReturnType<typeof stubFetch>, call = 0): string {
  const init = fetch.mock.calls[call]?.[1] as RequestInit;
  const header = (init.headers as Record<string, string>).authorization ?? "";
  expect(header).toMatch(/^Bearer /);
  return header.slice("Bearer ".length);
}

describe("createAscClient", () => {
  it("should sign a 2-minute ES256 team token with iss and kid", async () => {
    const fetch = stubFetch(Response.json({ data: [] }));
    const client = await clientFor(key("TEAMKEY001", ISSUER), fetch);
    await client.get("/v1/apps", { limit: 1 });

    const token = sentToken(fetch);
    const [header = "", payload = "", signature = ""] = token.split(".");
    expect(decode(header)).toEqual({
      kid: "TEAMKEY001",
      typ: "JWT",
      alg: "ES256",
    });
    const claims = decode(payload);
    expect(claims).toEqual({
      iss: ISSUER,
      iat: NOW / 1000,
      exp: NOW / 1000 + 120,
      aud: "appstoreconnect-v1",
    });
    const raw = Uint8Array.from(
      atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        raw,
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
  });

  it("should use sub: user and no iss for an individual key", async () => {
    const fetch = stubFetch(Response.json({ data: [] }));
    const client = await clientFor(key("SOLOKEY001", ""), fetch);
    await client.get("/v1/apps");
    const claims = decode(sentToken(fetch).split(".")[1] ?? "");
    expect(claims).toEqual({
      sub: "user",
      iat: NOW / 1000,
      exp: NOW / 1000 + 120,
      aud: "appstoreconnect-v1",
    });
  });

  it("should sign a fresh token for every request", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json({ data: [] }));
    let now = NOW;
    const client = await createAscClient(key("TEAMKEY001", ISSUER), {
      fetch,
      now: () => (now += 1000),
    });
    await client.get("/v1/apps");
    await client.get("/v1/apps");
    const iats = [0, 1].map(
      (call) => decode(sentToken(fetch, call).split(".")[1] ?? "").iat,
    );
    expect(iats).toEqual([NOW / 1000 + 1, NOW / 1000 + 2]);
  });

  it("should call App Store Connect with comma-joined arrays and no undefined values", async () => {
    const fetch = stubFetch(Response.json({ data: [] }));
    const client = await clientFor(key("TEAMKEY001", ISSUER), fetch);
    await client.get("/v1/builds", {
      "filter[app]": "123",
      "filter[processingState]": ["VALID", "PROCESSING"],
      "filter[version]": undefined,
      "exists[x]": false,
      limit: 5,
    });
    const url = fetch.mock.calls[0]?.[0] as URL;
    expect(url.origin + url.pathname).toBe(
      "https://api.appstoreconnect.apple.com/v1/builds",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "filter[app]": "123",
      "filter[processingState]": "VALID,PROCESSING",
      "exists[x]": "false",
      limit: "5",
    });
  });

  it("should throw AscApiError with the body, and tolerate a non-JSON error body", async () => {
    const body = { errors: [{ status: "403", code: "FORBIDDEN_ERROR" }] };
    const teamKey = key("TEAMKEY001", ISSUER);
    const forbidden = await (
      await clientFor(teamKey, stubFetch(Response.json(body, { status: 403 })))
    )
      .get("/v1/apps")
      .catch((error: unknown) => error);
    expect(forbidden).toBeInstanceOf(AscApiError);
    expect(forbidden).toMatchObject({ status: 403, data: body });

    const notAcceptable = await (
      await clientFor(
        teamKey,
        stubFetch(new Response("Not Acceptable", { status: 406 })),
      )
    )
      .get("/v1/apps")
      .catch((error: unknown) => error);
    expect(notAcceptable).toMatchObject({ status: 406, data: undefined });
  });

  it("should reject a successful response that is not JSON", async () => {
    const client = await clientFor(
      key("TEAMKEY001", ISSUER),
      stubFetch(new Response("<html>")),
    );
    await expect(client.get("/v1/apps")).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it("should reject a private key that is not a .p8, without echoing it", async () => {
    const error = await clientFor(
      { keyId: "TEAMKEY001", issuerId: ISSUER, privateKey: "not-a-key" },
      stubFetch(Response.json({})),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialsError);
    expect((error as Error).message).not.toContain("not-a-key");
  });

  it("should wrap a fetch rejection without a code in NetworkError", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("Network connection lost."));
    const client = await clientFor(key("TEAMKEY001", ISSUER), fetch);
    await expect(client.get("/v1/apps")).rejects.toBeInstanceOf(NetworkError);
  });

  it("should never print the token or the private key when a command fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = stubFetch(
      Response.json(
        { errors: [{ status: "401", code: "NOT_AUTHORIZED", detail: "x" }] },
        { status: 401 },
      ),
    );
    let stderr = "";
    const program = createProgram(() =>
      createAscClient(key("TEAMKEY001", ISSUER), { fetch }),
    );
    for (const command of [program, ...program.commands]) {
      command.exitOverride().configureOutput({
        writeErr: (text) => {
          stderr += text;
        },
      });
    }
    await program.parseAsync(["apps"], { from: "user" }).catch(() => {});
    const token = sentToken(fetch);
    expect(stderr).toMatch(/\[auth\]/);
    const output = [stderr, JSON.stringify(log.mock.calls)].join("\n");
    expect(output).not.toContain(token);
    expect(output).not.toContain("PRIVATE KEY");
    expect(output).not.toContain(pem.split("\n")[1]);
    log.mockRestore();
  });
});

describe("readCredentials", () => {
  let path: string;

  beforeAll(async () => {
    path = join(await mkdtemp(join(tmpdir(), "asc-")), "AuthKey.p8");
    await writeFile(path, pem);
  });

  it("should read the key from the options", async () => {
    expect(
      await readCredentials(
        { keyId: "TEAMKEY001", issuerId: ISSUER, privateKey: path },
        {},
      ),
    ).toEqual({ keyId: "TEAMKEY001", issuerId: ISSUER, privateKey: pem });
  });

  it("should fall back to the ASC_ variables, with options taking precedence", async () => {
    const env = {
      ASC_KEY_ID: "ENVKEY0001",
      ASC_ISSUER_ID: ISSUER,
      ASC_PRIVATE_KEY_PATH: path,
    };
    expect(await readCredentials({}, env)).toMatchObject({
      keyId: "ENVKEY0001",
      issuerId: ISSUER,
    });
    expect(await readCredentials({ keyId: "FLAGKEY001" }, env)).toMatchObject({
      keyId: "FLAGKEY001",
    });
  });

  it("should treat a key without an issuer ID as an individual key", async () => {
    expect(
      await readCredentials({ keyId: "SOLOKEY001", privateKey: path }, {}),
    ).toMatchObject({ issuerId: "" });
  });

  it.each([
    ["no key ID", { privateKey: "x.p8" }, "--key-id"],
    ["no private key", { keyId: "TEAMKEY001" }, "--private-key"],
    [
      "a file that does not exist",
      { keyId: "TEAMKEY001", privateKey: "/nonexistent/AuthKey.p8" },
      "could not be read",
    ],
  ])("should explain %s", async (_, options, message) => {
    const error = await readCredentials(options, {}).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CredentialsError);
    expect((error as Error).message).toContain(message);
  });

  it("should reject a malformed key ID or issuer ID", async () => {
    await expect(
      readCredentials({ keyId: "lowercase1", privateKey: path }, {}),
    ).rejects.toBeInstanceOf(CredentialsError);
    await expect(
      readCredentials(
        { keyId: "TEAMKEY001", issuerId: "team-1", privateKey: path },
        {},
      ),
    ).rejects.toBeInstanceOf(CredentialsError);
  });
});

describe("keySchema", () => {
  const valid = { issuerId: ISSUER, keyId: "2X9R4HXF34", privateKey: "pem" };

  it.each([
    ["an empty issuer ID", { ...valid, issuerId: "" }, true],
    ["a missing issuer ID", { keyId: "2X9R4HXF34", privateKey: "pem" }, true],
    ["a team issuer ID", valid, true],
    [
      "a key ID with surrounding spaces",
      { ...valid, keyId: " 2X9R4HXF34 " },
      true,
    ],
    [
      "an issuer ID that is not a GUID",
      { ...valid, issuerId: "team-1" },
      false,
    ],
    ["a lowercase key ID", { ...valid, keyId: "2x9r4hxf34" }, false],
    ["a 9-character key ID", { ...valid, keyId: "2X9R4HXF3" }, false],
  ])("should handle %s", (_, input, success) => {
    expect(keySchema.safeParse(input).success).toBe(success);
  });
});
