import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import pkg from "../package.json" with { type: "json" };
import type { BingClientProvider } from "./bing/client.ts";
import { registerCrawlIssuesTool } from "./tools/crawl-issues.ts";
import { registerCrawlStatsTool } from "./tools/crawl-stats.ts";
import { registerListSitesTool } from "./tools/list-sites.ts";
import { registerSearchPerformanceTool } from "./tools/search-performance.ts";
import { registerSitemapsTool } from "./tools/sitemaps.ts";
import { registerUrlInfoTool } from "./tools/url-info.ts";

const SERVER_NAME = "bing-webmaster";
const SERVER_VERSION = pkg.version;

/** Server factory for the HTTP handler. */
export function createServer(getClient: BingClientProvider): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Check whether the Bing Webmaster MCP server is running.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [{ type: "text", text: "Bing Webmaster MCP is running." }],
    }),
  );

  registerListSitesTool(server, getClient);
  registerUrlInfoTool(server, getClient);
  registerCrawlStatsTool(server, getClient);
  registerCrawlIssuesTool(server, getClient);
  registerSitemapsTool(server, getClient);
  registerSearchPerformanceTool(server, getClient);

  return server;
}
