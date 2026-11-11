import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  type BingClientProvider,
  type BingTrafficStats,
  toIsoDate,
} from "../bing/client.ts";
import { dateSchema, limitSchema, siteUrlSchema } from "../schemas/common.ts";
import { toToolError } from "../utils/errors.ts";

const inputSchema = z.object({
  siteUrl: siteUrlSchema,
  dimension: z
    .enum(["query", "page"])
    .default("query")
    .describe("Group by search query or by page (default query)."),
  startDate: dateSchema
    .optional()
    .describe("Only rows on or after this date (YYYY-MM-DD)."),
  endDate: dateSchema
    .optional()
    .describe("Only rows on or before this date (YYYY-MM-DD)."),
  limit: limitSchema,
});

interface Totals {
  key: string;
  impressions: number;
  clicks: number;
  positionWeight: number;
}

export function registerSearchPerformanceTool(
  server: McpServer,
  getClient: BingClientProvider,
): void {
  server.registerTool(
    "search_performance",
    {
      title: "Bing search performance",
      description:
        "Impressions, clicks, click-through rate and average position on Bing for a verified site, grouped by query or by page and sorted by impressions. " +
        "Bing reports its own recent window of data; startDate and endDate narrow it.",
      inputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ siteUrl, dimension, startDate, endDate, limit }) => {
      try {
        const client = await getClient();
        const rows: BingTrafficStats[] =
          dimension === "page"
            ? await client.getPageStats(siteUrl)
            : await client.getQueryStats(siteUrl);

        const totals = new Map<string, Totals>();
        for (const row of rows) {
          const day = toIsoDate(row.Date)?.slice(0, 10);
          if (
            day &&
            ((startDate && day < startDate) || (endDate && day > endDate))
          ) {
            continue;
          }
          // Page rows carry the page URL in the Query field.
          const key = row.Query ?? "";
          const impressions = row.Impressions ?? 0;
          const entry = totals.get(key) ?? {
            key,
            impressions: 0,
            clicks: 0,
            positionWeight: 0,
          };
          entry.impressions += impressions;
          entry.clicks += row.Clicks ?? 0;
          entry.positionWeight +=
            (row.AvgImpressionPosition ?? 0) * impressions;
          totals.set(key, entry);
        }

        const sorted = [...totals.values()].sort(
          (a, b) => b.impressions - a.impressions || b.clicks - a.clicks,
        );
        const result = {
          siteUrl,
          dimension,
          total: sorted.length,
          rows: sorted.slice(0, limit).map((entry) => ({
            [dimension]: entry.key,
            impressions: entry.impressions,
            clicks: entry.clicks,
            ctr:
              entry.impressions > 0
                ? Math.round((entry.clicks / entry.impressions) * 10_000) /
                  10_000
                : null,
            averagePosition:
              entry.impressions > 0
                ? Math.round((entry.positionWeight / entry.impressions) * 10) /
                  10
                : null,
          })),
          ...(sorted.length === 0 && {
            note: "Bing has no search performance data for this site in that range.",
          }),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return toToolError("search_performance", error);
      }
    },
  );
}
