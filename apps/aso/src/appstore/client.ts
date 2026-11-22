import { AppStoreApiError, isRetryable } from "../utils/errors.ts";

/** One app in App Store search results, trimmed to the fields the commands report. */
export interface StoreApp {
  id: number;
  name: string;
  developer: string;
}

/** The public listing fields `competitors diff` tracks. */
export interface StoreListing extends StoreApp {
  version: string;
  versionReleaseDate: string;
  releaseNotes: string;
  description: string;
  genre: string;
  price: string;
  rating: number | null;
  ratingCount: number;
  screenshotCount: number;
  url: string;
}

/** The operations the commands depend on; tests mock this seam. */
export interface AppStoreClient {
  /** Searches iPhone and universal apps in one storefront, in Apple's result order. */
  search(term: string, country: string, limit: number): Promise<StoreApp[]>;
  /** Looks up public listings by App Store ID in one storefront; unknown IDs are left out. */
  lookup(ids: number[], country: string): Promise<StoreListing[]>;
}

export interface ClientOptions {
  /** Waits between requests and before retries. */
  sleep(ms: number): Promise<void>;
  /** Milliseconds since the epoch. */
  now(): number;
  /** Reports a retry on stderr. */
  onRetry(seconds: number, reason: string): void;
}

// The public iTunes Search and Lookup APIs: no key, "approximately 20 calls
// per minute" per IP by Apple's documentation, so requests are spaced 3s apart.
const SEARCH_URL = "https://itunes.apple.com/search";
const LOOKUP_URL = "https://itunes.apple.com/lookup";
const MIN_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 15_000;
// Rate limits clear within a minute or two; two pauses cover one bad window.
const RETRY_DELAYS_S = [60, 120];
/** The most results Apple returns for one search. */
export const MAX_RESULTS = 200;
/** The most IDs one lookup accepts. */
export const MAX_LOOKUP_IDS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function toStoreApp(result: Record<string, unknown>): StoreApp {
  return {
    id: num(result.trackId),
    name: str(result.trackName),
    developer: str(result.artistName),
  };
}

/** Maps one iTunes Lookup result to the tracked listing fields. */
export function toStoreListing(result: Record<string, unknown>): StoreListing {
  const screenshots = [
    result.screenshotUrls,
    result.ipadScreenshotUrls,
  ].reduce<number>(
    (count, list) => count + (Array.isArray(list) ? list.length : 0),
    0,
  );
  return {
    ...toStoreApp(result),
    version: str(result.version),
    versionReleaseDate: str(result.currentVersionReleaseDate),
    releaseNotes: str(result.releaseNotes),
    description: str(result.description),
    genre: str(result.primaryGenreName),
    price: str(result.formattedPrice),
    rating:
      typeof result.averageUserRating === "number"
        ? Math.round(result.averageUserRating * 100) / 100
        : null,
    ratingCount: num(result.userRatingCount),
    screenshotCount: screenshots,
    url: str(result.trackViewUrl),
  };
}

/**
 * The live client. Requests from one process are spaced to stay under Apple's
 * per-IP limit, and a rate limit, 5xx or network failure is retried twice.
 */
export function createAppStoreClient(options: ClientOptions): AppStoreClient {
  let nextAt = 0;

  async function getResults(url: URL): Promise<Record<string, unknown>[]> {
    for (let attempt = 0; ; attempt++) {
      const wait = nextAt - options.now();
      if (wait > 0) await options.sleep(wait);
      nextAt = options.now() + MIN_INTERVAL_MS;
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) throw new AppStoreApiError(response.status);
        const data: unknown = await response.json();
        const results =
          isRecord(data) && Array.isArray(data.results) ? data.results : [];
        return results.filter(isRecord);
      } catch (error) {
        const delay = RETRY_DELAYS_S[attempt];
        if (delay === undefined || !isRetryable(error)) throw error;
        options.onRetry(
          delay,
          error instanceof Error ? error.message : String(error),
        );
        await options.sleep(delay * 1000);
      }
    }
  }

  return {
    async search(term, country, limit) {
      const url = new URL(SEARCH_URL);
      url.search = new URLSearchParams({
        term,
        country,
        media: "software",
        entity: "software",
        limit: String(limit),
      }).toString();
      return (await getResults(url)).map(toStoreApp);
    },
    async lookup(ids, country) {
      const url = new URL(LOOKUP_URL);
      url.search = new URLSearchParams({
        id: ids.join(","),
        country,
        entity: "software",
      }).toString();
      return (await getResults(url))
        .filter((result) => result.wrapperType === "software")
        .map(toStoreListing);
    },
  };
}
