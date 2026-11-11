import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { BingClientProvider } from "../bing/client.ts";
import { toToolError } from "../utils/errors.ts";

export function registerListSitesTool(
  server: McpServer,
  getClient: BingClientProvider,
): void {
  server.registerTool(
    "list_sites",
    {
      title: "List Bing Webmaster sites",
      description:
        "List the sites in the connected Bing Webmaster Tools account and whether each is verified. Use the URL as siteUrl in the other tools.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const sites = (await (await getClient()).getUserSites()).map(
          (site) => ({
            siteUrl: site.Url ?? null,
            isVerified: site.IsVerified ?? null,
          }),
        );
        const result = {
          sites,
          ...(sites.length === 0 && {
            note: "No sites found. Add and verify a site in Bing Webmaster Tools, or connect a different Bing account.",
          }),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return toToolError("list_sites", error);
      }
    },
  );
}
