type ErrorKind =
  | "invalid_input"
  | "quota"
  | "unavailable"
  | "network"
  | "file"
  | "unexpected";

/** Thrown for a non-2xx response from the iTunes Search or Lookup API. */
export class AppStoreApiError extends Error {
  override name = "AppStoreApiError";
  readonly status: number;

  constructor(status: number) {
    super(`App Store request failed with HTTP ${status}`);
    this.status = status;
  }
}

/** Thrown when a history or snapshot file cannot be used. */
export class StateFileError extends Error {
  override name = "StateFileError";
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

const FILE_CODES = new Set(["EACCES", "EPERM", "EISDIR", "ENOTDIR", "EROFS"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The first matching error code on the error or in its cause chain. */
function errorCode(error: unknown, codes: Set<string>): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth++) {
    const { code } = current;
    if (typeof code === "string" && codes.has(code)) return code;
    current = current.cause;
  }
  return undefined;
}

/** Whether a failed request is worth retrying after a pause. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof AppStoreApiError) {
    return error.status === 403 || error.status === 429 || error.status >= 500;
  }
  return (
    (error instanceof Error && error.name === "TimeoutError") ||
    errorCode(error, NETWORK_CODES) !== undefined
  );
}

/** Classify any error from the App Store or the local files into an actionable message. */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof StateFileError) {
    return { kind: "file", message: error.message };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      kind: "network",
      message: "The request timed out. Retry shortly.",
    };
  }
  if (error instanceof AppStoreApiError) {
    const { status } = error;
    if (status === 400) {
      return {
        status,
        kind: "invalid_input",
        message:
          "Apple rejected the request (HTTP 400). Check that the country is an App Store storefront code.",
      };
    }
    // Apple answers 403 as well as 429 when an IP sends too many requests.
    if (status === 403 || status === 429) {
      return {
        status,
        kind: "quota",
        message: `Apple is rate-limiting App Store requests (HTTP ${status}). Wait a few minutes, then send fewer terms or apps per run.`,
      };
    }
    if (status >= 500) {
      return {
        status,
        kind: "unavailable",
        message: `The App Store could not complete the request (HTTP ${status}). Retry later.`,
      };
    }
  }
  const network = errorCode(error, NETWORK_CODES);
  if (network) {
    return {
      kind: "network",
      message: `Network error (${network}). Check your connection and retry.`,
    };
  }
  const file = errorCode(error, FILE_CODES);
  if (file) {
    return {
      kind: "file",
      message: `Could not read or write the file (${file}). Check the path and its permissions.`,
    };
  }
  return { kind: "unexpected", message: "Unexpected error." };
}
