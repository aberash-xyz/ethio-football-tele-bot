import { describe, expect, test } from "bun:test";
import { insertMetrics, insertPosts, openDb, type NewPost } from "../src/db.ts";
import { computeWeek, season, tagClubs, weekStart, type Channel, type Club } from "../src/visibility.ts";

const clubs: Club[] = [
  { slug: "stg", name: "Saint George", aliases_am: ["ቅዱስ ጊዮርጊስ"], aliases_en: ["Saint George"], seasons: ["2019EC"] },
  { slug: "bunna", name: "Bunna", aliases_am: ["ኢትዮጵያ ቡና"], aliases_en: ["Ethiopia Bunna"], seasons: ["2019EC"] },
  { slug: "sheger", name: "Sheger Ketema", aliases_am: ["ሸገር ከተማ"], aliases_en: [], seasons: ["2019EC"] },
  { slug: "gone", name: "Relegated FC", aliases_am: ["ወራጅ"], aliases_en: [], seasons: ["2018EC"] },
];
const channels: Channel[] = [
  { handle: "media", name: "Media", kind: "media" },
  { handle: "own", name: "Saint George SC", kind: "club_owned", club: "stg" },
];

describe("week and season", () => {
  test("weeks run Monday 00:00 to Monday 00:00 EAT", () => {
    expect(weekStart(new Date("2026-10-25T20:59:00Z")).toISOString()).toBe("2026-10-18T21:00:00.000Z"); // Sun 23:59 EAT
    expect(weekStart(new Date("2026-10-25T21:00:00Z")).toISOString()).toBe("2026-10-25T21:00:00.000Z"); // Mon 00:00 EAT
  });
  test("Ethiopian-calendar season turns over in September", () => {
    expect(season(new Date("2026-10-26T00:00:00Z"))).toBe("2019EC");
    expect(season(new Date("2026-09-01T00:00:00Z"))).toBe("2018EC");
  });
});

describe("tagClubs", () => {
  test("matches through Amharic prefixes, not the derby nickname", () => {
    expect(tagClubs("የቅዱስ ጊዮርጊስ እና የኢትዮጵያ ቡና ጨዋታ", null, clubs)).toEqual(["stg", "bunna"]);
    expect(tagClubs("የሸገር ደርቢ ዛሬ", null, clubs)).toEqual([]);
  });
  test("English only when there is no Amharic text", () => {
    expect(tagClubs(null, "Saint George win", clubs)).toEqual(["stg"]);
    expect(tagClubs("ፎቶ", "Saint George win", clubs)).toEqual([]);
  });
});

describe("computeWeek", () => {
  const mk = (channel: string, id: number, posted_at: string, text_am: string): NewPost => ({
    channel, post_id: id, posted_at, text_am, photo_urls: [], url: `https://t.me/${channel}/${id}`, views: 0, reactions: 0,
  });

  test("scores views at 48h, credits every named club, excludes club-owned channels", () => {
    const db = openDb(":memory:");
    const at = (post: NewPost, views: number, observed: string) => insertMetrics(db, [{ ...post, views }], observed);
    // previous week (12-18 Oct): Bunna ahead
    const old = mk("media", 1, "2026-10-14T09:00:00.000Z", "ኢትዮጵያ ቡና");
    // this week (19-25 Oct)
    const derby = mk("media", 2, "2026-10-20T09:00:00.000Z", "ቅዱስ ጊዮርጊስ ከ ኢትዮጵያ ቡና");
    const solo = mk("media", 3, "2026-10-21T09:00:00.000Z", "ቅዱስ ጊዮርጊስ");
    const late = mk("media", 4, "2026-10-25T09:00:00.000Z", "ኢትዮጵያ ቡና"); // only an early count
    const self = mk("own", 5, "2026-10-21T09:00:00.000Z", "ቅዱስ ጊዮርጊስ");
    const none = mk("media", 6, "2026-10-22T09:00:00.000Z", "ስታዲየም");
    insertPosts(db, [old, derby, solo, late, self, none]);
    at(old, 500, "2026-10-17T00:00:00.000Z");
    at(derby, 100, "2026-10-20T12:00:00.000Z"); // 3h: ignored once a 48h+ count exists
    at(derby, 1000, "2026-10-22T10:00:00.000Z"); // first 48h+ count: used
    at(derby, 9999, "2026-10-29T00:00:00.000Z"); // later count: ignored
    at(solo, 600, "2026-10-23T10:00:00.000Z");
    at(late, 300, "2026-10-25T20:00:00.000Z");
    at(self, 5000, "2026-10-23T10:00:00.000Z");

    const idx = computeWeek(db, new Date("2026-10-18T21:00:00.000Z"), clubs, channels);
    const row = (slug: string) => idx.rows.find((r) => r.slug === slug)!;

    expect(idx.season).toBe("2019EC");
    expect(idx.rows.map((r) => r.slug)).toEqual(["stg", "bunna", "sheger"]); // relegated club not ranked
    expect(row("stg")).toMatchObject({ views: 1600, posts: 2, rank: 1, prev_rank: 2 });
    expect(row("bunna")).toMatchObject({ views: 1300, posts: 2, rank: 2, prev_rank: 1 });
    expect(row("sheger")).toMatchObject({ views: 0, share: 0 });
    expect(idx.views_total).toBe(2900);
    expect(idx.rows.reduce((n, r) => n + r.share, 0)).toBeCloseTo(100);
    expect(idx).toMatchObject({ posts_total: 4, posts_tagged: 3, measured_early: 1, unmeasured: 1 });
    expect(idx.own).toEqual([{ channel: "Saint George SC", club: "Saint George", posts: 1, views: 5000 }]);
    expect(idx.top_posts[0].clubs).toEqual(["Saint George", "Bunna"]);
  });
});
