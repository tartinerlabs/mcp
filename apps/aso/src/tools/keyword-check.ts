import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  type AppStoreClientProvider,
  MAX_RESULTS,
} from "../appstore/client.ts";
import { difficultyScore, rankOf, volumeScore } from "../appstore/scores.ts";
import { appIdSchema, countrySchema, termSchema } from "../schemas/common.ts";
import { toToolError } from "../utils/errors.ts";

// Each term × country is one App Store search; Apple allows about 20 a minute.
const MAX_SEARCHES = 20;
const TOP_APPS = 5;

const inputSchema = z
  .object({
    terms: z
      .array(termSchema)
      .min(1)
      .max(MAX_SEARCHES)
      .describe(
        "Search phrases to check, in the storefront's language (translate them yourself for non-English storefronts).",
      ),
    countries: z
      .array(countrySchema)
      .min(1)
      .max(10)
      .default(["us"])
      .describe('Two-letter App Store storefront codes. Defaults to ["us"].'),
    appId: appIdSchema
      .optional()
      .describe(
        "Your app's numeric App Store ID, to report its rank for each phrase. Omit to research phrases only.",
      ),
  })
  .refine(
    (input) => input.terms.length * input.countries.length <= MAX_SEARCHES,
    {
      message: `terms × countries must be at most ${MAX_SEARCHES} searches per call (Apple allows about 20 a minute).`,
      path: ["terms"],
    },
  );

export function registerKeywordCheckTool(
  server: McpServer,
  getClient: AppStoreClientProvider,
): void {
  server.registerTool(
    "keyword_check",
    {
      title: "Check App Store keywords",
      description:
        "For each phrase in each storefront, run one live App Store search and report: rank (your app's position in the top 200, " +
        "or null when absent; only with appId), volume (0–100: how many of the top 50 apps target the phrase in their name, an estimate " +
        "of how contested the phrase is, not a search count), difficulty (0–100 from the top 10 apps' rating counts) and the top 5 apps. " +
        `At most ${MAX_SEARCHES} searches (terms × countries) per call.`,
      inputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ terms, countries, appId }) => {
      try {
        const client = await getClient();
        const checks = [];
        // One search at a time, to stay under Apple's rate limit.
        for (const country of countries) {
          for (const term of terms) {
            const results = await client.search(term, country, MAX_RESULTS);
            checks.push({
              term,
              country,
              ...(appId !== undefined && { rank: rankOf(results, appId) }),
              volume: volumeScore(results, term),
              difficulty: difficultyScore(results),
              resultCount: results.length,
              top: results.slice(0, TOP_APPS).map((app) => ({
                id: app.id,
                name: app.name,
                developer: app.developer,
                ratingCount: app.ratingCount,
              })),
            });
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ appId, checks }, null, 2),
            },
          ],
        };
      } catch (error) {
        return toToolError("keyword_check", error);
      }
    },
  );
}
