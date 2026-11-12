type ErrorKind =
  | "invalid_input"
  | "auth"
  | "permission"
  | "quota"
  | "not_found"
  | "unavailable"
  | "network"
  | "unexpected";

/** Thrown when no usable App Store Connect key was given. */
export class CredentialsError extends Error {
  override name = "CredentialsError";
}

/** Thrown for a non-2xx response from App Store Connect, carrying its JSON:API error body if any. */
export class AscApiError extends Error {
  override name = "AscApiError";
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, data: unknown) {
    super(`App Store Connect request failed with HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

/** Thrown when fetch rejects, which may be a bare TypeError without a code. */
export class NetworkError extends Error {
  override name = "NetworkError";
}

/** Thrown when App Store Connect answers with a shape we cannot interpret. */
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

const MAX_APPLE_MESSAGE = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The first error of an Apple JSON:API body: `{ errors: [{ status, code, title, detail }] }`. */
function inspect(data: unknown): { code?: string; detail?: string } {
  const first =
    isRecord(data) && Array.isArray(data.errors) ? data.errors[0] : undefined;
  if (!isRecord(first)) return {};
  return {
    code: str(first.code),
    detail: str(first.detail) ?? str(first.title),
  };
}

function appleDetail(detail: string | undefined): string {
  return detail
    ? ` App Store Connect said: "${detail.slice(0, MAX_APPLE_MESSAGE)}"`
    : "";
}

/** Apple's codes are hierarchical (`PARAMETER_ERROR.INVALID`), so match by prefix. */
function hasPrefix(code: string | undefined, prefix: string): boolean {
  return code === prefix || code?.startsWith(`${prefix}.`) === true;
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

/** Classify any error thrown while talking to App Store Connect into an actionable, non-sensitive message. */
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
      message: "App Store Connect did not answer in time; retry shortly.",
    };
  }

  if (error instanceof AscApiError) {
    const { status } = error;
    const { code, detail } = inspect(error.data);
    const base = { status, reason: code };

    // Not retried: the allowance is per key per rolling hour.
    if (status === 429 || hasPrefix(code, "RATE_LIMIT_EXCEEDED")) {
      return {
        ...base,
        kind: "quota",
        message:
          "App Store Connect rate limit exceeded for this API key (an hourly allowance per key). Wait before retrying.",
      };
    }
    if (status === 401 || hasPrefix(code, "NOT_AUTHORIZED")) {
      return {
        ...base,
        kind: "auth",
        message:
          "App Store Connect rejected the API key: it may be revoked, or its issuer ID or key ID does not match the private key. " +
          "Check --key-id, --issuer-id and --private-key (or the ASC_* variables).",
      };
    }
    if (status === 403 || hasPrefix(code, "FORBIDDEN_ERROR")) {
      return {
        ...base,
        kind: "permission",
        message: `App Store Connect refused this request: the API key's role may not allow it, or the key may be revoked.${appleDetail(detail)}`,
      };
    }
    if (
      status === 404 ||
      hasPrefix(code, "NOT_FOUND") ||
      hasPrefix(code, "PATH_ERROR")
    ) {
      return {
        ...base,
        kind: "not_found",
        message: `App Store Connect found no such resource; check the app ID with the apps command.${appleDetail(detail)}`,
      };
    }
    if (
      status === 400 ||
      hasPrefix(code, "PARAMETER_ERROR") ||
      hasPrefix(code, "ENTITY_INVALID")
    ) {
      return {
        ...base,
        kind: "invalid_input",
        message: `App Store Connect rejected the request as invalid.${appleDetail(detail)}`,
      };
    }
    if (status >= 500) {
      return {
        ...base,
        kind: "unavailable",
        message: `App Store Connect could not complete the request (HTTP ${status}); retry shortly.`,
      };
    }
    return {
      ...base,
      kind: "unexpected",
      message: `App Store Connect answered with HTTP ${status}.${appleDetail(detail)}`,
    };
  }

  const code = networkCode(error);
  if (code || error instanceof NetworkError) {
    return {
      kind: "network",
      message: `Network error while contacting App Store Connect${code ? ` (${code})` : ""}. Check connectivity and retry.`,
    };
  }

  return {
    kind: "unexpected",
    message: "Unexpected error while calling App Store Connect.",
  };
}
