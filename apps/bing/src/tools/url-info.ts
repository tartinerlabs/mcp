import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { type BingClientProvider, toIsoDate } from "../bing/client.ts";
import { pageUrlSchema, siteUrlSchema } from "../schemas/common.ts";
import { toToolError } from "../utils/errors.ts";

export function registerUrlInfoTool(
  server: McpServer,
  getClient: BingClientProvider,
): void {
  server.registerTool(
    "url_info",
    {
      title: "Bing index status for a URL",
      description:
        "Bing's index details for one URL of a verified site: discovery and last crawl dates, HTTP status seen, document size and inbound anchor count.",
      inputSchema: z.object({ siteUrl: siteUrlSchema, url: pageUrlSchema }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ siteUrl, url }) => {
      try {
        const info = await (await getClient()).getUrlInfo(siteUrl, url);
        const lastCrawledAt = toIsoDate(info?.LastCrawledDate);
        const result = {
          siteUrl,
          url: info?.Url ?? url,
          isPage: info?.IsPage ?? null,
          httpStatus: info?.HttpStatus ?? null,
          discoveredAt: toIsoDate(info?.DiscoveryDate),
          lastCrawledAt,
          documentSize: info?.DocumentSize ?? null,
          anchorCount: info?.AnchorCount ?? null,
          totalChildUrlCount: info?.TotalChildUrlCount ?? null,
          ...(!lastCrawledAt && {
            note: "Bing reports no crawl for this URL, so it is probably not indexed yet.",
          }),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return toToolError("url_info", error);
      }
    },
  );
}
