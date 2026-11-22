import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppStoreClient } from "../src/appstore/client.ts";
import { AppStoreApiError } from "../src/utils/errors.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** A client whose clock advances only when it sleeps. */
function setup() {
  let time = 0;
  const sleeps: number[] = [];
  const onRetry = vi.fn();
  const client = createAppStoreClient({
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    onRetry,
  });
  return { client, sleeps, onRetry };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createAppStoreClient", () => {
  it("should search software and map results", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        results: [
          { trackId: 7, trackName: "Habit", artistName: "Dev", other: 1 },
        ],
      }),
    );
    const { client } = setup();

    const apps = await client.search("habit tracker", "us", 200);

    expect(apps).toEqual([{ id: 7, name: "Habit", developer: "Dev" }]);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe("https://itunes.apple.com/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      term: "habit tracker",
      country: "us",
      media: "software",
      entity: "software",
      limit: "200",
    });
  });

  it("should look up listings and drop non-software results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        results: [
          {
            wrapperType: "software",
            trackId: 7,
            trackName: "Habit",
            artistName: "Dev",
            version: "2.0",
            averageUserRating: 4.567,
            userRatingCount: 12,
            screenshotUrls: ["a", "b"],
            ipadScreenshotUrls: ["c"],
          },
          { wrapperType: "artist", artistId: 9 },
        ],
      }),
    );
    const { client } = setup();

    const [listing, ...rest] = await client.lookup([7, 9], "gb");

    expect(rest).toEqual([]);
    expect(listing).toMatchObject({
      id: 7,
      version: "2.0",
      rating: 4.57,
      ratingCount: 12,
      screenshotCount: 3,
      description: "",
    });
  });

  it("should space requests three seconds apart", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({ results: [] }),
    );
    const { client, sleeps } = setup();

    await client.search("a", "us", 10);
    await client.search("b", "us", 10);
    await client.search("c", "us", 10);

    expect(sleeps).toEqual([3000, 3000]);
  });

  it("should retry a rate limit twice, then give up", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => json({}, 403));
    const { client, onRetry } = setup();

    await expect(client.search("a", "us", 10)).rejects.toBeInstanceOf(
      AppStoreApiError,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls.map(([seconds]) => seconds)).toEqual([60, 120]);
  });

  it("should not retry a bad request", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => json({}, 400));
    const { client, onRetry } = setup();

    await expect(client.search("a", "zz", 10)).rejects.toMatchObject({
      status: 400,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
