import { isAPIError } from "better-auth/api";
import type { auth as appAuth } from "../lib/auth.ts";
import {
  BingApiError,
  CredentialsError,
  NetworkError,
  UnexpectedResponseError,
} from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";

/** The Better Auth instance; a type only, so importing this file never loads the Workers bindings. */
export type BingAuth = typeof appAuth;

/** The WCF JSON endpoint; the host is still being confirmed, so it lives only here. */
export const BING_API = "https://ssl.bing.com/webmaster/api.svc/json";
const TIMEOUT_MS = 30_000;

/** Bing's WCF JSON encodes dates as `/Date(1700000000000)/`, optionally with a `+0000` offset. */
export type BingDate = string;

export interface BingSite {
  Url?: string;
  IsVerified?: boolean;
  AuthenticationCode?: string;
  DnsVerificationCode?: string;
}

export interface BingUrlInfo {
  Url?: string;
  AnchorCount?: number;
  DiscoveryDate?: BingDate;
  DocumentSize?: number;
  HttpStatus?: number;
  IsPage?: boolean;
  LastCrawledDate?: BingDate;
  TotalChildUrlCount?: number;
}

export interface BingCrawlStats {
  Date?: BingDate;
  AllOtherCodes?: number;
  BlockedByRobotsTxt?: number;
  Code2xx?: number;
  Code301?: number;
  Code302?: number;
  Code4xx?: number;
  Code5xx?: number;
  ConnectionTimeout?: number;
  ContainsMalware?: number;
  CrawledPages?: number;
  CrawlErrors?: number;
  DnsFailures?: number;
  InIndex?: number;
  InLinks?: number;
}

export interface BingCrawlIssue {
  Url?: string;
  HttpCode?: number;
  InLinks?: number;
  /** A bit-flag set of CrawlIssues values. */
  Issues?: number;
}

export interface BingFeed {
  Url?: string;
  Type?: string;
  Status?: string;
  Compressed?: boolean;
  FileSize?: number;
  LastCrawled?: BingDate;
  Submitted?: BingDate;
  UrlCount?: number;
}

/** One row of GetQueryStats; GetPageStats rows have the same shape with the page URL in `Query`. */
export interface BingTrafficStats {
  Query?: string;
  Date?: BingDate;
  Impressions?: number;
  Clicks?: number;
  AvgImpressionPosition?: number;
  AvgClickPosition?: number;
}

/** The Bing Webmaster operations the MCP tools depend on. */
export interface BingClient {
  getUserSites(): Promise<BingSite[]>;
  getUrlInfo(siteUrl: string, url: string): Promise<BingUrlInfo>;
  getCrawlStats(siteUrl: string): Promise<BingCrawlStats[]>;
  getCrawlIssues(siteUrl: string): Promise<BingCrawlIssue[]>;
  getFeeds(siteUrl: string): Promise<BingFeed[]>;
  getQueryStats(siteUrl: string): Promise<BingTrafficStats[]>;
  getPageStats(siteUrl: string): Promise<BingTrafficStats[]>;
}

/**
 * Resolves the client lazily, inside each tool call, so the server starts
 * without credentials and auth failures surface as tool errors.
 */
export type BingClientProvider = () => BingClient | Promise<BingClient>;

/** `/Date(ms)/` (or `/Date(ms+0000)/`) as an ISO 8601 string; anything else is passed through, `undefined` becomes null. */
export function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (!match?.[1]) return value;
  const date = new Date(Number(match[1]));
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/** A client that sends the access token as a bearer header, never as an `apikey` query parameter. */
export function createBingClient(
  accessToken: string,
  fetchImpl?: typeof fetch,
): BingClient {
  // Not the bare global: Workers rejects `fetch` called with another `this`.
  const send = fetchImpl ?? ((input, init) => fetch(input, init));

  async function call<T>(
    method: string,
    query: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(`${BING_API}/${method}`);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }
    const response = await send(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((error: unknown) => {
      if (error instanceof TypeError) {
        throw new NetworkError("fetch failed", { cause: error });
      }
      throw error;
    });
    const data: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new BingApiError(response.status, data);
    // Success is `{"d": ...}`; a fault can also arrive with HTTP 200.
    if (typeof data !== "object" || data === null || !("d" in data)) {
      if (typeof data === "object" && data !== null && "ErrorCode" in data) {
        throw new BingApiError(response.status, data);
      }
      throw new UnexpectedResponseError(
        "Bing returned a response without the expected data.",
      );
    }
    return data.d as T;
  }

  const list = async <T>(method: string, siteUrl: string) =>
    (await call<T[] | null>(method, { siteUrl })) ?? [];

  return {
    getUserSites: async () =>
      (await call<BingSite[] | null>("GetUserSites")) ?? [],
    getUrlInfo: (siteUrl, url) =>
      call<BingUrlInfo>("GetUrlInfo", { siteUrl, url }),
    getCrawlStats: (siteUrl) => list<BingCrawlStats>("GetCrawlStats", siteUrl),
    getCrawlIssues: (siteUrl) =>
      list<BingCrawlIssue>("GetCrawlIssues", siteUrl),
    getFeeds: (siteUrl) => list<BingFeed>("GetFeeds", siteUrl),
    getQueryStats: (siteUrl) =>
      list<BingTrafficStats>("GetQueryStats", siteUrl),
    getPageStats: (siteUrl) => list<BingTrafficStats>("GetPageStats", siteUrl),
  };
}

/** A Bing Webmaster client acting as the given Better Auth user. */
export async function getUserBingClient(
  userId: string,
  auth: BingAuth,
  connectUrl: string,
): Promise<BingClient> {
  const { internalAdapter } = await auth.$context;
  const account = (await internalAdapter.findAccounts(userId))
    .filter((candidate) => candidate.providerId === "bing")
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];
  if (!account) {
    throw new CredentialsError(
      `No Bing account is connected. Connect Bing at ${connectUrl}, then retry.`,
    );
  }

  let accessToken: string | undefined;
  try {
    // Refreshes the token first when it has expired.
    ({ accessToken } = await auth.api.getAccessToken({
      body: { accountId: account.id, userId },
    }));
  } catch (error) {
    if (isAPIError(error)) {
      logger.warn(
        { statusCode: error.statusCode, code: error.body?.code },
        "Bing access token unavailable",
      );
      throw new CredentialsError(
        `Bing access could not be renewed: the connection may have expired or been revoked. Reconnect Bing at ${connectUrl}.`,
      );
    }
    throw error;
  }
  if (!accessToken) {
    throw new CredentialsError("No Bing access token is stored.");
  }
  return createBingClient(accessToken);
}
