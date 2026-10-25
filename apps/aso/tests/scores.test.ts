import { describe, expect, it } from "vitest";
import { type StoreApp, toStoreApp } from "../src/appstore/client.ts";
import {
  difficultyScore,
  nameMatch,
  rankOf,
  volumeScore,
} from "../src/appstore/scores.ts";

function app(id: number, name: string, ratingCount = 0): StoreApp {
  return toStoreApp({
    trackId: id,
    trackName: name,
    userRatingCount: ratingCount,
  });
}

describe("nameMatch", () => {
  it.each([
    ["Habit Tracker - HabitKit", "habit tracker", 1],
    ["Tracker for Habits", "habit tracker", 0.5],
    ["Habit Rabbit", "habit tracker", 0],
    ["Todo", "habit", 0],
    ["ＰＤＦ Scanner", "pdf scanner", 1],
  ])("should score %s for %s as %d", (name, term, expected) => {
    expect(nameMatch(name, term)).toBe(expected);
  });
});

describe("volumeScore", () => {
  it("should be 100 when all top 50 names contain the phrase", () => {
    const results = Array.from({ length: 60 }, (_, i) =>
      app(i, "Habit Tracker"),
    );
    expect(volumeScore(results, "habit tracker")).toBe(100);
  });

  it("should count missing results as non-matching", () => {
    expect(volumeScore([app(1, "Habit Tracker")], "habit tracker")).toBe(2);
  });
});

describe("difficultyScore", () => {
  it("should be 100 when the top 10 average a million ratings", () => {
    const results = Array.from({ length: 10 }, (_, i) => app(i, "x", 999_999));
    expect(difficultyScore(results)).toBe(100);
  });

  it("should be 0 for apps without ratings", () => {
    expect(difficultyScore([app(1, "x")])).toBe(0);
  });
});

describe("rankOf", () => {
  it("should return a 1-based position or null", () => {
    const results = [app(10, "a"), app(20, "b")];
    expect(rankOf(results, 20)).toBe(2);
    expect(rankOf(results, 30)).toBeNull();
  });
});

describe("toStoreApp", () => {
  it("should map iTunes Search API fields", () => {
    expect(
      toStoreApp({
        trackId: 1438388363,
        trackName: "Habit Tracker",
        artistName: "Dev",
        bundleId: "com.example.habit",
        primaryGenreName: "Productivity",
        formattedPrice: "Free",
        averageUserRating: 4.81234,
        userRatingCount: 148235,
        trackViewUrl: "https://apps.apple.com/us/app/id1438388363",
      }),
    ).toEqual({
      id: 1438388363,
      name: "Habit Tracker",
      developer: "Dev",
      bundleId: "com.example.habit",
      genre: "Productivity",
      price: "Free",
      rating: 4.81,
      ratingCount: 148235,
      url: "https://apps.apple.com/us/app/id1438388363",
    });
  });
});
