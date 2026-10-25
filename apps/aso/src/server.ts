import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import pkg from "../package.json" with { type: "json" };
import type { AppStoreClientProvider } from "./appstore/client.ts";
import { registerKeywordCheckTool } from "./tools/keyword-check.ts";
import { registerStoreSearchTool } from "./tools/store-search.ts";

const SERVER_NAME = "aso";
const SERVER_VERSION = pkg.version;

const INSTRUCTIONS = `Ad-hoc App Store keyword research from live, public App Store search results (iPhone and universal apps). No sign-in, and nothing is stored between calls.

Use store_search to find an app's numeric ID or see who ranks for a term, and keyword_check to score phrases per storefront: rank (with appId), volume and difficulty. Volume is an estimate of how many top apps target a phrase, not Apple's search popularity. Write phrases in each storefront's language. Apple allows about 20 searches a minute, so check related phrases in one call, and after a [quota] error wait a minute before retrying.`;

/** Server factory for the HTTP handler. */
export function createServer(getClient: AppStoreClientProvider): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Check whether the ASO MCP server is running.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [{ type: "text", text: "ASO MCP is running." }],
    }),
  );

  registerStoreSearchTool(server, getClient);
  registerKeywordCheckTool(server, getClient);

  return server;
}
