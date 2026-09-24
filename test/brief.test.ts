import { describe, expect, test } from "bun:test";
import { mergeFacts, renderBrief, type ChannelInput } from "../src/brief.ts";
import type { Brief } from "../src/schema.ts";

const META = { dateLabel: "Wed 24 Sep 2026", channelCount: 2, postCount: 9, promoSkipped: 0, notes: [] };
const EMPTY: Brief = { headline: "", results: [], fixtures: [], items: [] };

const channel = (name: string, f: Partial<Omit<ChannelInput, "channel">>): ChannelInput => ({
  channel: name,
  results: [],
  fixtures: [],
  items: [],
  promo_skipped: 0,
  ...f,
});

describe("mergeFacts", () => {
  test("folds the same match reported by two channels into one result", () => {
    const merged = mergeFacts([
      channel("A", {
        results: [
          { home: "Saint George", away: "Fasil Kenema", score: "2-0", competition: null, note: null, url: "https://t.me/a/1" },
        ],
      }),
      channel("B", {
        results: [
          // Same match, teams reversed, extra detail the first report lacked.
          { home: "Fasil Kenema", away: "Saint George", score: "2-0", competition: "EPL", note: "Abubeker Nasir 2", url: null },
        ],
      }),
    ]);
    expect(merged.results).toHaveLength(1);
    expect(merged.results[0]).toMatchObject({
      home: "Saint George",
      note: "Abubeker Nasir 2",
      competition: "EPL",
      url: "https://t.me/a/1",
    });
  });

  test("different scorelines for the same pairing stay separate", () => {
    const merged = mergeFacts([
      channel("A", { results: [{ home: "X", away: "Y", score: "2-0", competition: null, note: null, url: null }] }),
      channel("B", { results: [{ home: "X", away: "Y", score: "2-1", competition: null, note: null, url: null }] }),
    ]);
    expect(merged.results).toHaveLength(2);
  });

  test("dedupes fixtures by pairing and items by text; no headline without the editorial pass", () => {
    const fixture = { home: "Tanzania", away: "Ethiopia", competition: null, when_eat: "Sat 27 Sep", venue: null, url: null };
    const merged = mergeFacts([
      channel("A", { fixtures: [fixture], items: [{ topic: "squad" as const, text: "23-man squad named.", url: null }] }),
      channel("B", {
        fixtures: [{ ...fixture, when_eat: "Sat 27 Sep, 16:00 EAT", venue: "Dar es Salaam" }],
        items: [{ topic: "squad" as const, text: "23-man squad named.", url: null }],
      }),
    ]);
    expect(merged.fixtures).toHaveLength(1);
    expect(merged.fixtures[0]!.venue).toBe("Dar es Salaam"); // filled in from the second report
    expect(merged.items).toHaveLength(1);
    expect(merged.headline).toBe("");
  });
});

describe("renderBrief", () => {
  test("escapes model-supplied text so it cannot inject tags", () => {
    const out = renderBrief(
      { ...EMPTY, headline: "A&B <b>bold</b> attempt" },
      { ...META, notes: ["1 < 2 & 3 > 2"] },
    );
    expect(out).toContain("A&amp;B &lt;b&gt;bold&lt;/b&gt; attempt");
    expect(out).toContain("1 &lt; 2 &amp; 3 &gt; 2");
    expect(out.match(/<b>/g)).toHaveLength(1); // only our own title tag
  });

  test("links results and drops non-http urls back to plain text", () => {
    const out = renderBrief(
      {
        ...EMPTY,
        results: [
          { home: "Saint George", away: "Fasil Kenema", score: "2-0", competition: "EPL", note: "Nasir 2", url: "https://t.me/a/1" },
          { home: "X", away: "Y", score: "1-1", competition: null, note: null, url: "javascript:alert(1)" },
        ],
      },
      META,
    );
    expect(out).toContain('<a href="https://t.me/a/1">Saint George 2-0 Fasil Kenema</a>');
    expect(out).toContain("<i>(EPL)</i> — Nasir 2");
    expect(out).toContain("• X 1-1 Y");
    expect(out).not.toContain("javascript:");
  });

  test("item text stays plain; the source hangs off the end", () => {
    const out = renderBrief(
      { ...EMPTY, items: [{ topic: "official", text: "The EFF named a squad.", url: "https://t.me/a/2" }] },
      META,
    );
    expect(out).toContain('• The EFF named a squad. <a href="https://t.me/a/2">↗</a>');
  });

  test("orders items squad-first regardless of input order", () => {
    const out = renderBrief(
      {
        ...EMPTY,
        items: [
          { topic: "other", text: "Other thing.", url: null },
          { topic: "squad", text: "Squad named.", url: null },
        ],
      },
      META,
    );
    expect(out.indexOf("Squad named.")).toBeLessThan(out.indexOf("Other thing."));
  });

  test("no facts at all renders the quiet-day line and no footer", () => {
    const out = renderBrief(EMPTY, { ...META, channelCount: 0, postCount: 0 });
    expect(out).toContain("<i>No new posts in the last 24h.</i>");
    expect(out).not.toContain("channels,");
  });

  test("footer counts channels, posts and skipped promos; notes come last", () => {
    const out = renderBrief(
      { ...EMPTY, headline: "Quiet day." },
      { ...META, promoSkipped: 3, notes: ["Unreachable: stgeorge123"] },
    );
    expect(out).toContain("<i>2 channels, 9 posts, 3 promo skipped</i>");
    expect(out.trimEnd().endsWith("<i>Unreachable: stgeorge123</i>")).toBe(true);
  });
});
