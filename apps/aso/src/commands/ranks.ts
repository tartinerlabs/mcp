import { appendFile, readFile } from "node:fs/promises";
import * as z from "zod";
import { type AppStoreClient, MAX_RESULTS } from "../appstore/client.ts";
import {
  appIdSchema,
  countrySchema,
  filePathSchema,
  termSchema,
} from "../schemas/common.ts";
import { StateFileError } from "../utils/errors.ts";

// Each term is one search spaced 3s apart, so 50 terms take about 2.5 minutes.
const MAX_TERMS = 50;
const TOP_APPS = 3;

export const ranksSchema = z.object({
  terms: z.array(termSchema).min(1).max(MAX_TERMS),
  appId: appIdSchema,
  country: countrySchema,
  history: filePathSchema.optional(),
});

export type RanksInput = z.infer<typeof ranksSchema>;

/** One line of the history file. */
interface HistoryEntry {
  checkedAt: string;
  country: string;
  appId: number;
  term: string;
  rank: number | null;
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.term === "string" &&
    typeof entry.country === "string" &&
    typeof entry.appId === "number" &&
    (typeof entry.rank === "number" || entry.rank === null)
  );
}

/** The latest rank per term for this app and storefront, from a JSON Lines history file. */
async function previousRanks(
  path: string,
  appId: number,
  country: string,
): Promise<Map<string, number | null>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return new Map();
    throw error;
  }
  const latest = new Map<string, number | null>();
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new StateFileError(
        `${path} line ${index + 1} is not JSON. Point --history at a file this command wrote.`,
      );
    }
    if (isEntry(entry) && entry.appId === appId && entry.country === country) {
      latest.set(entry.term.toLocaleLowerCase(), entry.rank);
    }
  }
  return latest;
}

/**
 * Searches each term in one storefront and reports the app's position in
 * Apple's results (null beyond the top 200), with the change since the last
 * run when a history file is given. Positions come from the public iTunes
 * Search API, which can differ from what a signed-in device shows.
 */
export async function checkRanks(
  client: AppStoreClient,
  input: RanksInput,
  now: () => number,
) {
  const terms = [...new Set(input.terms)];
  const previous = input.history
    ? await previousRanks(input.history, input.appId, input.country)
    : undefined;
  const checkedAt = new Date(now()).toISOString();
  const results = [];
  for (const term of terms) {
    const apps = await client.search(term, input.country, MAX_RESULTS);
    const index = apps.findIndex((app) => app.id === input.appId);
    const rank = index === -1 ? null : index + 1;
    const before = previous?.get(term.toLocaleLowerCase());
    results.push({
      term,
      rank,
      ...(previous && {
        previousRank: before ?? null,
        change:
          rank !== null && typeof before === "number" ? before - rank : null,
      }),
      resultCount: apps.length,
      top: apps
        .slice(0, TOP_APPS)
        .map(({ id, name, developer }) => ({ id, name, developer })),
    });
  }
  if (input.history) {
    const lines = results.map((result) =>
      JSON.stringify({
        checkedAt,
        country: input.country,
        appId: input.appId,
        term: result.term,
        rank: result.rank,
      } satisfies HistoryEntry),
    );
    await appendFile(input.history, `${lines.join("\n")}\n`);
  }
  return {
    appId: input.appId,
    country: input.country,
    checkedAt,
    depth: MAX_RESULTS,
    results,
  };
}
