import { describe, expect, test } from "bun:test";
import { ParseError, parsePage } from "../src/fetch.ts";

const html = await Bun.file(new URL("./fixtures/soccer_ethiopia.html", import.meta.url)).text();

describe("parsePage", () => {
  const posts = parsePage(html, "soccer_ethiopia");

  test("parses every message wrap with a data-post id", () => {
    expect(posts.length).toBeGreaterThan(5);
    for (const p of posts) {
      expect(p.channel).toBe("soccer_ethiopia");
      expect(Number.isInteger(p.post_id)).toBe(true);
      expect(p.url).toBe(`https://t.me/soccer_ethiopia/${p.post_id}`);
      expect(p.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  test("ids are unique and page order is ascending", () => {
    const ids = posts.map((p) => p.post_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test("text is HTML-stripped with <br> as newlines", () => {
    const withText = posts.filter((p) => p.text_am);
    expect(withText.length).toBeGreaterThan(0);
    for (const p of withText) {
      expect(p.text_am).not.toMatch(/<[a-z]+/i);
      expect(p.text_am).not.toContain(" ");
    }
    expect(withText.some((p) => p.text_am!.includes("\n"))).toBe(true);
  });

  test("extracts photo CDN urls", () => {
    const withPhotos = posts.filter((p) => p.photo_urls.length > 0);
    expect(withPhotos.length).toBeGreaterThan(0);
    for (const url of withPhotos.flatMap((p) => p.photo_urls)) expect(url).toMatch(/^https:\/\//);
  });

  test("throws ParseError on a 200 page with no posts", () => {
    expect(() => parsePage("<html><body>blocked</body></html>", "x")).toThrow(ParseError);
  });
});
