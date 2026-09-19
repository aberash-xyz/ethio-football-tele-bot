import { describe, expect, test } from "bun:test";
import { insertPosts, lastSeen, openDb, pendingByChannel, writeTranslations, type NewPost } from "../src/db.ts";

const mk = (id: number, posted_at: string, channel = "c1"): NewPost => ({
  channel,
  post_id: id,
  posted_at,
  text_am: `post ${id}`,
  photo_urls: [],
  url: `https://t.me/${channel}/${id}`,
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
});
