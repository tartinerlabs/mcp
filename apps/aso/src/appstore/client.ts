import { AppStoreApiError } from "../utils/errors.ts";

/** One app in App Store search results, trimmed to the fields the tools report. */
export interface StoreApp {
  id: number;
  name: string;
  developer: string;
  bundleId: string;
  genre: string;
  price: string;
  rating: number | null;
  ratingCount: number;
  url: string;
}

/** The operations the MCP tools depend on. */
export interface AppStoreClient {
  /** Searches one storefront and resolves the results in App Store order. */
  search(term: string, country: string, limit: number): Promise<StoreApp[]>;
}

/** Resolves the client lazily, inside each tool call, as the other servers do. */
export type AppStoreClientProvider = () =>
  | AppStoreClient
  | Promise<AppStoreClient>;

// The public iTunes Search API: no key, about 20 calls per minute per IP.
const SEARCH_URL = "https://itunes.apple.com/search";
const TIMEOUT_MS = 15_000;
/** The most results Apple returns for one search. */
export const MAX_RESULTS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Maps one iTunes Search API result to a StoreApp. */
export function toStoreApp(result: Record<string, unknown>): StoreApp {
  return {
    id: typeof result.trackId === "number" ? result.trackId : 0,
    name: str(result.trackName),
    developer: str(result.artistName),
    bundleId: str(result.bundleId),
    genre: str(result.primaryGenreName),
    price: str(result.formattedPrice),
    rating:
      typeof result.averageUserRating === "number"
        ? Math.round(result.averageUserRating * 100) / 100
        : null,
    ratingCount:
      typeof result.userRatingCount === "number" ? result.userRatingCount : 0,
    url: str(result.trackViewUrl),
  };
}

/** Searches iPhone and universal apps in one storefront. */
export async function searchApps(
  term: string,
  country: string,
  limit: number,
): Promise<StoreApp[]> {
  const url = new URL(SEARCH_URL);
  url.search = new URLSearchParams({
    term,
    country,
    entity: "software",
    limit: String(limit),
  }).toString();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new AppStoreApiError(response.status);
  const data: unknown = await response.json();
  const results =
    isRecord(data) && Array.isArray(data.results) ? data.results : [];
  return results.filter(isRecord).map(toStoreApp);
}

export function createAppStoreClient(): AppStoreClient {
  return { search: searchApps };
}
