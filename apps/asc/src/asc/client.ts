import type { AscKey } from "../schemas/common.ts";
import {
  AscApiError,
  CredentialsError,
  InvalidInputError,
  NetworkError,
  UnexpectedResponseError,
} from "../utils/errors.ts";
import { importP256PrivateKey, signEs256Jwt } from "./signing.ts";

/** One JSON:API resource; `attributes` is shaped by the endpoint. */
export interface AscResource<Attributes = Record<string, unknown>> {
  type: string;
  id: string;
  attributes?: Attributes;
  relationships?: Record<
    string,
    { data?: { type: string; id: string } | null } | undefined
  >;
}

/** A paged App Store Connect collection response. */
export interface AscDocument<Attributes> {
  data: AscResource<Attributes>[];
  included?: AscResource[];
  links?: { self?: string; next?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

/** Query values; arrays are comma-joined and `undefined` is left out. */
export type AscQuery = Record<
  string,
  string | number | boolean | readonly string[] | undefined
>;

/** One part of a file upload, as an asset reservation's `uploadOperations` lists it. */
export interface UploadOperation {
  method?: string;
  url?: string;
  length?: number;
  offset?: number;
  requestHeaders?: { name?: string; value?: string }[];
}

/** Per-request options for `get`. */
export interface GetOptions {
  /**
   * Media type to ask for, for endpoints that answer with Apple's own JSON
   * types such as `application/vnd.apple.xcode-metrics+json`; JSON:API
   * errors still arrive as `application/json`.
   */
  accept?: string;
}

/** The App Store Connect operations the commands depend on. */
export interface AscClient {
  get<T>(path: string, query?: AscQuery, options?: GetOptions): Promise<T>;
  /**
   * Sends a JSON:API body; resolves to the response document, or undefined
   * for a 204, which relationship changes return.
   */
  post<T>(path: string, body: unknown): Promise<T>;
  /** Updates a resource with a JSON:API body; resolves to the updated document. */
  patch<T>(path: string, body: unknown): Promise<T>;
  /**
   * Resolves when Apple answers 2xx (usually 204, with no body). Removing
   * from a relationship sends the resources to remove as the body.
   */
  delete(path: string, body?: unknown): Promise<void>;
  /**
   * Sends one part of a file to the URL Apple's reservation gave, with its
   * headers and no token: those URLs are pre-signed.
   */
  upload(
    operation: UploadOperation,
    part: Uint8Array<ArrayBuffer>,
  ): Promise<void>;
  /** Reads a binary API response, such as a gzipped sales or finance report. */
  download(path: string, query?: AscQuery): Promise<Uint8Array>;
  /**
   * Reads a file from a URL Apple's response gave, such as an analytics
   * report segment, with no token: those URLs are pre-signed.
   */
  downloadSigned(url: string): Promise<Uint8Array>;
}

export interface AscClientOptions {
  fetch?: typeof fetch;
  /** @default Date.now */
  now?: () => number;
}

const ASC_API = "https://api.appstoreconnect.apple.com";
const AUDIENCE = "appstoreconnect-v1";
// Apple accepts up to 20 minutes; a fresh short-lived token is signed per request.
const TOKEN_LIFETIME_S = 120;
const TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
/** Apple's Notary API takes the same token, on the App Store Connect host. */
export const NOTARY_API = "https://appstoreconnect.apple.com/notary/v2";

/**
 * Resolves a path, or an absolute URL from Apple's response, and refuses any
 * URL outside the App Store Connect API and the Notary API, so the token is
 * never sent to another host.
 */
function apiUrl(path: string): URL {
  const url = new URL(path, ASC_API);
  if (
    url.origin === ASC_API ||
    (url.origin === new URL(NOTARY_API).origin &&
      url.pathname.startsWith("/notary/"))
  ) {
    return url;
  }
  throw new InvalidInputError(
    "Only App Store Connect API paths are accepted; the API key is never sent to another host.",
  );
}

/** What `request` returns for a 204, which has no body by design. */
const NO_CONTENT = Symbol("no content");

/** A team key names its issuer; an individual key uses `sub: "user"` instead. */
export function tokenClaims(
  key: Pick<AscKey, "issuerId">,
  nowMs: number,
): Record<string, unknown> {
  const iat = Math.floor(nowMs / 1000);
  const subject = key.issuerId ? { iss: key.issuerId } : { sub: "user" };
  return { ...subject, iat, exp: iat + TOKEN_LIFETIME_S, aud: AUDIENCE };
}

/** Signs a fresh ES256 token for every request with the given key. */
export async function createAscClient(
  key: AscKey,
  { fetch: send = fetch, now = Date.now }: AscClientOptions = {},
): Promise<AscClient> {
  let signingKey: CryptoKey;
  try {
    signingKey = await importP256PrivateKey(key.privateKey);
  } catch {
    throw new CredentialsError(
      "The private key file is not a valid .p8 key: expected the unencrypted file downloaded from App Store Connect.",
    );
  }

  /** Signs a fresh token for one request. */
  function authorization(): Promise<string> {
    return signEs256Jwt({
      header: { kid: key.keyId, typ: "JWT" },
      payload: tokenClaims(key, now()),
      key: signingKey,
    }).then((token) => `Bearer ${token}`);
  }

  /** Sends a request, turning a failed fetch into a NetworkError. */
  function sendRequest(url: URL, init: RequestInit): Promise<Response> {
    return send(url, init).catch((error: unknown) => {
      if (error instanceof TypeError) {
        throw new NetworkError("fetch failed", { cause: error });
      }
      throw error;
    });
  }

  /** Signs a fresh token, sends the request and returns the parsed JSON body (undefined when empty, NO_CONTENT for a 204). */
  async function request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: URL,
    body?: unknown,
    accept = "application/json",
  ): Promise<unknown> {
    const token = await signEs256Jwt({
      header: { kid: key.keyId, typ: "JWT" },
      payload: tokenClaims(key, now()),
      key: signingKey,
    });
    const response = await send(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((error: unknown) => {
      if (error instanceof TypeError) {
        throw new NetworkError("fetch failed", { cause: error });
      }
      throw error;
    });
    // Some errors (e.g. 406) are plain text, not JSON:API, and a 204 has no body.
    const data: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new AscApiError(response.status, data);
    return response.status === 204 ? NO_CONTENT : data;
  }

  /** A JSON body is required, except a POST may answer 204. */
  function json<T>(data: unknown, allowNoContent = false): T {
    if (data === NO_CONTENT && allowNoContent) return undefined as T;
    if (data === undefined || data === NO_CONTENT) {
      throw new UnexpectedResponseError(
        "App Store Connect returned a response that is not JSON.",
      );
    }
    return data as T;
  }

  return {
    async get<T>(
      path: string,
      query: AscQuery = {},
      { accept }: GetOptions = {},
    ): Promise<T> {
      const url = apiUrl(path);
      for (const [name, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(
          name,
          Array.isArray(value) ? value.join(",") : String(value),
        );
      }
      return json<T>(
        await request(
          "GET",
          url,
          undefined,
          accept && `${accept}, application/json`,
        ),
      );
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      return json<T>(await request("POST", apiUrl(path), body), true);
    },
    async patch<T>(path: string, body: unknown): Promise<T> {
      return json<T>(await request("PATCH", apiUrl(path), body));
    },
    async delete(path: string, body?: unknown): Promise<void> {
      await request("DELETE", apiUrl(path), body);
    },
    async upload(
      operation: UploadOperation,
      part: Uint8Array<ArrayBuffer>,
    ): Promise<void> {
      let url: URL;
      try {
        url = new URL(operation.url ?? "");
      } catch {
        url = new URL("invalid:");
      }
      if (url.protocol !== "https:") {
        throw new UnexpectedResponseError(
          "App Store Connect returned an upload operation without an HTTPS URL.",
        );
      }
      const headers: Record<string, string> = {};
      for (const { name, value } of operation.requestHeaders ?? []) {
        if (name && value !== undefined) headers[name] = value;
      }
      const response = await send(url, {
        method: operation.method ?? "PUT",
        headers,
        body: part,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      }).catch((error: unknown) => {
        if (error instanceof TypeError) {
          throw new NetworkError("fetch failed", { cause: error });
        }
        throw error;
      });
      await response.body?.cancel();
      // The URL is pre-signed and time-limited, so a refusal is not about the API key.
      if (!response.ok) {
        throw new UnexpectedResponseError(
          `Apple's storage refused part of the file with HTTP ${response.status}; the upload URL may have expired, so run the upload again.`,
        );
      }
    },
    async download(path: string, query: AscQuery = {}): Promise<Uint8Array> {
      const url = apiUrl(path);
      for (const [name, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(
          name,
          Array.isArray(value) ? value.join(",") : String(value),
        );
      }
      const response = await sendRequest(url, {
        headers: {
          authorization: await authorization(),
          accept: "application/a-gzip, application/json",
        },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => undefined);
        throw new AscApiError(response.status, data);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async downloadSigned(url: string): Promise<Uint8Array> {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        target = new URL("invalid:");
      }
      if (target.protocol !== "https:") {
        throw new UnexpectedResponseError(
          "App Store Connect returned a download without an HTTPS URL.",
        );
      }
      const response = await sendRequest(target, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new UnexpectedResponseError(
          `Apple's storage refused the download with HTTP ${response.status}; the download URL may have expired, so run the command again.`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/** Paging summary for one page: pass `nextCursor` back as `--cursor` to read the next one. */
export function pageInfo(document: AscDocument<unknown>): {
  total?: number;
  hasMore: boolean;
  nextCursor?: string;
} {
  const next = document.links?.next;
  let nextCursor: string | undefined;
  try {
    nextCursor = next
      ? (new URL(next).searchParams.get("cursor") ?? undefined)
      : undefined;
  } catch {
    nextCursor = undefined;
  }
  return {
    total: document.meta?.paging?.total,
    hasMore: next !== undefined,
    nextCursor,
  };
}

/** The included resource a to-one relationship points at, if the response carries it. */
export function related<Attributes>(
  document: Pick<AscDocument<unknown>, "included">,
  resource: AscResource<unknown>,
  relationship: string,
): Attributes | undefined {
  const ref = resource.relationships?.[relationship]?.data;
  if (!ref) return undefined;
  return document.included?.find(
    (item) => item.type === ref.type && item.id === ref.id,
  )?.attributes as Attributes | undefined;
}
