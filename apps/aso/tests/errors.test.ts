import { describe, expect, it } from "vitest";
import { AppStoreApiError, classifyError } from "../src/utils/errors.ts";

describe("classifyError", () => {
  it.each([
    [400, "invalid_input"],
    [403, "quota"],
    [429, "quota"],
    [503, "unavailable"],
  ])("should classify App Store HTTP %i as %s", (status, kind) => {
    expect(classifyError(new AppStoreApiError(status)).kind).toBe(kind);
  });

  it("should classify a timeout as network", () => {
    const error = new DOMException("timed out", "TimeoutError");
    expect(classifyError(error).kind).toBe("network");
  });

  it("should classify network codes in the cause chain", () => {
    const error = new TypeError("fetch failed", {
      cause: { code: "ENOTFOUND" },
    });
    expect(classifyError(error)).toMatchObject({ kind: "network" });
  });

  it("should fall back to unexpected", () => {
    expect(classifyError(new Error("boom")).kind).toBe("unexpected");
  });
});
