import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { mockClient, runCli } from "./team-harness.ts";

const tester = (id: string) => ({
  type: "sandboxTesters",
  id,
  attributes: {
    firstName: "Sandy",
    lastName: "Box",
    acAccountName: `${id.toLowerCase()}@example.com`,
    territory: "USA",
    applePayCompatible: true,
    interruptPurchases: false,
    subscriptionRenewalRate: "MONTHLY_RENEWAL_EVERY_ONE_HOUR",
  },
});

/** Two pages of testers: T1 on the first, T2 on the second. */
function pagedClient(overrides: Partial<AscClient> = {}) {
  return mockClient({
    get: vi.fn(async (_path: string, query?: Record<string, unknown>) =>
      query?.cursor === "NEXT"
        ? { data: [tester("T2")] }
        : {
            data: [tester("T1")],
            links: {
              next: "https://api.appstoreconnect.apple.com/v2/sandboxTesters?cursor=NEXT",
            },
          },
    ) as AscClient["get"],
    ...overrides,
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sandbox testers", () => {
  it("should list testers without their emails", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({ data: [tester("T1")] })) as AscClient["get"],
    });
    const result = await runCli(["sandbox", "testers"], asc);
    expect(result.exitCode).toBe(0);
    expect(vi.mocked(asc.get).mock.calls[0]?.[0]).toBe("/v2/sandboxTesters");
    expect(
      vi.mocked(asc.get).mock.calls[0]?.[1]?.["fields[sandboxTesters]"],
    ).not.toContain("acAccountName");
    expect(JSON.parse(result.stdout).testers[0]).toMatchObject({
      id: "T1",
      territory: "USA",
    });
    expect(result.stdout).not.toContain("@example.com");
  });

  it("should include emails with --emails", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({ data: [tester("T1")] })) as AscClient["get"],
    });
    const result = await runCli(["sandbox", "testers", "--emails"], asc);
    expect(JSON.parse(result.stdout).testers[0].email).toBe("t1@example.com");
  });
});

describe("sandbox testers set", () => {
  it("should find the tester across pages and show the change without --yes", async () => {
    const asc = pagedClient();
    const result = await runCli(
      [
        "sandbox",
        "testers",
        "set",
        "T2",
        "--territory",
        "gbr",
        "--renewal-rate",
        "MONTHLY_RENEWAL_EVERY_FIVE_MINUTES",
      ],
      asc,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      tester: { id: "T2", territory: "USA" },
      change: {
        territory: "GBR",
        subscriptionRenewalRate: "MONTHLY_RENEWAL_EVERY_FIVE_MINUTES",
      },
    });
    expect(asc.get).toHaveBeenCalledTimes(2);
    expect(asc.patch).not.toHaveBeenCalled();
  });

  it("should patch the tester with --yes", async () => {
    const asc = pagedClient({
      patch: vi.fn(async () => ({ data: tester("T1") })) as AscClient["patch"],
    });
    const result = await runCli(
      ["sandbox", "testers", "set", "T1", "--interrupt-purchases", "--yes"],
      asc,
    );
    expect(result.exitCode).toBe(0);
    expect(asc.patch).toHaveBeenCalledWith("/v2/sandboxTesters/T1", {
      data: {
        type: "sandboxTesters",
        id: "T1",
        attributes: { interruptPurchases: true },
      },
    });
  });

  it("should refuse an unknown tester and nothing to change", async () => {
    const unknown = await runCli(
      ["sandbox", "testers", "set", "T9", "--territory", "USA"],
      pagedClient(),
    );
    expect(unknown.stderr).toContain(
      "[not_found] No sandbox tester with id T9",
    );
    const none = await runCli(
      ["sandbox", "testers", "set", "T1"],
      pagedClient(),
    );
    expect(none.stderr).toContain("Give what to change");
  });
});

describe("sandbox testers clear-history", () => {
  it("should say it cannot be undone without --yes and clear with --yes", async () => {
    const asc = pagedClient({
      post: vi.fn(async () => ({
        data: { type: "sandboxTestersClearPurchaseHistoryRequest", id: "REQ1" },
      })) as AscClient["post"],
    });
    const dry = await runCli(
      ["sandbox", "testers", "clear-history", "T1", "T2"],
      asc,
    );
    expect(JSON.parse(dry.stdout)).toMatchObject({
      dryRun: true,
      testers: [{ id: "T1" }, { id: "T2" }],
      note: "Clearing purchase history cannot be undone.",
    });
    expect(asc.post).not.toHaveBeenCalled();

    vi.mocked(console.log).mockClear();
    const done = await runCli(
      ["sandbox", "testers", "clear-history", "T1", "T2", "--yes"],
      asc,
    );
    expect(asc.post).toHaveBeenCalledWith(
      "/v2/sandboxTestersClearPurchaseHistoryRequest",
      {
        data: {
          type: "sandboxTestersClearPurchaseHistoryRequest",
          relationships: {
            sandboxTesters: {
              data: [
                { type: "sandboxTesters", id: "T1" },
                { type: "sandboxTesters", id: "T2" },
              ],
            },
          },
        },
      },
    );
    expect(JSON.parse(done.stdout).requestId).toBe("REQ1");
  });
});
