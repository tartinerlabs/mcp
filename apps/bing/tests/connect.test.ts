import type { Auth } from "@repo/core/auth";
import { createLogger } from "@repo/core/logger";
import { describe, expect, it } from "vitest";
import { bingAccountSubject, createConnectPages } from "../src/connect.ts";

const ORIGIN = "https://bing.example.com";

const USERS: Record<string, { id: string; email: string }> = {
  alice: { id: "u-alice", email: "alice@example.com" },
  bob: { id: "u-bob", email: "bob@example.com" },
};

interface Row {
  id: string;
  userId: string;
  providerId: string;
  createdAt: Date;
}

function setup(initial: Row[] = []) {
  const rows = [...initial];
  const auth = {
    $context: Promise.resolve({
      baseURL: `${ORIGIN}/api/auth`,
      internalAdapter: {
        findAccounts: async (userId: string) =>
          rows.filter((row) => row.userId === userId),
        deleteAccount: async (id: string) => {
          rows.splice(
            rows.findIndex((row) => row.id === id),
            1,
          );
        },
      },
    }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const user = USERS[headers.get("cookie")?.replace("as=", "") ?? ""];
        return user ? { user } : null;
      },
    },
  } as unknown as Auth;
  const logger = createLogger("test", { level: "silent" });
  return { rows, pages: createConnectPages({ auth, logger }) };
}

const row = (id: string, userId: string, providerId: string, day: number) => ({
  id,
  userId,
  providerId,
  createdAt: new Date(2026, 0, day),
});

function request(
  method: string,
  { as, origin = ORIGIN }: { as?: string; origin?: string | null } = {},
  query = "",
) {
  const headers = new Headers();
  if (as) headers.set("cookie", `as=${as}`);
  if (origin) headers.set("origin", origin);
  return new Request(`${ORIGIN}/connect${query}`, { method, headers });
}

function csp(response: Response) {
  return response.headers.get("content-security-policy") ?? "";
}

describe("bingAccountSubject", () => {
  const encode = (value: unknown) => btoa(JSON.stringify(value));

  it("reads webmasteruid from a base64 JSON token", () => {
    expect(bingAccountSubject(encode({ webmasteruid: "06706abc" }))).toBe(
      "06706abc",
    );
  });

  it("reads a base64url token without padding", () => {
    const token = encode({ webmasteruid: "a?>b", pad: "x" })
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(bingAccountSubject(token)).toBe("a?>b");
  });

  it("falls back to a random UUID otherwise", () => {
    const uuid = /^[0-9a-f-]{36}$/;
    for (const token of [
      undefined,
      "",
      "not-base64-json!",
      encode({ other: 1 }),
      encode({ webmasteruid: "" }),
      encode({ webmasteruid: 5 }),
    ]) {
      expect(bingAccountSubject(token)).toMatch(uuid);
    }
    expect(bingAccountSubject("x")).not.toBe(bingAccountSubject("x"));
  });
});

describe("GET /connect", () => {
  it("offers Google sign-in without a session", async () => {
    const { pages } = setup();
    const response = await pages.connectPage(request("GET"));
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("data-signin");
    expect(csp(response)).toMatch(/script-src 'sha256-/);
  });

  it("shows Connect when no Bing account is linked", async () => {
    const { pages } = setup([row("g", "u-alice", "google", 1)]);
    const response = await pages.connectPage(request("GET", { as: "alice" }));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Not connected");
    expect(html).toContain("data-connect>");
    expect(html).not.toContain('<button type="button" data-disconnect');
    expect(html).toContain("alice@example.com");
  });

  it("shows Disconnect when linked and keeps only the newest Bing account", async () => {
    const { pages, rows } = setup([
      row("g", "u-alice", "google", 1),
      row("old", "u-alice", "bing", 2),
      row("new", "u-alice", "bing", 5),
      row("mid", "u-alice", "bing", 3),
      row("bob", "u-bob", "bing", 1),
    ]);
    const response = await pages.connectPage(request("GET", { as: "alice" }));
    const html = await response.text();
    expect(html).toContain("Connected");
    expect(html).toContain('<button type="button" data-disconnect');
    expect(rows.map((r) => r.id).sort()).toEqual(["bob", "g", "new"]);
  });

  it("reports a failed link without echoing the error", async () => {
    const { pages } = setup();
    const response = await pages.connectPage(
      request("GET", { as: "alice" }, "?error=%3Cscript%3E"),
    );
    const html = await response.text();
    expect(html).toContain("could not be connected");
    expect(html).not.toContain("%3Cscript");
  });
});

describe("DELETE /connect", () => {
  it("removes only the caller's Bing accounts", async () => {
    const { pages, rows } = setup([
      row("g", "u-alice", "google", 1),
      row("a1", "u-alice", "bing", 2),
      row("a2", "u-alice", "bing", 3),
      row("b1", "u-bob", "bing", 1),
    ]);
    const response = await pages.disconnect(request("DELETE", { as: "alice" }));
    expect(response.status).toBe(200);
    expect(rows.map((r) => r.id).sort()).toEqual(["b1", "g"]);
  });

  it("rejects a missing or foreign Origin", async () => {
    const { pages, rows } = setup([row("a1", "u-alice", "bing", 2)]);
    for (const origin of [null, "https://evil.example.com"]) {
      const response = await pages.disconnect(
        request("DELETE", { as: "alice", origin }),
      );
      expect(response.status).toBe(403);
    }
    expect(rows).toHaveLength(1);
  });

  it("rejects a request without a session", async () => {
    const { pages, rows } = setup([row("a1", "u-alice", "bing", 2)]);
    const response = await pages.disconnect(request("DELETE"));
    expect(response.status).toBe(401);
    expect(rows).toHaveLength(1);
  });
});
