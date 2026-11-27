import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { AscApiError } from "../src/utils/errors.ts";
import { mockClient, runCli } from "./team-harness.ts";

const SECRET = "s3cret-value-that-is-long-enough";

const webhook = {
  type: "webhooks",
  id: "WH1",
  attributes: {
    name: "Builds",
    url: "https://hooks.example.com/asc",
    enabled: true,
    eventTypes: ["BUILD_UPLOAD_STATE_UPDATED"],
  },
  relationships: { app: { data: { type: "apps", id: "123" } } },
};

const workdir = () => mkdtemp(join(tmpdir(), "asc-webhooks-"));
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("webhooks", () => {
  it("should list an app's webhooks", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({ data: [webhook] })) as AscClient["get"],
    });
    const result = await runCli(["webhooks", "123"], asc);
    expect(result.exitCode).toBe(0);
    expect(vi.mocked(asc.get).mock.calls[0]?.[0]).toBe("/v1/apps/123/webhooks");
    expect(JSON.parse(result.stdout).webhooks[0]).toEqual({
      id: "WH1",
      name: "Builds",
      url: "https://hooks.example.com/asc",
      enabled: true,
      eventTypes: ["BUILD_UPLOAD_STATE_UPDATED"],
      appId: "123",
    });
  });
});

describe("webhooks create", () => {
  const args = [
    "webhooks",
    "create",
    "123",
    "--name",
    "Builds",
    "--url",
    "https://hooks.example.com/asc",
    "--event",
    "BUILD_UPLOAD_STATE_UPDATED",
  ];

  it("should take the secret from an environment variable and never print it", async () => {
    vi.stubEnv("ASC_WEBHOOK_SECRET", SECRET);
    const asc = mockClient({
      post: vi.fn(async () => ({ data: webhook })) as AscClient["post"],
    });
    const dry = await runCli(
      [...args, "--secret-env", "ASC_WEBHOOK_SECRET"],
      asc,
    );
    expect(JSON.parse(dry.stdout)).toMatchObject({
      dryRun: true,
      webhook: {
        secret: "environment variable ASC_WEBHOOK_SECRET",
        enabled: true,
      },
    });
    expect(asc.post).not.toHaveBeenCalled();

    const done = await runCli(
      [...args, "--secret-env", "ASC_WEBHOOK_SECRET", "--yes"],
      asc,
    );
    expect(done.exitCode).toBe(0);
    expect(asc.post).toHaveBeenCalledWith("/v1/webhooks", {
      data: {
        type: "webhooks",
        attributes: {
          name: "Builds",
          url: "https://hooks.example.com/asc",
          enabled: true,
          eventTypes: ["BUILD_UPLOAD_STATE_UPDATED"],
          secret: SECRET,
        },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
    expect(
      `${dry.stdout}${dry.stderr}${done.stdout}${done.stderr}`,
    ).not.toContain(SECRET);
  });

  it("should generate a secret into a new file only with --yes", async () => {
    const dir = await workdir();
    const out = join(dir, "secret.txt");
    const asc = mockClient({
      post: vi.fn(async () => ({ data: webhook })) as AscClient["post"],
    });
    await runCli([...args, "--secret-out", out], asc);
    expect(await exists(out)).toBe(false);

    const done = await runCli([...args, "--secret-out", out, "--yes"], asc);
    expect(done.exitCode).toBe(0);
    const secret = (await readFile(out, "utf8")).trim();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const body = vi.mocked(asc.post).mock.calls[0]?.[1] as {
      data: { attributes: { secret: string } };
    };
    expect(body.data.attributes.secret).toBe(secret);
    expect(done.stdout).not.toContain(secret);
  });

  it("should remove the generated secret's file when Apple refuses the webhook", async () => {
    const dir = await workdir();
    const out = join(dir, "secret.txt");
    const asc = mockClient({
      post: vi.fn(async () => {
        throw new AscApiError(409, {
          errors: [{ code: "ENTITY_ERROR", detail: "Conflict" }],
        });
      }) as AscClient["post"],
    });
    const result = await runCli([...args, "--secret-out", out, "--yes"], asc);
    expect(result.exitCode).toBe(1);
    expect(await exists(out)).toBe(false);
  });

  it("should refuse an existing secret file, an http URL, a missing secret and an unknown event", async () => {
    const dir = await workdir();
    const out = join(dir, "taken.txt");
    await writeFile(out, "keep");
    const taken = await runCli(
      [...args, "--secret-out", out, "--yes"],
      mockClient(),
    );
    expect(taken.stderr).toContain("already exists");
    expect(await readFile(out, "utf8")).toBe("keep");

    vi.stubEnv("ASC_WEBHOOK_SECRET", SECRET);
    const http = await runCli(
      [
        "webhooks",
        "create",
        "123",
        "--name",
        "B",
        "--url",
        "http://hooks.example.com",
        "--event",
        "BUILD_UPLOAD_STATE_UPDATED",
        "--secret-env",
        "ASC_WEBHOOK_SECRET",
      ],
      mockClient(),
    );
    expect(http.stderr).toContain("Must be an https URL.");

    const missing = await runCli(args, mockClient());
    expect(missing.stderr).toContain("--secret-env");

    const event = await runCli(
      [
        "webhooks",
        "create",
        "123",
        "--name",
        "B",
        "--url",
        "https://h.example.com",
        "--event",
        "NOPE",
        "--secret-env",
        "ASC_WEBHOOK_SECRET",
      ],
      mockClient(),
    );
    expect(event.stderr).toContain("[invalid_input]");
  });

  it("should refuse a short or unset secret variable without naming its value", async () => {
    vi.stubEnv("SHORT_SECRET", "abc123");
    const result = await runCli(
      [...args, "--secret-env", "SHORT_SECRET"],
      mockClient(),
    );
    expect(result.stderr).toContain(
      "SHORT_SECRET must hold the signing secret",
    );
    expect(result.stderr).not.toContain("abc123");
  });
});

describe("webhooks set", () => {
  it("should show the change without --yes and patch with --yes", async () => {
    vi.stubEnv("NEW_SECRET", SECRET);
    const asc = mockClient({
      get: vi.fn(async () => ({ data: webhook })) as AscClient["get"],
      patch: vi.fn(async () => ({ data: webhook })) as AscClient["patch"],
    });
    const dry = await runCli(
      ["webhooks", "set", "WH1", "--disable", "--secret-env", "NEW_SECRET"],
      asc,
    );
    expect(JSON.parse(dry.stdout)).toMatchObject({
      dryRun: true,
      webhook: { id: "WH1", enabled: true },
      change: { enabled: false, secret: "environment variable NEW_SECRET" },
    });
    expect(asc.patch).not.toHaveBeenCalled();

    const done = await runCli(
      [
        "webhooks",
        "set",
        "WH1",
        "--disable",
        "--event",
        "BUILD_UPLOAD_STATE_UPDATED,APP_STORE_VERSION_APP_VERSION_STATE_UPDATED",
        "--secret-env",
        "NEW_SECRET",
        "--yes",
      ],
      asc,
    );
    expect(asc.patch).toHaveBeenCalledWith("/v1/webhooks/WH1", {
      data: {
        type: "webhooks",
        id: "WH1",
        attributes: {
          enabled: false,
          eventTypes: [
            "BUILD_UPLOAD_STATE_UPDATED",
            "APP_STORE_VERSION_APP_VERSION_STATE_UPDATED",
          ],
          secret: SECRET,
        },
      },
    });
    expect(`${dry.stdout}${done.stdout}`).not.toContain(SECRET);
  });

  it("should refuse nothing to change and both --enable and --disable", async () => {
    const none = await runCli(["webhooks", "set", "WH1"], mockClient());
    expect(none.stderr).toContain("Give what to change");
    const both = await runCli(
      ["webhooks", "set", "WH1", "--enable", "--disable"],
      mockClient(),
    );
    expect(both.stderr).toContain("not both");
  });
});

describe("webhooks delete and ping", () => {
  it("should delete and ping only with --yes", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({ data: webhook })) as AscClient["get"],
      delete: vi.fn(async () => {}) as AscClient["delete"],
      post: vi.fn(async () => ({
        data: { type: "webhookPings", id: "P1" },
      })) as AscClient["post"],
    });
    await runCli(["webhooks", "delete", "WH1"], asc);
    await runCli(["webhooks", "ping", "WH1"], asc);
    expect(asc.delete).not.toHaveBeenCalled();
    expect(asc.post).not.toHaveBeenCalled();

    await runCli(["webhooks", "delete", "WH1", "--yes"], asc);
    expect(asc.delete).toHaveBeenCalledWith("/v1/webhooks/WH1");
    vi.mocked(console.log).mockClear();
    const ping = await runCli(["webhooks", "ping", "WH1", "--yes"], asc);
    expect(asc.post).toHaveBeenCalledWith("/v1/webhookPings", {
      data: {
        type: "webhookPings",
        relationships: { webhook: { data: { type: "webhooks", id: "WH1" } } },
      },
    });
    expect(JSON.parse(ping.stdout).pingId).toBe("P1");
  });
});

describe("webhooks deliveries", () => {
  it("should list deliveries with the event type and a shortened response", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({
        data: [
          {
            type: "webhookDeliveries",
            id: "D1",
            attributes: {
              deliveryState: "FAILED",
              createdDate: "2026-11-27T00:00:00Z",
              request: { url: "https://hooks.example.com/asc" },
              response: { httpStatusCode: 500, body: "x".repeat(600) },
            },
            relationships: {
              event: { data: { type: "webhookEvents", id: "E1" } },
            },
          },
        ],
        included: [
          {
            type: "webhookEvents",
            id: "E1",
            attributes: {
              eventType: "BUILD_UPLOAD_STATE_UPDATED",
              payload: "{}",
            },
          },
        ],
      })) as AscClient["get"],
    });
    const result = await runCli(
      [
        "webhooks",
        "deliveries",
        "WH1",
        "--state",
        "FAILED",
        "--since",
        "2026-11-01",
        "--limit",
        "10",
      ],
      asc,
    );
    expect(result.exitCode).toBe(0);
    expect(vi.mocked(asc.get).mock.calls[0]).toEqual([
      "/v1/webhooks/WH1/deliveries",
      expect.objectContaining({
        "filter[deliveryState]": "FAILED",
        "filter[createdDateGreaterThanOrEqualTo]": "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ]);
    const [delivery] = JSON.parse(result.stdout).deliveries;
    expect(delivery).toMatchObject({
      id: "D1",
      state: "FAILED",
      eventType: "BUILD_UPLOAD_STATE_UPDATED",
      httpStatusCode: 500,
    });
    expect(delivery.responseBody).toHaveLength(501);
    expect(delivery).not.toHaveProperty("payload");
  });

  it("should redeliver only with --yes", async () => {
    const asc = mockClient({
      post: vi.fn(async () => ({
        data: { type: "webhookDeliveries", id: "D2" },
      })) as AscClient["post"],
    });
    await runCli(["webhooks", "deliveries", "redeliver", "D1"], asc);
    expect(asc.post).not.toHaveBeenCalled();
    vi.mocked(console.log).mockClear();
    const done = await runCli(
      ["webhooks", "deliveries", "redeliver", "D1", "--yes"],
      asc,
    );
    expect(asc.post).toHaveBeenCalledWith("/v1/webhookDeliveries", {
      data: {
        type: "webhookDeliveries",
        relationships: {
          template: { data: { type: "webhookDeliveries", id: "D1" } },
        },
      },
    });
    expect(JSON.parse(done.stdout).newDeliveryId).toBe("D2");
  });
});
