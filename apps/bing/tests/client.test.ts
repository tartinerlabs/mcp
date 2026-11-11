import { describe, expect, it, vi } from "vitest";
import { BING_API, createBingClient, toIsoDate } from "../src/bing/client.ts";
import {
  BingApiError,
  NetworkError,
  UnexpectedResponseError,
} from "../src/utils/errors.ts";

function stubFetch(response: Response) {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
}

describe("createBingClient", () => {
  it("should send the token as a bearer header and never as an apikey parameter", async () => {
    const fetch = stubFetch(Response.json({ d: [{ Url: "https://a.com/" }] }));
    const client = createBingClient("tok-123", fetch);
    expect(await client.getUserSites()).toEqual([{ Url: "https://a.com/" }]);

    const url = fetch.mock.calls[0]?.[0] as URL;
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(url.href).toBe(`${BING_API}/GetUserSites`);
    expect(url.searchParams.has("apikey")).toBe(false);
    expect(url.href).not.toContain("tok-123");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok-123",
    );
  });

  it("should pass siteUrl and url as query parameters", async () => {
    const fetch = stubFetch(Response.json({ d: { Url: "x" } }));
    await createBingClient("t", fetch).getUrlInfo(
      "https://a.com/",
      "https://a.com/p?q=1",
    );
    const url = fetch.mock.calls[0]?.[0] as URL;
    expect(url.pathname.endsWith("/GetUrlInfo")).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      siteUrl: "https://a.com/",
      url: "https://a.com/p?q=1",
    });
  });

  it.each([
    ["getCrawlStats", "GetCrawlStats"],
    ["getCrawlIssues", "GetCrawlIssues"],
    ["getFeeds", "GetFeeds"],
    ["getQueryStats", "GetQueryStats"],
    ["getPageStats", "GetPageStats"],
  ] as const)(
    "should call %s as %s and treat a null result as empty",
    async (name, method) => {
      const fetch = stubFetch(Response.json({ d: null }));
      expect(
        await createBingClient("t", fetch)[name]("https://a.com/"),
      ).toEqual([]);
      expect(String(fetch.mock.calls[0]?.[0])).toBe(
        `${BING_API}/${method}?siteUrl=https%3A%2F%2Fa.com%2F`,
      );
    },
  );

  it("should throw BingApiError with the fault body", async () => {
    const body = { ErrorCode: 14, Message: "Not authorized" };
    const error = await createBingClient(
      "t",
      stubFetch(Response.json(body, { status: 403 })),
    )
      .getUserSites()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BingApiError);
    expect(error).toMatchObject({ status: 403, data: body });
  });

  it("should treat a fault delivered with HTTP 200 as an error", async () => {
    const error = await createBingClient(
      "t",
      stubFetch(Response.json({ ErrorCode: 3, Message: "Invalid" })),
    )
      .getUserSites()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BingApiError);
  });

  it("should reject a success body that is not JSON", async () => {
    const error = await createBingClient("t", stubFetch(new Response("<html>")))
      .getUserSites()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnexpectedResponseError);
  });

  it("should wrap a fetch failure as NetworkError", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("Network connection lost."));
    const error = await createBingClient("t", fetch)
      .getUserSites()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
  });
});

describe("toIsoDate", () => {
  it("should convert WCF dates, with or without an offset", () => {
    expect(toIsoDate("/Date(1768435200000)/")).toBe("2026-01-15T00:00:00.000Z");
    expect(toIsoDate("/Date(1768435200000-0700)/")).toBe(
      "2026-01-15T00:00:00.000Z",
    );
    expect(toIsoDate("/Date(-86400000)/")).toBe("1969-12-31T00:00:00.000Z");
  });

  it("should map Bing's unset date (1601-01-01) to null", () => {
    expect(toIsoDate("/Date(-11644473600000)/")).toBeNull();
    expect(toIsoDate("/Date(-11644473600000-0800)/")).toBeNull();
  });

  it("should pass other strings through and map missing values to null", () => {
    expect(toIsoDate("2026-01-15")).toBe("2026-01-15");
    expect(toIsoDate(undefined)).toBeNull();
  });
});
