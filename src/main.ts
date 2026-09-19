import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { fetchChannel } from "./fetch.ts";
import { insertDigest, insertPosts, lastSeen, markSent, openDb, pendingByChannel, unsentDigests, writeTranslations } from "./db.ts";
import { translateChannel } from "./translate.ts";
import { sendTelegram } from "./send.ts";
import channels from "../channels.json";

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    since: { type: "string" }, // YYYY-MM-DD: backfill window start
    "no-translate": { type: "boolean", default: false }, // fetch only
  },
});

const HOURS = 3600e3;
const EAT_OFFSET = 3 * HOURS;

function batchByDay<T extends { posted_at: string }>(posts: T[], max: number): T[][] {
  const byDay = new Map<string, T[]>();
  for (const p of posts) {
    const day = new Date(new Date(p.posted_at).getTime() + EAT_OFFSET).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(p);
  }
  const out: T[][] = [];
  for (const day of [...byDay.keys()].sort()) {
    const list = byDay.get(day)!;
    for (let i = 0; i < list.length; i += max) out.push(list.slice(i, i + max));
  }
  return out;
}
const now = new Date();
const windowEnd = now.toISOString();
const windowStart = args.since
  ? new Date(`${args.since}T00:00:00Z`).toISOString()
  : new Date(now.getTime() - 24 * HOURS).toISOString();
// Fetch a bit further back than the window so late posts / cron drift are covered.
const fetchFloor = args.since ? windowStart : new Date(now.getTime() - 36 * HOURS).toISOString();

const db = openDb();
const unreachable: string[] = [];
const failed: string[] = [];

// 1. Fetch
for (const ch of channels) {
  try {
    // Backfill (--since) must paginate past already-seen ids down to the date floor.
    const floorId = args.since ? 0 : lastSeen(db, ch.handle);
    const posts = await fetchChannel(ch.handle, { lastSeen: floorId, minPostedAt: fetchFloor });
    const n = insertPosts(db, posts);
    console.error(`[fetch] ${ch.handle}: ${posts.length} fetched, ${n} new`);
  } catch (e) {
    console.error(`[fetch] ${ch.handle} FAILED: ${(e as Error).message}`);
    unreachable.push(ch.handle);
  }
}

// 2. Translate. Each channel's digest is stored unsent; send marks it. A failed or
// dry run therefore never loses a digest - the next real run delivers it.
if (!args["no-translate"]) {
  const pending = pendingByChannel(db, windowStart, windowEnd);
  const client = new Anthropic();
  for (const ch of channels) {
    const posts = pending.get(ch.handle);
    if (!posts?.length) continue;
    // One call per EAT day (capped) so backfills don't overflow max_tokens.
    for (const batch of batchByDay(posts, 25)) {
      try {
        const t = await translateChannel(client, ch.name, batch);
        writeTranslations(db, ch.handle, t.posts);
        insertDigest(db, ch.handle, batch.map((p) => p.post_id), t.digest_md.trim());
      } catch (e) {
        console.error(`[translate] ${ch.handle} FAILED: ${(e as Error).message}`);
        if (!failed.includes(ch.handle)) failed.push(ch.handle);
      }
    }
  }
}

// 3. Assemble: all unsent digests, in channels.json order, oldest first within a channel.
const unsent = unsentDigests(db);
const order = new Map(channels.map((c, i) => [c.handle, i]));
const sections = unsent
  .slice()
  .sort((a, b) => (order.get(a.channel) ?? 99) - (order.get(b.channel) ?? 99) || a.id - b.id)
  .map((d) => d.digest_md);
const dateLabel = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Addis_Ababa" });
const parts = [`<b>⚽ Ethiopian football — ${dateLabel}</b>`];
if (sections.length) parts.push(...sections);
else parts.push("<i>No new posts in the last 24h.</i>");
if (failed.length) parts.push(`<i>Translation failed: ${failed.join(", ")} (will retry tomorrow)</i>`);
if (unreachable.length) parts.push(`<i>Unreachable: ${unreachable.join(", ")}</i>`);
const message = parts.join("\n\n");

// 4. Send
if (args["dry-run"] || args["no-translate"]) {
  console.log(message);
} else {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required (or use --dry-run)");
  await sendTelegram(message, { token, chatId });
  markSent(db, unsent.map((d) => d.id));
  console.error(`[send] delivered ${message.length} chars, ${unsent.length} channel digests`);
}

db.close();
if (unreachable.length === channels.length) process.exit(1); // everything down: fail loudly
