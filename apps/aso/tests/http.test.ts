import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/http.ts";
import { mcpRequest } from "./helpers.ts";

/** An MCP request as it arrives over the network, Host header included. */
function withHost(host: string): Request {
  const request = mcpRequest("tools/list");
  const headers = new Headers(request.headers);
  headers.set("host", host);
  return new Request(request, { headers });
}

describe("handleMcp", () => {
  it("should answer without sign-in", async () => {
    const response = await handleMcp(withHost("localhost"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("keyword_check");
  });

  it("should refuse a request from a web page", async () => {
    const request = withHost("localhost");
    request.headers.set("origin", "https://attacker.example");
    const response = await handleMcp(request);
    expect(response.status).toBe(403);
  });
});
