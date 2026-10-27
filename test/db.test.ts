import { describe, expect, test } from "bun:test";
import { insertDigest, insertMetrics, insertPosts, lastSeen, markSent, needsRemeasure, openDb, pendingByChannel, unsentDigests, writeTranslations, type NewPost } from "../src/db.ts";

const mk = (id: number, posted_at: string, channel = "c1"): NewPost => ({
  channel,
  post_id: id,
  posted_at,
  text_am: `post ${id}`,
  photo_urls: [],
  url: `https://t.me/${channel}/${id}`,
  views: 100,
  reactions: 0,
});

describe("db", () => {
  test("insert is idempotent and lastSeen tracks max id per channel", () => {
    const db = openDb(":memory:");
    expect(lastSeen(db, "c1")).toBe(0);
    expect(insertPosts(db, [mk(1, "2026-09-18T10:00:00.000Z"), mk(5, "2026-09-18T11:00:00.000Z")])).toBe(2);
    expect(insertPosts(db, [mk(5, "2026-09-18T11:00:00.000Z"), mk(7, "2026-09-18T12:00:00.000Z", "c2")])).toBe(1);
    expect(lastSeen(db, "c1")).toBe(5);
    expect(lastSeen(db, "c2")).toBe(7);
  });

  test("pendingByChannel respects window and skips translated rows", () => {
    const db = openDb(":memory:");
    insertPosts(db, [
      mk(1, "2026-09-17T10:00:00.000Z"), // outside window
      mk(2, "2026-09-18T10:00:00.000Z"),
      mk(3, "2026-09-18T11:00:00.000Z"),
      mk(4, "2026-09-18T11:30:00.000Z", "c2"),
    ]);
    writeTranslations(db, "c1", [{ id: 2, en: "two" }]);
    const pending = pendingByChannel(db, "2026-09-18T00:00:00.000Z", "2026-09-19T00:00:00.000Z");
    expect(pending.get("c1")?.map((p) => p.post_id)).toEqual([3]);
    expect(pending.get("c2")?.map((p) => p.post_id)).toEqual([4]);
    const row = db.query("SELECT text_en FROM posts WHERE channel='c1' AND post_id=2").get() as { text_en: string };
    expect(row.text_en).toBe("two");
  });

  test("metrics append one row per observation", () => {
    const db = openDb(":memory:");
    const p = mk(1, "2026-09-18T10:00:00.000Z");
    insertMetrics(db, [p], "2026-09-18T12:00:00.000Z");
    insertMetrics(db, [{ ...p, views: 900 }], "2026-09-20T12:00:00.000Z");
    insertMetrics(db, [p], "2026-09-20T12:00:00.000Z"); // same observation again: ignored
    const rows = db.query("SELECT views FROM post_metrics ORDER BY observed_at").all() as { views: number }[];
    expect(rows.map((r) => r.views)).toEqual([100, 900]);
  });

  test("needsRemeasure finds posts without a 48h+ observation", () => {
    const db = openDb(":memory:");
    const posts = [
      mk(1, "2026-09-10T10:00:00.000Z"), // before window
      mk(2, "2026-09-15T10:00:00.000Z"), // measured at 50h: done
      mk(3, "2026-09-16T10:00:00.000Z"), // measured at 2h only: needs re-read
      mk(4, "2026-09-17T10:00:00.000Z"), // no metrics at all: needs re-read
      mk(5, "2026-09-19T10:00:00.000Z"), // too young
      mk(9, "2026-09-16T12:00:00.000Z", "c2"),
    ];
    insertPosts(db, posts);
    insertMetrics(db, [posts[1]], "2026-09-17T12:00:00.000Z");
    insertMetrics(db, [posts[2]], "2026-09-16T12:00:00.000Z");
    const r = needsRemeasure(db, "2026-09-12T00:00:00.000Z", "2026-09-18T00:00:00.000Z");
    expect(r).toEqual([
      { channel: "c1", min_id: 3, max_id: 4, min_posted_at: "2026-09-16T10:00:00.000Z" },
      { channel: "c2", min_id: 9, max_id: 9, min_posted_at: "2026-09-16T12:00:00.000Z" },
    ]);
  });

  test("digests stay unsent until marked", () => {
    const db = openDb(":memory:");
    const a = insertDigest(db, "c1", [1, 2], "<b>c1</b>");
    const b = insertDigest(db, "c2", [3], "<b>c2</b>");
    expect(unsentDigests(db).map((d) => d.id)).toEqual([a, b]);
    markSent(db, [a]);
    const left = unsentDigests(db);
    expect(left.map((d) => d.id)).toEqual([b]);
    expect(JSON.parse(left[0].post_ids)).toEqual([3]);
  });
});
