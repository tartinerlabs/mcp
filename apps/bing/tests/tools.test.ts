import { describe, expect, it } from "vitest";
import { BingApiError, CredentialsError } from "../src/utils/errors.ts";
import { createTestClient, mockClient } from "./helpers.ts";

const SITE = "https://example.com/";
// 2026-01-15T00:00:00.000Z
const DATE = "/Date(1768435200000)/";
const ISO = "2026-01-15T00:00:00.000Z";

describe("list_sites", () => {
  it("should shape sites", async () => {
    const { provider } = mockClient({
      getUserSites: async () => [{ Url: SITE, IsVerified: true }],
    });
    const result = await createTestClient(provider).callTool("list_sites");
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({
      sites: [{ siteUrl: SITE, isVerified: true }],
    });
  });

  it("should add a note when there are none", async () => {
    const result = await createTestClient().callTool("list_sites");
    expect(JSON.parse(result.text).note).toContain("No sites");
  });

  it("should report a missing connection as an auth error", async () => {
    const { provider } = mockClient();
    provider.mockRejectedValue(
      new CredentialsError("Connect Bing at /connect"),
    );
    const result = await createTestClient(provider).callTool("list_sites");
    expect(result).toEqual({
      isError: true,
      text: "[auth] Connect Bing at /connect",
    });
  });
});

describe("url_info", () => {
  it("should convert WCF dates to ISO strings", async () => {
    const { client, provider } = mockClient({
      getUrlInfo: async () => ({
        Url: `${SITE}a`,
        HttpStatus: 200,
        IsPage: true,
        DiscoveryDate: DATE,
        LastCrawledDate: DATE,
        DocumentSize: 1234,
        AnchorCount: 3,
      }),
    });
    const result = await createTestClient(provider).callTool("url_info", {
      siteUrl: SITE,
      url: `${SITE}a`,
    });
    expect(client.getUrlInfo).toHaveBeenCalledWith(SITE, `${SITE}a`);
    expect(JSON.parse(result.text)).toMatchObject({
      httpStatus: 200,
      discoveredAt: ISO,
      lastCrawledAt: ISO,
      documentSize: 1234,
    });
  });

  it("should note a URL that was never crawled", async () => {
    const result = await createTestClient().callTool("url_info", {
      siteUrl: SITE,
      url: `${SITE}new`,
    });
    const body = JSON.parse(result.text);
    expect(body.lastCrawledAt).toBeNull();
    expect(body.note).toContain("not indexed");
  });

  it("should classify a Bing fault", async () => {
    const { provider } = mockClient({
      getUrlInfo: async () => {
        throw new BingApiError(400, { ErrorCode: 7, Message: "Invalid URL" });
      },
    });
    const result = await createTestClient(provider).callTool("url_info", {
      siteUrl: SITE,
      url: `${SITE}a`,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[invalid_input]");
  });
});

describe("crawl_stats", () => {
  it("should shape daily rows", async () => {
    const { provider } = mockClient({
      getCrawlStats: async () => [
        { Date: DATE, CrawledPages: 10, Code4xx: 2, InIndex: 8 },
      ],
    });
    const result = await createTestClient(provider).callTool("crawl_stats", {
      siteUrl: SITE,
    });
    expect(JSON.parse(result.text).stats[0]).toMatchObject({
      date: ISO,
      crawledPages: 10,
      code4xx: 2,
      inIndex: 8,
    });
  });
});

describe("crawl_issues", () => {
  it("should sort by inbound links and apply the limit", async () => {
    const { provider } = mockClient({
      getCrawlIssues: async () => [
        { Url: "a", HttpCode: 404, InLinks: 1, Issues: 2 },
        { Url: "b", HttpCode: 500, InLinks: 9, Issues: 4 },
      ],
    });
    const result = await createTestClient(provider).callTool("crawl_issues", {
      siteUrl: SITE,
      limit: 1,
    });
    const body = JSON.parse(result.text);
    expect(body.total).toBe(2);
    expect(body.issues).toEqual([
      { url: "b", httpCode: 500, inLinks: 9, issues: 4 },
    ]);
  });
});

describe("list_sitemaps", () => {
  it("should shape feeds", async () => {
    const { provider } = mockClient({
      getFeeds: async () => [
        {
          Url: `${SITE}sitemap.xml`,
          Type: "Sitemap",
          Status: "Success",
          UrlCount: 5,
          Submitted: DATE,
          LastCrawled: DATE,
        },
      ],
    });
    const result = await createTestClient(provider).callTool("list_sitemaps", {
      siteUrl: SITE,
    });
    expect(JSON.parse(result.text).sitemaps[0]).toMatchObject({
      url: `${SITE}sitemap.xml`,
      status: "Success",
      urlCount: 5,
      submittedAt: ISO,
      lastCrawledAt: ISO,
    });
  });
});

describe("search_performance", () => {
  const rows = [
    {
      Query: "bing",
      Date: "/Date(1768435200000)/",
      Impressions: 100,
      Clicks: 10,
      AvgImpressionPosition: 2,
    },
    {
      Query: "bing",
      Date: "/Date(1769040000000)/", // 2026-01-22
      Impressions: 300,
      Clicks: 10,
      AvgImpressionPosition: 4,
    },
    {
      Query: "other",
      Date: DATE,
      Impressions: 50,
      Clicks: 0,
      AvgImpressionPosition: 9,
    },
  ];

  it("should aggregate queries with weighted position and sort by impressions", async () => {
    const { client, provider } = mockClient({
      getQueryStats: async () => rows,
    });
    const result = await createTestClient(provider).callTool(
      "search_performance",
      { siteUrl: SITE },
    );
    expect(client.getQueryStats).toHaveBeenCalledWith(SITE);
    expect(JSON.parse(result.text).rows).toEqual([
      {
        query: "bing",
        impressions: 400,
        clicks: 20,
        ctr: 0.05,
        averagePosition: 3.5,
      },
      {
        query: "other",
        impressions: 50,
        clicks: 0,
        ctr: 0,
        averagePosition: 9,
      },
    ]);
  });

  it("should filter by date and use page stats for the page dimension", async () => {
    const { client, provider } = mockClient({ getPageStats: async () => rows });
    const result = await createTestClient(provider).callTool(
      "search_performance",
      { siteUrl: SITE, dimension: "page", startDate: "2026-01-20" },
    );
    expect(client.getPageStats).toHaveBeenCalledWith(SITE);
    const body = JSON.parse(result.text);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ page: "bing", impressions: 300 });
  });
});
