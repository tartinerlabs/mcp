import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { createTestClient } from "./helpers.ts";

describe("MCP server", () => {
  it("should describe itself through server/discover", async () => {
    const { rpc } = createTestClient();
    const message = await rpc("server/discover");
    expect(message.result.supportedVersions).toEqual(["2026-07-28"]);
    expect(message.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "bing-webmaster",
      version: pkg.version,
    });
  });

  it("should register exactly the six read-only tools and ping", async () => {
    const { rpc } = createTestClient();
    const message = await rpc("tools/list");
    const tools: { name: string; annotations: { readOnlyHint: boolean } }[] =
      message.result.tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "crawl_issues",
      "crawl_stats",
      "list_sitemaps",
      "list_sites",
      "ping",
      "search_performance",
      "url_info",
    ]);
    for (const tool of tools) expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it("should answer ping", async () => {
    const { callTool } = createTestClient();
    expect(await callTool("ping")).toEqual({
      isError: false,
      text: "Bing Webmaster MCP is running.",
    });
  });
});

describe("input validation", () => {
  it.each([
    ["url_info", { siteUrl: "https://example.com/" }, "url"],
    [
      "url_info",
      { siteUrl: "example.com", url: "https://example.com/" },
      "http",
    ],
    ["crawl_stats", {}, "siteUrl"],
    ["crawl_issues", { siteUrl: "https://example.com/", limit: 501 }, "limit"],
    [
      "search_performance",
      { siteUrl: "https://example.com/", dimension: "country" },
      "dimension",
    ],
    [
      "search_performance",
      { siteUrl: "https://example.com/", startDate: "yesterday" },
      "YYYY-MM-DD",
    ],
  ])("should reject bad input for %s (%j)", async (tool, args, expected) => {
    const { callTool } = createTestClient();
    const result = await callTool(tool, args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(expected);
  });
});
