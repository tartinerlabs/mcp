import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { AppStoreClientProvider } from "../appstore/client.ts";
import { countrySchema, termSchema } from "../schemas/common.ts";
import { toToolError } from "../utils/errors.ts";

const inputSchema = z.object({
  term: termSchema.describe("An app name, developer or keyword to search for."),
  country: countrySchema
    .default("us")
    .describe("Two-letter App Store storefront code. Defaults to us."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("How many results to return, 1 to 50. Defaults to 10."),
});

export function registerStoreSearchTool(
  server: McpServer,
  getClient: AppStoreClientProvider,
): void {
  server.registerTool(
    "store_search",
    {
      title: "Search the App Store",
      description:
        "Search one App Store storefront and list the top results in order: id, name, developer, bundle ID, genre, price, " +
        "rating and rating count. Use it to find an app's numeric ID for keyword_check, or to see who ranks for a term.",
      inputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ term, country, limit }) => {
      try {
        const client = await getClient();
        const apps = await client.search(term, country, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ term, country, apps }, null, 2),
            },
          ],
        };
      } catch (error) {
        return toToolError("store_search", error);
      }
    },
  );
}
