import { describe, expect, it, vi } from "vitest";
import type { StoreApp } from "../src/appstore/client.ts";
import { AppStoreApiError } from "../src/utils/errors.ts";
import { createTestClient, mockClient } from "./helpers.ts";

function app(id: number, name: string, ratingCount = 0): StoreApp {
  return {
    id,
    name,
    developer: "Dev",
    bundleId: `com.example.${id}`,
    genre: "Productivity",
    price: "Free",
    rating: 4.5,
    ratingCount,
    url: `https://apps.apple.com/us/app/id${id}`,
  };
}

const RESULTS = [
  app(1, "Habit Tracker", 100_000),
  app(2, "Daily Habit Tracker", 10_000),
  app(3, "Tracker for Habits"),
  app(4, "Todo List"),
];

describe("keyword_check", () => {
  it("should report rank, scores and top apps per term and country", async () => {
    const search = vi.fn().mockResolvedValue(RESULTS);
    const { callTool } = createTestClient(mockClient({ search }));
    const result = await callTool("keyword_check", {
      terms: ["habit tracker"],
      countries: ["US", "gb"],
      appId: 2,
    });
    expect(result.isError).toBe(false);
    const { checks } = JSON.parse(result.text);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      term: "habit tracker",
      country: "us",
      rank: 2,
      // Two exact matches and one all-words match out of 50: 2.5 / 50.
      volume: 5,
      resultCount: 4,
    });
    expect(checks[0].top.map((top: { id: number }) => top.id)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(search).toHaveBeenCalledWith("habit tracker", "us", 200);
    expect(search).toHaveBeenCalledWith("habit tracker", "gb", 200);
  });

  it("should report a null rank when the app is not in the results", async () => {
    const { callTool } = createTestClient(
      mockClient({ search: () => Promise.resolve(RESULTS) }),
    );
    const result = await callTool("keyword_check", {
      terms: ["habit tracker"],
      appId: 999,
    });
    expect(JSON.parse(result.text).checks[0].rank).toBeNull();
  });

  it("should omit rank without an appId", async () => {
    const { callTool } = createTestClient(
      mockClient({ search: () => Promise.resolve(RESULTS) }),
    );
    const result = await callTool("keyword_check", { terms: ["habit"] });
    expect(JSON.parse(result.text).checks[0]).not.toHaveProperty("rank");
  });

  it("should return a quota error when Apple rate-limits", async () => {
    const { callTool } = createTestClient(
      mockClient({ search: () => Promise.reject(new AppStoreApiError(403)) }),
    );
    const result = await callTool("keyword_check", { terms: ["habit"] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[quota\]/);
  });
});

describe("store_search", () => {
  it("should list results for the term in the storefront", async () => {
    const search = vi.fn().mockResolvedValue(RESULTS.slice(0, 2));
    const { callTool } = createTestClient(mockClient({ search }));
    const result = await callTool("store_search", {
      term: "habit",
      country: "de",
      limit: 2,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({
      term: "habit",
      country: "de",
      apps: [{ id: 1 }, { id: 2 }],
    });
    expect(search).toHaveBeenCalledWith("habit", "de", 2);
  });

  it("should default to the us storefront and 10 results", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const { callTool } = createTestClient(mockClient({ search }));
    await callTool("store_search", { term: "habit" });
    expect(search).toHaveBeenCalledWith("habit", "us", 10);
  });
});
