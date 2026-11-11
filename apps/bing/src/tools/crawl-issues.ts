import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { BingClientProvider } from "../bing/client.ts";
import { limitSchema, siteUrlSchema } from "../schemas/common.ts";
import { toToolError } from "../utils/errors.ts";

const inputSchema = z.object({ siteUrl: siteUrlSchema, limit: limitSchema });

export function registerCrawlIssuesTool(
  server: McpServer,
  getClient: BingClientProvider,
): void {
  server.registerTool(
    "crawl_issues",
    {
      title: "Bing crawl issues",
      description:
        "URLs of a verified site on which Bing found crawl problems, with the HTTP code, inbound link count and an issues bit-flag value (Bing's CrawlIssues enumeration), most linked first.",
      inputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ siteUrl, limit }) => {
      try {
        const rows = await (await getClient()).getCrawlIssues(siteUrl);
        const issues = rows
          .map((row) => ({
            url: row.Url ?? null,
            httpCode: row.HttpCode ?? null,
            inLinks: row.InLinks ?? null,
            issues: row.Issues ?? null,
          }))
          .sort((a, b) => (b.inLinks ?? 0) - (a.inLinks ?? 0));
        const result = {
          siteUrl,
          total: issues.length,
          issues: issues.slice(0, limit),
          ...(issues.length === 0 && {
            note: "Bing reports no crawl issues for this site.",
          }),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return toToolError("crawl_issues", error);
      }
    },
  );
}
