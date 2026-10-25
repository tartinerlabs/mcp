import { describe, expect, it, vi } from "vitest";
import { handleMcp } from "../src/http.ts";
import { mcpRequest } from "./helpers.ts";

const workflow = { create: vi.fn(), get: vi.fn() };

/** An MCP request as it arrives over the network, Host header included. */
function withHost(host: string): Request {
  const request = mcpRequest("tools/list");
  const headers = new Headers(request.headers);
  headers.set("host", host);
  return new Request(request, { headers });
}

describe("handleMcp", () => {
  it("should answer without sign-in", async () => {
    const response = await handleMcp(withHost("localhost"), workflow);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("submit_urls");
  });

  it("should refuse a request from a web page", async () => {
    const request = withHost("localhost");
    request.headers.set("origin", "https://attacker.example");
    const response = await handleMcp(request, workflow);
    expect(response.status).toBe(403);
  });

  it("should serve 2025-era clients", async () => {
    const response = await handleMcp(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          host: "localhost",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "legacy-client", version: "1.0.0" },
          },
        }),
      }),
      workflow,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"name":"index-now"');
  });
});
