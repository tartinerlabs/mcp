import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { type BingClientProvider, toIsoDate } from "../bing/client.ts";
import { siteUrlSchema } from "../schemas/common.ts";
import { toToolError } from "../utils/errors.ts";

export function registerSitemapsTool(
  server: McpServer,
  getClient: BingClientProvider,
): void {
  server.registerTool(
    "list_sitemaps",
    {
      title: "List Bing sitemaps",
      description:
        "List the sitemaps and feeds submitted to Bing for a verified site, with status, URL count, size and submission and last crawl dates.",
      inputSchema: z.object({ siteUrl: siteUrlSchema }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ siteUrl }) => {
      try {
        const feeds = await (await getClient()).getFeeds(siteUrl);
        const sitemaps = feeds.map((feed) => ({
          url: feed.Url ?? null,
          type: feed.Type ?? null,
          status: feed.Status ?? null,
          urlCount: feed.UrlCount ?? null,
          // Bing sends 0 when it has not recorded a size.
          fileSize: feed.FileSize || null,
          compressed: feed.Compressed ?? null,
          submittedAt: toIsoDate(feed.Submitted),
          lastCrawledAt: toIsoDate(feed.LastCrawled),
        }));
        const result = {
          siteUrl,
          sitemaps,
          ...(sitemaps.length === 0 && {
            note: "No sitemaps have been submitted to Bing for this site.",
          }),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return toToolError("list_sitemaps", error);
      }
    },
  );
}
