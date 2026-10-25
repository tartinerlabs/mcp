import type { CallToolResult } from "@modelcontextprotocol/server";
import { logger } from "./logger.ts";

type ErrorKind =
  | "invalid_input"
  | "quota"
  | "unavailable"
  | "network"
  | "unexpected";

/** Thrown for a non-2xx response from the iTunes Search API. */
export class AppStoreApiError extends Error {
  override name = "AppStoreApiError";
  readonly status: number;

  constructor(status: number) {
    super(`App Store search failed with HTTP ${status}`);
    this.status = status;
  }
}

interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  status?: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The first network error code on the error or in its cause chain. */
function networkCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth++) {
    const code = typeof current.code === "string" ? current.code : undefined;
    if (code && NETWORK_CODES.has(code)) return code;
    current = current.cause;
  }
  return undefined;
}

/** Classify any error thrown while searching the App Store into an actionable message. */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      kind: "network",
      message: "The App Store search timed out. Retry shortly.",
    };
  }

  if (error instanceof AppStoreApiError) {
    const { status } = error;
    // Apple answers an unknown storefront with 400.
    if (status === 400) {
      return {
        status,
        kind: "invalid_input",
        message:
          "Apple rejected the search (HTTP 400). Check that each country is an App Store storefront code.",
      };
    }
    // The iTunes Search API signals its rate limit with 403 as well as 429.
    if (status === 403 || status === 429) {
      return {
        status,
        kind: "quota",
        message: `Apple is rate-limiting App Store searches (HTTP ${status}). Wait a minute, then check fewer terms or countries per call.`,
      };
    }
    if (status >= 500) {
      return {
        status,
        kind: "unavailable",
        message: `App Store search could not complete the request (HTTP ${status}). Retry later.`,
      };
    }
  }

  const code = networkCode(error);
  if (code) {
    return {
      kind: "network",
      message: `Network error (${code}) reaching App Store search. Retry shortly.`,
    };
  }

  return {
    kind: "unexpected",
    message: "Unexpected error. Check the server logs for details.",
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
