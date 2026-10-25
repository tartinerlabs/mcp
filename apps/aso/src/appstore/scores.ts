import type { StoreApp } from "./client.ts";

// Volume looks at the top 50 results and difficulty at the top 10, as most
// ASO tools do: users rarely scroll further.
const VOLUME_DEPTH = 50;
const DIFFICULTY_DEPTH = 10;
// log10 of the rating count that scores 100 difficulty (1,000,000 ratings).
const MAX_RATINGS_LOG = 6;

function normalise(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/** 1 when an app's name contains the phrase, 0.5 when it contains every word, otherwise 0. */
export function nameMatch(name: string, term: string): number {
  const normalisedName = normalise(name);
  const normalisedTerm = normalise(term);
  if (normalisedName.includes(normalisedTerm)) return 1;
  const words = normalisedTerm.split(" ");
  return words.length > 1 &&
    words.every((word) => normalisedName.includes(word))
    ? 0.5
    : 0;
}

/**
 * 0–100: how many of the top 50 apps target the phrase in their name. An
 * estimate of how much the phrase is worth competing for, not a search count.
 */
export function volumeScore(results: StoreApp[], term: string): number {
  const matches = results
    .slice(0, VOLUME_DEPTH)
    .reduce((sum, app) => sum + nameMatch(app.name, term), 0);
  return Math.round((matches / VOLUME_DEPTH) * 100);
}

/** 0–100 from the top 10 apps' rating counts on a log scale; missing results count as 0. */
export function difficultyScore(results: StoreApp[]): number {
  const logs = results
    .slice(0, DIFFICULTY_DEPTH)
    .reduce((sum, app) => sum + Math.log10(app.ratingCount + 1), 0);
  const mean = logs / DIFFICULTY_DEPTH;
  return Math.min(100, Math.round((mean / MAX_RATINGS_LOG) * 100));
}

/** 1-based position of the app in the results, or null when it is not in them. */
export function rankOf(results: StoreApp[], appId: number): number | null {
  const index = results.findIndex((app) => app.id === appId);
  return index === -1 ? null : index + 1;
}
