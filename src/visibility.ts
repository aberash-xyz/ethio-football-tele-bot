import type { Database } from "bun:sqlite";
import { esc } from "./brief.ts";

// The weekly visibility index, as defined in METHODOLOGY.md. Everything here is
// deterministic: same DB + clubs.json + channels.json -> same numbers.

export const METHOD_VERSION = "v1";

const HOURS = 3600e3;
const EAT_OFFSET = 3 * HOURS;
const WEEK = 7 * 24 * HOURS;

export interface Club {
  slug: string;
  name: string;
  aliases_am: string[];
  aliases_en: string[];
  seasons: string[];
}

export interface Channel {
  handle: string;
  name: string;
  kind: string; // media | federation | league | club_owned
  club?: string;
}

/** Monday 00:00 EAT of the week containing `d`. */
export function weekStart(d: Date): Date {
  const eat = new Date(d.getTime() + EAT_OFFSET);
  const back = (eat.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate() - back) - EAT_OFFSET);
}

/** Ethiopian-calendar season of `d`, e.g. "2019EC" for Oct 2026. */
export function season(d: Date): string {
  const eat = new Date(d.getTime() + EAT_OFFSET);
  const y = eat.getUTCFullYear();
  // ponytail: EC new year is 11 Sep, 12 Sep after an EC leap year; a day of slack in pre-season.
  return `${eat.getTime() >= Date.UTC(y, 8, 11) ? y - 7 : y - 8}EC`;
}

/** Slugs of clubs a post names. Amharic text when present, English only as fallback. */
export function tagClubs(am: string | null, en: string | null, clubs: Club[]): string[] {
  if (am) return clubs.filter((c) => c.aliases_am.some((a) => am.includes(a))).map((c) => c.slug);
  if (en) return clubs.filter((c) => c.aliases_en.some((a) => en.includes(a))).map((c) => c.slug);
  return [];
}

export interface ClubRow {
  slug: string;
  name: string;
  views: number;
  posts: number;
  share: number; // percent, sums to 100 across rows
  rank: number;
  prev_rank: number | null;
}

export interface WeekIndex {
  method: string;
  season: string;
  week_start: string; // ISO UTC instant of Monday 00:00 EAT
  week_end: string;
  channels: string[]; // eligible channel names
  rows: ClubRow[];
  views_total: number; // sum of club views - the share denominator
  posts_total: number; // eligible-channel posts in the week
  posts_tagged: number;
  measured_early: number; // no 48h+ observation, latest used
  unmeasured: number; // no observation at all, scored 0
  own: { channel: string; club: string; posts: number; views: number }[];
  top_posts: { url: string; views: number; clubs: string[]; text: string }[];
}

interface PostWithViews {
  channel: string;
  url: string;
  text_am: string | null;
  text_en: string | null;
  v48: number | null;
  vlast: number | null;
  measured: number; // 1 if any metrics row exists
}

function score(db: Database, start: Date, clubs: Club[], channels: Channel[]): WeekIndex {
  const end = new Date(start.getTime() + WEEK);
  const ssn = season(start);
  const ranked = clubs.filter((c) => c.seasons.includes(ssn));
  const nameOf = new Map(clubs.map((c) => [c.slug, c.name]));
  const byHandle = new Map(channels.map((c) => [c.handle, c]));

  const posts = db
    .query<PostWithViews, [string, string]>(
      `SELECT p.channel, p.url, p.text_am, p.text_en,
         (SELECT m.views FROM post_metrics m
          WHERE m.channel = p.channel AND m.post_id = p.post_id
            AND julianday(m.observed_at) >= julianday(p.posted_at) + 2
          ORDER BY m.observed_at LIMIT 1) AS v48,
         (SELECT m.views FROM post_metrics m
          WHERE m.channel = p.channel AND m.post_id = p.post_id
          ORDER BY m.observed_at DESC LIMIT 1) AS vlast,
         EXISTS (SELECT 1 FROM post_metrics m WHERE m.channel = p.channel AND m.post_id = p.post_id) AS measured
       FROM posts p
       WHERE p.posted_at >= ? AND p.posted_at < ?`,
    )
    .all(start.toISOString(), end.toISOString());

  const acc = new Map(ranked.map((c) => [c.slug, { views: 0, posts: 0 }]));
  const own = new Map<string, { channel: string; club: string; posts: number; views: number }>();
  const tagged: WeekIndex["top_posts"] = [];
  let postsTotal = 0;
  let measuredEarly = 0;
  let unmeasured = 0;

  for (const p of posts) {
    const ch = byHandle.get(p.channel);
    if (!ch) continue; // channel no longer in the set: not part of this method
    const views = p.v48 ?? p.vlast ?? 0;

    if (ch.kind === "club_owned") {
      const o = own.get(ch.handle) ?? { channel: ch.name, club: nameOf.get(ch.club ?? "") ?? ch.club ?? "", posts: 0, views: 0 };
      o.posts++;
      o.views += views;
      own.set(ch.handle, o);
      continue;
    }

    postsTotal++;
    if (!p.measured) unmeasured++;
    else if (p.v48 === null) measuredEarly++;

    const slugs = tagClubs(p.text_am, p.text_en, ranked);
    if (!slugs.length) continue;
    for (const s of slugs) {
      const a = acc.get(s)!;
      a.views += views; // full credit to every club named
      a.posts++;
    }
    tagged.push({ url: p.url, views, clubs: slugs.map((s) => nameOf.get(s)!), text: (p.text_en ?? p.text_am ?? "").slice(0, 400) });
  }

  const viewsTotal = [...acc.values()].reduce((n, a) => n + a.views, 0);
  const rows: ClubRow[] = ranked
    .map((c) => {
      const a = acc.get(c.slug)!;
      return { slug: c.slug, name: c.name, views: a.views, posts: a.posts, share: viewsTotal ? (a.views / viewsTotal) * 100 : 0, rank: 0, prev_rank: null };
    })
    .sort((x, y) => y.views - x.views || y.posts - x.posts || x.name.localeCompare(y.name));
  rows.forEach((r, i) => (r.rank = i + 1));

  return {
    method: METHOD_VERSION,
    season: ssn,
    week_start: start.toISOString(),
    week_end: end.toISOString(),
    channels: channels.filter((c) => c.kind !== "club_owned").map((c) => c.name),
    rows,
    views_total: viewsTotal,
    posts_total: postsTotal,
    posts_tagged: tagged.length,
    measured_early: measuredEarly,
    unmeasured,
    own: [...own.values()],
    top_posts: tagged.sort((a, b) => b.views - a.views).slice(0, 5),
  };
}

/** The index for the week starting `start`, with rank changes against the week before. */
export function computeWeek(db: Database, start: Date, clubs: Club[], channels: Channel[]): WeekIndex {
  const cur = score(db, start, clubs, channels);
  const prev = score(db, new Date(start.getTime() - WEEK), clubs, channels);
  if (prev.views_total > 0) {
    const prevRank = new Map(prev.rows.map((r) => [r.slug, r.rank]));
    for (const r of cur.rows) r.prev_rank = prevRank.get(r.slug) ?? null;
  }
  return cur;
}

// ---------- rendering ----------

const fmtDate = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(iso).toLocaleDateString("en-GB", { ...opts, timeZone: "Africa/Addis_Ababa" });

export function weekLabel(idx: WeekIndex): string {
  const last = new Date(new Date(idx.week_end).getTime() - 1).toISOString();
  return `${fmtDate(idx.week_start, { day: "numeric", month: "short" })} – ${fmtDate(last, { day: "numeric", month: "short", year: "numeric" })}`;
}

/** "▲2", "▼1", "=", or "" when there is no previous week to compare. */
export function rankDelta(r: ClubRow): string {
  if (r.prev_rank === null) return "";
  const d = r.prev_rank - r.rank;
  return d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : "=";
}

const pct = (n: number) => `${n.toFixed(1)}%`;
const num = (n: number) => n.toLocaleString("en-US");

function footnotes(idx: WeekIndex): string[] {
  const lines = [
    `Source: ${idx.posts_total} posts from ${idx.channels.join(", ")}; ${idx.posts_tagged} named a club, ${num(idx.views_total)} club-attributed views.`,
  ];
  for (const o of idx.own) lines.push(`Club-owned channel excluded: ${o.channel} (${o.posts} posts, ${num(o.views)} views).`);
  if (idx.measured_early) lines.push(`${idx.measured_early} posts had no 48h view count; latest count used.`);
  if (idx.unmeasured) lines.push(`${idx.unmeasured} posts had no view count and scored 0.`);
  lines.push(`Method ${idx.method}: share of views on posts naming each club, measured 48h after posting.`);
  return lines;
}

export function renderMarkdown(idx: WeekIndex, commentary: string): string {
  const out = [`# Telegram Visibility Index: Ethiopian Premier League`, ``, `Week of ${weekLabel(idx)} · method ${idx.method}`, ``];
  if (commentary) out.push(commentary, ``);
  out.push(`| # | Club | Share | Views | Posts | Change |`, `|---:|---|---:|---:|---:|:---:|`);
  for (const r of idx.rows) out.push(`| ${r.rank} | ${r.name} | ${pct(r.share)} | ${num(r.views)} | ${r.posts} | ${rankDelta(r)} |`);
  out.push(``, ...footnotes(idx).map((l) => `- ${l}`), ``);
  return out.join("\n");
}

export function renderTelegram(idx: WeekIndex, commentary: string): string {
  const w = Math.max(...idx.rows.map((r) => r.name.length));
  const table = idx.rows
    .map((r) => `${String(r.rank).padStart(2)} ${r.name.padEnd(w)} ${pct(r.share).padStart(6)} ${rankDelta(r).padStart(3)}`)
    .join("\n");
  const out = [`<b>Visibility Index · ${esc(weekLabel(idx))}</b>`, ``];
  if (commentary) out.push(esc(commentary), ``);
  out.push(`<pre>${esc(table)}</pre>`, ``, `<i>${esc(footnotes(idx).join(" "))}</i>`);
  return out.join("\n");
}

/** Static ranked bar chart for LinkedIn/web. One series, light surface, direct value labels. */
export function renderSvg(idx: WeekIndex): string {
  const W = 1200, pad = 56, top = 172, rowH = 48, bar = 24;
  const nameX = 162, barX = 470, labelRoom = 90;
  const maxW = W - pad - barX - labelRoom;
  const maxShare = Math.max(...idx.rows.map((r) => r.share), 0.0001);
  const footY = top + idx.rows.length * rowH + 36;
  const H = footY + 24 * (footnotes(idx).length - 1) + 40;
  const font = `font-family="Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif"`;

  const rows = idx.rows.map((r, i) => {
    const y = top + i * rowH; // row top
    const by = y + (rowH - bar) / 2;
    const bw = (r.share / maxShare) * maxW;
    // Square at the baseline, 4px rounded data end.
    const shape = bw >= 4
      ? `<path d="M${barX} ${by}h${bw - 4}a4 4 0 0 1 4 4v${bar - 8}a4 4 0 0 1 -4 4h${-(bw - 4)}z" fill="#2a78d6"/>`
      : bw > 0 ? `<rect x="${barX}" y="${by}" width="${bw}" height="${bar}" fill="#2a78d6"/>` : "";
    const ty = y + rowH / 2 + 7;
    return [
      `<text x="96" y="${ty}" text-anchor="end" font-size="20" fill="#52514e">${r.rank}</text>`,
      `<text x="108" y="${ty - 1}" font-size="15" fill="#52514e">${esc(rankDelta(r))}</text>`,
      `<text x="${nameX}" y="${ty}" font-size="20" fill="#0b0b0b">${esc(r.name)}</text>`,
      shape,
      `<text x="${barX + bw + 10}" y="${ty}" font-size="20" font-weight="600" fill="#0b0b0b">${pct(r.share)}</text>`,
    ].join("");
  });

  const foot = footnotes(idx).map(
    (l, i) => `<text x="${pad}" y="${footY + i * 24}" font-size="15" fill="#52514e">${esc(l)}</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${font}>
<rect width="${W}" height="${H}" fill="#fcfcfb"/>
<text x="${pad}" y="84" font-size="36" font-weight="700" fill="#0b0b0b">Ethiopian Premier League · Telegram Visibility</text>
<text x="${pad}" y="122" font-size="22" fill="#52514e">Week of ${esc(weekLabel(idx))} · share of views on posts naming each club</text>
${rows.join("\n")}
${foot.join("\n")}
</svg>
`;
}
