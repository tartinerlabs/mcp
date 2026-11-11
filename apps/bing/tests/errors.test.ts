import { describe, expect, it } from "vitest";
import {
  BingApiError,
  CredentialsError,
  classifyError,
  NetworkError,
  UnexpectedResponseError,
} from "../src/utils/errors.ts";

function fault(status: number, code: number, message = "Details.") {
  return new BingApiError(status, { ErrorCode: code, Message: message });
}

describe("classifyError", () => {
  it.each([
    [400, 7, "invalid_input"],
    [400, 8, "invalid_input"],
    [401, 3, "auth"],
    [403, 14, "permission"],
    [403, 13, "permission"],
    [404, 11, "not_found"],
    [400, 10, "not_found"],
    [429, 4, "quota"],
    [400, 5, "quota"],
    [500, 1, "unavailable"],
  ])("should classify HTTP %i ErrorCode %i as %s", (status, code, kind) => {
    expect(classifyError(fault(status, code))).toMatchObject({
      kind,
      status,
      reason: String(code),
    });
  });

  it.each([
    [400, "invalid_input"],
    [401, "auth"],
    [403, "permission"],
    [404, "not_found"],
    [429, "quota"],
    [503, "unavailable"],
    [409, "unexpected"],
  ])(
    "should fall back to HTTP %i without a fault body (%s)",
    (status, kind) => {
      expect(classifyError(new BingApiError(status, undefined)).kind).toBe(
        kind,
      );
    },
  );

  it("should pass Bing's message through, truncated", () => {
    const classified = classifyError(fault(400, 8, `bad ${"x".repeat(1000)}`));
    expect(classified.message).toContain('Bing said: "bad x');
    expect(classified.message.length).toBeLessThan(450);
  });

  it("should classify a missing connection as auth with its own message", () => {
    expect(classifyError(new CredentialsError("Connect Bing."))).toEqual({
      kind: "auth",
      message: "Connect Bing.",
    });
  });

  it("should classify an uninterpretable response as unexpected", () => {
    expect(classifyError(new UnexpectedResponseError("no d")).kind).toBe(
      "unexpected",
    );
  });

  it("should classify a timeout as network", () => {
    const error = new DOMException("The operation timed out.", "TimeoutError");
    expect(classifyError(error).kind).toBe("network");
  });

  it("should classify a connection failure in the cause chain as network", () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect"), { code: "ECONNRESET" }),
    });
    expect(classifyError(error).kind).toBe("network");
    expect(
      classifyError(
        new NetworkError("fetch failed", { cause: new TypeError("lost") }),
      ).kind,
    ).toBe("network");
  });

  it("should not echo an unknown error's message", () => {
    const classified = classifyError(new Error("Bearer eyJsecret"));
    expect(classified.kind).toBe("unexpected");
    expect(classified.message).not.toContain("eyJsecret");
  });
});
