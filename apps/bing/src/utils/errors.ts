import type { CallToolResult } from "@modelcontextprotocol/server";
import { logger } from "./logger.ts";

type ErrorKind =
  | "invalid_input"
  | "auth"
  | "permission"
  | "quota"
  | "not_found"
  | "unavailable"
  | "network"
  | "unexpected";

/** Thrown when the user has not connected a Bing account, or its token cannot be renewed. */
export class CredentialsError extends Error {
  override name = "CredentialsError";
}

/** Thrown for a non-2xx response from Bing, carrying its WCF fault JSON if any. */
export class BingApiError extends Error {
  override name = "BingApiError";
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, data: unknown) {
    super(`Bing Webmaster request failed with HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

/** Thrown when fetch rejects; Workers reports connection failures as a bare TypeError without a code. */
export class NetworkError extends Error {
  override name = "NetworkError";
}

/** Thrown when Bing answers with a shape we cannot interpret. */
export class UnexpectedResponseError extends Error {
  override name = "UnexpectedResponseError";
}

interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  status?: number;
  reason?: string;
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const MAX_BING_MESSAGE = 300;

/** Bing's ApiErrorCode values (ErrorCode in the fault JSON), by the kind they map to. */
const ERROR_CODE_KINDS: Record<number, ErrorKind> = {
  1: "unavailable", // InternalError
  3: "auth", // InvalidApiKey
  4: "quota", // ThrottleUser
  5: "quota", // ThrottleHost
  6: "permission", // UserBlocked
  7: "invalid_input", // InvalidUrl
  8: "invalid_input", // InvalidParameter
  10: "not_found", // UserNotFound
  11: "not_found", // NotFound
  13: "permission", // NotAllowed
  14: "permission", // NotAuthorized
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A WCF fault body: `{ "ErrorCode": 14, "Message": "..." }`. */
function inspect(data: unknown): { code?: number; message?: string } {
  if (!isRecord(data)) return {};
  return {
    code: typeof data.ErrorCode === "number" ? data.ErrorCode : undefined,
    message: str(data.Message),
  };
}

function bingDetail(message: string | undefined): string {
  return message ? ` Bing said: "${message.slice(0, MAX_BING_MESSAGE)}"` : "";
}

/** The first network error code on the error or in its cause chain. */
function networkCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth++) {
    const code = str(current.code);
    if (code && NETWORK_CODES.has(code)) return code;
    current = current.cause;
  }
  return undefined;
}

function messageFor(kind: ErrorKind, detail: string): string {
  switch (kind) {
    case "auth":
      return "Bing rejected the sign-in: it may have expired or been revoked. Reconnect Bing on this server.";
    case "permission":
      return `Bing refused this request: the connected account may not have access to this site, or the permission was not granted.${detail}`;
    case "quota":
      return "Bing rate limit exceeded for this account. Wait before retrying.";
    case "not_found":
      return `Bing found no such site or URL; check siteUrl with list_sites.${detail}`;
    case "invalid_input":
      return `Bing rejected the request as invalid.${detail}`;
    case "unavailable":
      return "Bing could not complete the request; retry shortly.";
    default:
      return `Bing returned an unexpected error.${detail}`;
  }
}

/** Classify any error thrown while talking to Bing into an actionable, non-sensitive message. */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof CredentialsError) {
    return { kind: "auth", message: error.message };
  }
  if (error instanceof UnexpectedResponseError) {
    return { kind: "unexpected", message: error.message };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      kind: "network",
      message: "Bing did not answer in time; retry shortly.",
    };
  }

  if (error instanceof BingApiError) {
    const { status } = error;
    const { code, message } = inspect(error.data);
    const base = { status, reason: code === undefined ? undefined : `${code}` };
    const detail = bingDetail(message);

    // The fault code is more specific than the HTTP status, so it wins.
    const byCode = code === undefined ? undefined : ERROR_CODE_KINDS[code];
    let kind: ErrorKind | undefined = byCode;
    if (!kind) {
      if (status === 429) kind = "quota";
      else if (status === 401) kind = "auth";
      else if (status === 403) kind = "permission";
      else if (status === 404) kind = "not_found";
      else if (status === 400) kind = "invalid_input";
      else if (status >= 500) kind = "unavailable";
      else kind = "unexpected";
    }
    return {
      ...base,
      kind,
      message:
        kind === "unexpected"
          ? `Bing answered with HTTP ${status}.${detail}`
          : messageFor(kind, detail),
    };
  }

  const code = networkCode(error);
  if (code || error instanceof NetworkError) {
    return {
      kind: "network",
      message: `Network error while contacting Bing${code ? ` (${code})` : ""}. Check connectivity and retry.`,
    };
  }

  return {
    kind: "unexpected",
    message:
      "Unexpected error while calling Bing. Check the server logs for details.",
  };
}

/** Convert an error into an MCP tool result with `isError: true`, logging only non-sensitive fields. */
export function toToolError(tool: string, error: unknown): CallToolResult {
  const classified = classifyError(error);
  logger.warn(
    {
      tool,
      kind: classified.kind,
      status: classified.status,
      reason: classified.reason,
      errorName: error instanceof Error ? error.name : typeof error,
    },
    "tool call failed",
  );
  return {
    isError: true,
    content: [
      { type: "text", text: `[${classified.kind}] ${classified.message}` },
    ],
  };
}
