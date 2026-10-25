import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { createTestClient } from "./helpers.ts";

describe("MCP server", () => {
  it("should describe itself through server/discover", async () => {
    const { rpc } = createTestClient();
    const message = await rpc("server/discover");
    expect(message.result.supportedVersions).toEqual(["2026-07-28"]);
    expect(message.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "aso",
      version: pkg.version,
    });
  });

  it("should register only read-only tools", async () => {
    const { rpc } = createTestClient();
    const message = await rpc("tools/list");
    const tools: { name: string; annotations: { readOnlyHint: boolean } }[] =
      message.result.tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "keyword_check",
      "ping",
      "store_search",
    ]);
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it("should answer ping", async () => {
    const { callTool } = createTestClient();
    expect(await callTool("ping")).toEqual({
      isError: false,
      text: "ASO MCP is running.",
    });
  });
});

describe("input validation", () => {
  it.each([
    ["no terms", { terms: [] }, "terms"],
    ["an empty term", { terms: [" "] }, "empty"],
    [
      "a three-letter country",
      { terms: ["a"], countries: ["usa"] },
      "two-letter",
    ],
    [
      "more than 20 searches",
      {
        terms: ["a", "b", "c", "d", "e", "f", "g"],
        countries: ["us", "gb", "de"],
      },
      "at most 20 searches",
    ],
    ["a non-numeric appId", { terms: ["a"], appId: "id123" }, "appId"],
  ])("should reject %s for keyword_check", async (_label, args, expected) => {
    const { callTool } = createTestClient();
    const result = await callTool("keyword_check", args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(expected);
  });
});
