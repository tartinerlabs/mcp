import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { RSA_KEY_ALGORITHM } from "../src/asc/csr.ts";
import { type AscClientProvider, createProgram } from "../src/cli.ts";
import { AscApiError } from "../src/utils/errors.ts";

/** A client whose methods fail unless a test gives them an implementation. */
function mockClient(overrides: Partial<AscClient> = {}): AscClient {
  const fail = () => Promise.reject(new Error("unexpected call"));
  return {
    get: vi.fn(fail) as AscClient["get"],
    post: vi.fn(fail) as AscClient["post"],
    patch: vi.fn(fail) as AscClient["patch"],
    delete: vi.fn(fail) as AscClient["delete"],
    upload: vi.fn(fail) as AscClient["upload"],
    download: vi.fn(fail) as AscClient["download"],
    downloadSigned: vi.fn(fail) as AscClient["downloadSigned"],
    ...overrides,
  };
}

/** Runs the CLI, capturing stdout, stderr and the exit code. */
async function run(args: string[], client: AscClient) {
  let stderr = "";
  const provider: AscClientProvider = () => client;
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

/** Reads one DER TLV at `offset`: its tag, its contents and where the next one starts. */
function tlv(bytes: Uint8Array, offset: number) {
  const tag = bytes[offset] ?? 0;
  let size = bytes[offset + 1] ?? 0;
  let start = offset + 2;
  if (size & 0x80) {
    const count = size & 0x7f;
    size = 0;
    for (let i = 0; i < count; i++) size = size * 256 + (bytes[start + i] ?? 0);
    start += count;
  }
  return {
    tag,
    whole: bytes.slice(offset, start + size),
    contents: bytes.slice(start, start + size),
    next: start + size,
  };
}

function fromPem(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

const workdir = () => mkdtemp(join(tmpdir(), "asc-provisioning-"));
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const forbidden = new AscApiError(403, {
  errors: [{ code: "FORBIDDEN_ERROR", detail: "This request is forbidden." }],
});

const certificate = {
  type: "certificates",
  id: "CERT1",
  attributes: {
    name: "Apple Distribution: Example",
    displayName: "Example",
    certificateType: "DISTRIBUTION",
    platform: null,
    serialNumber: "ABC123",
    expirationDate: "2027-11-27T00:00:00.000+00:00",
    certificateContent: "AAEC",
  },
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("certificates", () => {
  it("should filter by type and leave out the certificate content", async () => {
    const client = mockClient({
      get: vi.fn(() =>
        Promise.resolve({ data: [certificate], links: { self: "x" } }),
      ) as AscClient["get"],
    });
    const result = await run(
      ["certificates", "--type", "DISTRIBUTION,IOS_DISTRIBUTION"],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith("/v1/certificates", {
      "filter[certificateType]": ["DISTRIBUTION", "IOS_DISTRIBUTION"],
      sort: "displayName",
      limit: 50,
      cursor: undefined,
    });
    const output = JSON.parse(result.stdout);
    expect(output.certificates).toEqual([
      {
        id: "CERT1",
        name: "Apple Distribution: Example",
        displayName: "Example",
        type: "DISTRIBUTION",
        platform: null,
        serialNumber: "ABC123",
        expirationDate: "2027-11-27T00:00:00.000+00:00",
      },
    ]);
    expect(result.stdout).not.toContain("AAEC");
  });

  it("should explain that a team key is needed when Apple refuses", async () => {
    const client = mockClient({
      get: vi.fn(() => Promise.reject(forbidden)) as AscClient["get"],
    });
    const result = await run(["certificates"], client);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[permission]");
    expect(result.stderr).toContain("team API key");
    expect(result.stderr).toContain("individual API keys cannot use them");
  });
});

describe("profiles", () => {
  it("should show the bundle ID, certificates and devices but never the contents", async () => {
    const client = mockClient({
      get: vi.fn(() =>
        Promise.resolve({
          data: [
            {
              type: "profiles",
              id: "PROF1",
              attributes: {
                name: "Example App Store",
                profileType: "IOS_APP_STORE",
                profileState: "ACTIVE",
                platform: "IOS",
                uuid: "uuid-1",
                expirationDate: "2027-01-01T00:00:00.000+00:00",
                profileContent: "SECRETCONTENT",
              },
              relationships: {
                bundleId: { data: { type: "bundleIds", id: "B1" } },
                certificates: { data: [{ type: "certificates", id: "CERT1" }] },
                devices: {
                  data: [{ type: "devices", id: "D1" }],
                  meta: { paging: { total: 70 } },
                },
              },
            },
          ],
          included: [
            {
              type: "bundleIds",
              id: "B1",
              attributes: { identifier: "com.example.app", name: "Example" },
            },
            certificate,
            {
              type: "devices",
              id: "D1",
              attributes: {
                name: "iPhone",
                udid: "00008",
                platform: "IOS",
                status: "ENABLED",
              },
            },
          ],
          links: { self: "x" },
        }),
      ) as AscClient["get"],
    });
    const result = await run(
      ["profiles", "--state", "INVALID", "--type", "IOS_APP_STORE"],
      client,
    );
    expect(result.exitCode).toBe(0);
    const [path, query] = vi.mocked(client.get).mock.calls[0] ?? [];
    expect(path).toBe("/v1/profiles");
    expect(query).toMatchObject({
      include: ["bundleId", "certificates", "devices"],
      "filter[profileState]": ["INVALID"],
      "filter[profileType]": ["IOS_APP_STORE"],
    });
    expect(query?.["fields[profiles]"]).not.toContain("profileContent");
    const [profile] = JSON.parse(result.stdout).profiles;
    expect(profile).toMatchObject({
      id: "PROF1",
      type: "IOS_APP_STORE",
      state: "ACTIVE",
      bundleId: { id: "B1", identifier: "com.example.app" },
      certificates: [{ id: "CERT1", serialNumber: "ABC123" }],
      deviceCount: 70,
      devices: [{ id: "D1", name: "iPhone", udid: "00008" }],
    });
    expect(result.stdout).not.toContain("SECRETCONTENT");
  });

  it("should refuse an unknown state", async () => {
    const result = await run(["profiles", "--state", "EXPIRED"], mockClient());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
  });
});

describe("bundle-ids", () => {
  it("should list capabilities with each bundle ID", async () => {
    const client = mockClient({
      get: vi.fn(() =>
        Promise.resolve({
          data: [
            {
              type: "bundleIds",
              id: "B1",
              attributes: {
                identifier: "com.example.app",
                name: "Example",
                platform: "IOS",
                seedId: "TEAM123",
              },
              relationships: {
                bundleIdCapabilities: {
                  data: [{ type: "bundleIdCapabilities", id: "C1" }],
                },
              },
            },
          ],
          included: [
            {
              type: "bundleIdCapabilities",
              id: "C1",
              attributes: { capabilityType: "PUSH_NOTIFICATIONS" },
            },
          ],
          links: { self: "x" },
        }),
      ) as AscClient["get"],
    });
    const result = await run(
      ["bundle-ids", "--identifier", "com.example.app"],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/bundleIds",
      expect.objectContaining({
        "filter[identifier]": "com.example.app",
        include: ["bundleIdCapabilities"],
      }),
    );
    expect(JSON.parse(result.stdout).bundleIds).toEqual([
      {
        id: "B1",
        identifier: "com.example.app",
        name: "Example",
        platform: "IOS",
        teamId: "TEAM123",
        capabilities: [{ type: "PUSH_NOTIFICATIONS" }],
      },
    ]);
  });
});

describe("devices", () => {
  it("should filter by platform and status", async () => {
    const client = mockClient({
      get: vi.fn(() =>
        Promise.resolve({
          data: [
            {
              type: "devices",
              id: "D1",
              attributes: {
                name: "iPhone",
                udid: "00008",
                platform: "IOS",
                deviceClass: "IPHONE",
                model: "iPhone 17",
                status: "ENABLED",
                addedDate: "2026-01-01T00:00:00.000+00:00",
              },
            },
          ],
          links: { self: "x" },
        }),
      ) as AscClient["get"],
    });
    const result = await run(
      ["devices", "--platform", "IOS", "--status", "ENABLED"],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith("/v1/devices", {
      "filter[platform]": ["IOS"],
      "filter[status]": ["ENABLED"],
      "filter[name]": undefined,
      sort: "name",
      limit: 50,
      cursor: undefined,
    });
    expect(JSON.parse(result.stdout).devices[0]).toMatchObject({
      id: "D1",
      udid: "00008",
      deviceClass: "IPHONE",
    });
  });
});

describe("certificates create", () => {
  it("should list existing certificates and write nothing without --yes", async () => {
    const dir = await workdir();
    const client = mockClient({
      get: vi.fn(() =>
        Promise.resolve({ data: [certificate], links: { self: "x" } }),
      ) as AscClient["get"],
    });
    const result = await run(
      [
        "certificates",
        "create",
        "--type",
        "DISTRIBUTION",
        "--key-out",
        join(dir, "dist.key"),
        "--cert-out",
        join(dir, "dist.cer"),
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Dry run");
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      type: "DISTRIBUTION",
      existing: [{ id: "CERT1" }],
    });
    expect(await exists(join(dir, "dist.key"))).toBe(false);
  });

  it("should refuse to overwrite an existing file", async () => {
    const dir = await workdir();
    await writeFile(join(dir, "dist.key"), "keep me");
    const client = mockClient();
    const result = await run(
      [
        "certificates",
        "create",
        "--type",
        "DISTRIBUTION",
        "--key-out",
        join(dir, "dist.key"),
        "--cert-out",
        join(dir, "dist.cer"),
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("already exists");
    expect(await readFile(join(dir, "dist.key"), "utf8")).toBe("keep me");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("should send a valid CSR and write the key and certificate only to files", async () => {
    const dir = await workdir();
    const client = mockClient({
      post: vi.fn(() =>
        Promise.resolve({ data: certificate }),
      ) as AscClient["post"],
    });
    const keyOut = join(dir, "dist.key");
    const certOut = join(dir, "dist.cer");
    const result = await run(
      [
        "certificates",
        "create",
        "--type",
        "DISTRIBUTION",
        "--key-out",
        keyOut,
        "--cert-out",
        certOut,
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    const [path, body] = vi.mocked(client.post).mock.calls[0] ?? [];
    expect(path).toBe("/v1/certificates");
    const { data } = body as {
      data: { attributes: { certificateType: string; csrContent: string } };
    };
    expect(data.attributes.certificateType).toBe("DISTRIBUTION");
    expect(data.attributes.csrContent).toMatch(
      /^-----BEGIN CERTIFICATE REQUEST-----\n/,
    );

    // The CSR's signature verifies against the public key it carries.
    const csr = fromPem(data.attributes.csrContent);
    const outer = tlv(csr, 0);
    const info = tlv(outer.contents, 0);
    const algorithm = tlv(outer.contents, info.next);
    const signature = tlv(outer.contents, algorithm.next);
    const version = tlv(info.contents, 0);
    const subject = tlv(info.contents, version.next);
    const spki = tlv(info.contents, subject.next);
    const publicKey = await crypto.subtle.importKey(
      "spki",
      spki.whole,
      RSA_KEY_ALGORITHM,
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        RSA_KEY_ALGORITHM.name,
        publicKey,
        signature.contents.slice(1),
        info.whole,
      ),
    ).toBe(true);

    const key = await readFile(keyOut, "utf8");
    expect(key).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect((await stat(keyOut)).mode & 0o777).toBe(0o600);
    expect([...(await readFile(certOut))]).toEqual([0, 1, 2]);
    const base64Key = key.split("\n")[1] ?? "";
    expect(result.stdout).not.toContain(base64Key);
    expect(result.stderr).not.toContain(base64Key);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: false,
      certificate: { id: "CERT1", serialNumber: "ABC123" },
    });
  });

  it("should remove the key file when Apple refuses the certificate", async () => {
    const dir = await workdir();
    const client = mockClient({
      post: vi.fn(() => Promise.reject(forbidden)) as AscClient["post"],
    });
    const result = await run(
      [
        "certificates",
        "create",
        "--type",
        "DISTRIBUTION",
        "--key-out",
        join(dir, "dist.key"),
        "--cert-out",
        join(dir, "dist.cer"),
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[permission]");
    expect(await exists(join(dir, "dist.key"))).toBe(false);
  });
});

describe("certificates renew", () => {
  it("should create a certificate of the same type", async () => {
    const dir = await workdir();
    const client = mockClient({
      get: vi.fn(() =>
        Promise.resolve({
          data: {
            ...certificate,
            attributes: {
              ...certificate.attributes,
              certificateType: "IOS_DISTRIBUTION",
            },
          },
        }),
      ) as AscClient["get"],
      post: vi.fn(() =>
        Promise.resolve({ data: { ...certificate, id: "CERT2" } }),
      ) as AscClient["post"],
    });
    const result = await run(
      [
        "certificates",
        "renew",
        "CERT1",
        "--key-out",
        join(dir, "new.key"),
        "--cert-out",
        join(dir, "new.cer"),
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.get).toHaveBeenCalledWith("/v1/certificates/CERT1");
    const body = vi.mocked(client.post).mock.calls[0]?.[1] as {
      data: { attributes: { certificateType: string } };
    };
    expect(body.data.attributes.certificateType).toBe("IOS_DISTRIBUTION");
    expect(JSON.parse(result.stdout)).toMatchObject({
      replaces: { id: "CERT1" },
      certificate: { id: "CERT2" },
    });
    expect(client.delete).not.toHaveBeenCalled();
  });
});

describe("certificates revoke", () => {
  function revokeClient() {
    return mockClient({
      get: vi.fn((path: string) =>
        Promise.resolve(
          path === "/v1/certificates/CERT1"
            ? { data: certificate }
            : {
                data: [
                  {
                    type: "profiles",
                    id: "PROF1",
                    attributes: {
                      name: "Uses it",
                      profileType: "IOS_APP_STORE",
                    },
                    relationships: {
                      certificates: {
                        data: [{ type: "certificates", id: "CERT1" }],
                      },
                    },
                  },
                  {
                    type: "profiles",
                    id: "PROF2",
                    attributes: { name: "Does not" },
                    relationships: {
                      certificates: {
                        data: [{ type: "certificates", id: "CERT9" }],
                      },
                    },
                  },
                ],
                links: { self: "x" },
              },
        ),
      ) as AscClient["get"],
      delete: vi.fn(() => Promise.resolve()),
    });
  }

  it("should list the profiles it would invalidate without --yes", async () => {
    const client = revokeClient();
    const result = await run(["certificates", "revoke", "CERT1"], client);
    expect(result.exitCode).toBe(0);
    expect(client.delete).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      certificate: { id: "CERT1" },
      affectedProfiles: [{ id: "PROF1", name: "Uses it" }],
    });
  });

  it("should revoke with --yes", async () => {
    const client = revokeClient();
    const result = await run(
      ["certificates", "revoke", "CERT1", "--yes"],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith("/v1/certificates/CERT1");
  });
});

describe("profiles create", () => {
  it("should need devices for a development profile", async () => {
    const dir = await workdir();
    const result = await run(
      [
        "profiles",
        "create",
        "--name",
        "Dev",
        "--type",
        "IOS_APP_DEVELOPMENT",
        "--bundle-id",
        "B1",
        "--certificate",
        "CERT1",
        "--out",
        join(dir, "dev.mobileprovision"),
      ],
      mockClient(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--device");
  });

  it("should create the profile and write its contents to --out", async () => {
    const dir = await workdir();
    const out = join(dir, "adhoc.mobileprovision");
    const client = mockClient({
      post: vi.fn(() =>
        Promise.resolve({
          data: {
            type: "profiles",
            id: "PROF3",
            attributes: {
              name: "Ad Hoc",
              profileType: "IOS_APP_ADHOC",
              profileState: "ACTIVE",
              profileContent: btoa("profile bytes"),
            },
          },
        }),
      ) as AscClient["post"],
    });
    const result = await run(
      [
        "profiles",
        "create",
        "--name",
        "Ad Hoc",
        "--type",
        "IOS_APP_ADHOC",
        "--bundle-id",
        "B1",
        "--certificate",
        "CERT1",
        "--device",
        "D1,D2",
        "--out",
        out,
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/v1/profiles", {
      data: {
        type: "profiles",
        attributes: { name: "Ad Hoc", profileType: "IOS_APP_ADHOC" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: "B1" } },
          certificates: { data: [{ type: "certificates", id: "CERT1" }] },
          devices: {
            data: [
              { type: "devices", id: "D1" },
              { type: "devices", id: "D2" },
            ],
          },
        },
      },
    });
    expect(await readFile(out, "utf8")).toBe("profile bytes");
    expect(result.stdout).not.toContain(btoa("profile bytes"));
    expect(JSON.parse(result.stdout).profile).toMatchObject({ id: "PROF3" });
  });
});

describe("profiles renew", () => {
  function renewClient(post: AscClient["post"]) {
    return mockClient({
      get: vi.fn((path: string) => {
        if (path === "/v1/profiles/PROF1") {
          return Promise.resolve({
            data: {
              type: "profiles",
              id: "PROF1",
              attributes: {
                name: "Dev",
                profileType: "IOS_APP_DEVELOPMENT",
                profileState: "INVALID",
              },
              relationships: {
                bundleId: { data: { type: "bundleIds", id: "B1" } },
              },
            },
          });
        }
        if (path.endsWith("/relationships/devices")) {
          return Promise.resolve({ data: [{ type: "devices", id: "D1" }] });
        }
        return Promise.resolve({
          data: [{ type: "certificates", id: "CERT1" }],
        });
      }) as AscClient["get"],
      delete: vi.fn(() => Promise.resolve()),
      post,
    });
  }

  it("should delete the old profile and create one like it", async () => {
    const dir = await workdir();
    const client = renewClient(
      vi.fn(() =>
        Promise.resolve({
          data: {
            type: "profiles",
            id: "PROF2",
            attributes: { name: "Dev", profileContent: btoa("new") },
          },
        }),
      ) as AscClient["post"],
    );
    const result = await run(
      [
        "profiles",
        "renew",
        "PROF1",
        "--certificate",
        "CERT2",
        "--out",
        join(dir, "dev.mobileprovision"),
        "--yes",
      ],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith("/v1/profiles/PROF1");
    expect(client.post).toHaveBeenCalledWith(
      "/v1/profiles",
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: { name: "Dev", profileType: "IOS_APP_DEVELOPMENT" },
          relationships: {
            bundleId: { data: { type: "bundleIds", id: "B1" } },
            certificates: { data: [{ type: "certificates", id: "CERT2" }] },
            devices: { data: [{ type: "devices", id: "D1" }] },
          },
        }),
      }),
    );
    expect(await readFile(join(dir, "dev.mobileprovision"), "utf8")).toBe(
      "new",
    );
  });

  it("should say the old profile is gone when creating the new one fails", async () => {
    const dir = await workdir();
    const client = renewClient(
      vi.fn(() =>
        Promise.reject(new AscApiError(409, { errors: [] })),
      ) as AscClient["post"],
    );
    const result = await run(
      ["profiles", "renew", "PROF1", "--out", join(dir, "x"), "--yes"],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "was deleted but the new one was not created",
    );
  });

  it("should change nothing without --yes", async () => {
    const dir = await workdir();
    const client = renewClient(vi.fn() as AscClient["post"]);
    const result = await run(
      ["profiles", "renew", "PROF1", "--out", join(dir, "x")],
      client,
    );
    expect(result.exitCode).toBe(0);
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      replaces: { id: "PROF1", state: "INVALID" },
      profile: { certificates: ["CERT1"], devices: ["D1"] },
    });
  });
});

describe("profiles delete", () => {
  it("should delete with --yes", async () => {
    const client = mockClient({
      get: vi.fn(() =>
        Promise.resolve({
          data: { type: "profiles", id: "PROF1", attributes: { name: "Old" } },
        }),
      ) as AscClient["get"],
      delete: vi.fn(() => Promise.resolve()),
    });
    const result = await run(["profiles", "delete", "PROF1", "--yes"], client);
    expect(result.exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith("/v1/profiles/PROF1");
  });
});
