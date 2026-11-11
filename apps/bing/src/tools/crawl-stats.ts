import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { type BingClientProvider, toIsoDate } from "../bing/client.ts";
import { siteUrlSchema } from "../schemas/common.ts";
import { toToolError } from "../utils/errors.ts";

export function registerCrawlStatsTool(
  server: McpServer,
  getClient: BingClientProvider,
): void {
  server.registerTool(
    "crawl_stats",
    {
      title: "Bing crawl statistics",
      description:
        "Bing's daily crawl statistics for a verified site: pages crawled, crawl errors by cause (4xx, 5xx, DNS, timeouts, robots.txt blocks), indexed pages and inbound links.",
      inputSchema: z.object({ siteUrl: siteUrlSchema }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ siteUrl }) => {
      try {
        const rows = await (await getClient()).getCrawlStats(siteUrl);
        const stats = rows.map((row) => ({
          date: toIsoDate(row.Date),
          crawledPages: row.CrawledPages ?? null,
          crawlErrors: row.CrawlErrors ?? null,
          inIndex: row.InIndex ?? null,
          inLinks: row.InLinks ?? null,
          code2xx: row.Code2xx ?? null,
          code301: row.Code301 ?? null,
          code302: row.Code302 ?? null,
          code4xx: row.Code4xx ?? null,
          code5xx: row.Code5xx ?? null,
          allOtherCodes: row.AllOtherCodes ?? null,
          blockedByRobotsTxt: row.BlockedByRobotsTxt ?? null,
          connectionTimeout: row.ConnectionTimeout ?? null,
          dnsFailures: row.DnsFailures ?? null,
          containsMalware: row.ContainsMalware ?? null,
        }));
        const result = {
          siteUrl,
          stats,
          ...(stats.length === 0 && {
            note: "Bing has no crawl statistics for this site yet.",
          }),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return toToolError("crawl_stats", error);
      }
    },
  );
}
