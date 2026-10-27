import * as cheerio from "cheerio";
import type { NewPost } from "./db.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export class ParseError extends Error {}

/** "6.08K" -> 6080, "1.2M" -> 1200000, "950" -> 950. Null if unparseable. */
export function parseCount(s: string): number | null {
  const m = s.trim().match(/^([\d.]+)([KM]?)$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === "M" ? 1e6 : m[2] === "K" ? 1e3 : 1));
}

/** Parse one t.me/s page into posts. Throws ParseError if a 200 page yields zero message wraps. */
export function parsePage(html: string, handle: string): NewPost[] {
  const $ = cheerio.load(html);
  const wraps = $(".tgme_widget_message_wrap");
  if (wraps.length === 0) throw new ParseError(`zero posts parsed for ${handle}`);

  const posts: NewPost[] = [];
  wraps.each((_, wrap) => {
    const msg = $(wrap).find(".tgme_widget_message").first();
    const dataPost = msg.attr("data-post");
    if (!dataPost) return; // service messages / date separators
    const id = Number(dataPost.split("/")[1]);
    if (!Number.isFinite(id)) return;

    const datetime = msg.find("time[datetime]").first().attr("datetime");
    if (!datetime) return;
    const posted_at = new Date(datetime).toISOString();

    const textEl = msg.find(".tgme_widget_message_text").first();
    let text_am: string | null = null;
    if (textEl.length) {
      textEl.find("br").replaceWith("\n");
      text_am = textEl.text().replace(/ /g, " ").trim() || null;
    }

    const photo_urls: string[] = [];
    msg.find(".tgme_widget_message_photo_wrap").each((_, el) => {
      const style = $(el).attr("style") ?? "";
      const m = style.match(/background-image:url\('([^']+)'\)/);
      if (m) photo_urls.push(m[1]);
    });

    const viewsEl = msg.find(".tgme_widget_message_views").first();
    const views = viewsEl.length ? parseCount(viewsEl.text()) : null;

    // <span class="tgme_reaction"><i><b>❤</b></i>10</span> - count is the trailing text
    let reactions = 0;
    msg.find(".tgme_reaction").each((_, el) => {
      const m = $(el).text().match(/([\d.]+[KM]?)\s*$/);
      reactions += (m && parseCount(m[1])) ?? 0;
    });

    posts.push({ channel: handle, post_id: id, posted_at, text_am, photo_urls, url: `https://t.me/${handle}/${id}`, views, reactions });
  });
  return posts;
}

async function fetchPage(handle: string, before?: number): Promise<string> {
  const url = `https://t.me/s/${handle}${before ? `?before=${before}` : ""}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export interface FetchOpts {
  lastSeen: number;
  /** Stop paginating once the oldest post on a page is older than this ISO timestamp. */
  minPostedAt: string;
  maxPages?: number;
  /** Start below this id instead of at the newest post. */
  before?: number;
}

/**
 * Fetch newest-first pages, following ?before=<oldest id> until we pass lastSeen
 * or minPostedAt. Returns posts newer than lastSeen and >= minPostedAt.
 */
export async function fetchChannel(handle: string, opts: FetchOpts): Promise<NewPost[]> {
  const { lastSeen, minPostedAt, maxPages = 30 } = opts;
  const all = new Map<number, NewPost>();
  let before = opts.before;

  for (let page = 0; page < maxPages; page++) {
    const html = await fetchPage(handle, before);
    const posts = parsePage(html, handle);
    if (posts.length === 0) break;

    let oldestId = Infinity;
    let oldestAt = "9999";
    for (const p of posts) {
      if (p.post_id < oldestId) oldestId = p.post_id;
      if (p.posted_at < oldestAt) oldestAt = p.posted_at;
      if (p.post_id > lastSeen && p.posted_at >= minPostedAt) all.set(p.post_id, p);
    }

    if (oldestId <= lastSeen || oldestAt < minPostedAt) break;
    if (before !== undefined && oldestId >= before) break; // no progress
    before = oldestId;
  }

  return [...all.values()].sort((a, b) => a.post_id - b.post_id);
}
