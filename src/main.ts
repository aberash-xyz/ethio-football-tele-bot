import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { fetchChannel } from "./fetch.ts";
import { insertDigest, insertPosts, lastSeen, markSent, openDb, pendingByChannel, unsentDigests, writeTranslations } from "./db.ts";
import { translateChannel } from "./translate.ts";
import { mergeFacts, renderBrief, summarize, type ChannelInput } from "./brief.ts";
import type { Brief, StoredFacts } from "./schema.ts";
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

// Lazy so --no-translate stays offline: the SDK wants credentials at construction.
let _client: Anthropic | undefined;
const anthropic = () => (_client ??= new Anthropic());

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

// 2. Translate + extract facts. Each channel's facts are stored unsent; send marks
// them. A failed or dry run therefore never loses work - the next real run delivers it.
if (!args["no-translate"]) {
  const pending = pendingByChannel(db, windowStart, windowEnd);
  for (const ch of channels) {
    const posts = pending.get(ch.handle);
    if (!posts?.length) continue;
    // One call per EAT day (capped) so backfills don't overflow max_tokens.
    for (const batch of batchByDay(posts, 25)) {
      try {
        const { posts: translated, ...facts } = await translateChannel(anthropic(), ch.name, batch);
        writeTranslations(db, ch.handle, translated);
        insertDigest(db, ch.handle, batch.map((p) => p.post_id), JSON.stringify(facts));
      } catch (e) {
        console.error(`[translate] ${ch.handle} FAILED: ${(e as Error).message}`);
        if (!failed.includes(ch.handle)) failed.push(ch.handle);
      }
    }
  }
}

// 3. Assemble: fold every unsent channel's facts into one cross-channel brief.
const unsent = unsentDigests(db);
const order = new Map(channels.map((c, i) => [c.handle, i]));
const nameOf = new Map(channels.map((c) => [c.handle, c.name]));
const dateLabel = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Addis_Ababa" });

const byChannel = new Map<string, ChannelInput>();
let postCount = 0;
let promoSkipped = 0;
for (const d of unsent
  .slice()
  .sort((a, b) => (order.get(a.channel) ?? 99) - (order.get(b.channel) ?? 99) || a.id - b.id)) {
  const facts = JSON.parse(d.digest_md) as StoredFacts;
  postCount += (JSON.parse(d.post_ids) as number[]).length;
  promoSkipped += facts.promo_skipped;
  const cur = byChannel.get(d.channel);
  if (!cur) byChannel.set(d.channel, { channel: nameOf.get(d.channel) ?? d.channel, ...facts });
  else {
    cur.results.push(...facts.results);
    cur.fixtures.push(...facts.fixtures);
    cur.items.push(...facts.items);
  }
}
const inputs = [...byChannel.values()];

const notes: string[] = [];
if (failed.length) notes.push(`Translation failed: ${failed.join(", ")} (will retry tomorrow)`);
if (unreachable.length) notes.push(`Unreachable: ${unreachable.join(", ")}`);

let brief: Brief = { headline: "", results: [], fixtures: [], items: [] };
if (inputs.length) {
  // --no-translate stays offline, so it gets the deterministic merge.
  if (args["no-translate"]) brief = mergeFacts(inputs);
  else {
    try {
      brief = await summarize(anthropic(), inputs, dateLabel);
    } catch (e) {
      console.error(`[brief] FAILED: ${(e as Error).message}`);
      brief = mergeFacts(inputs);
      notes.push("Summary pass failed; showing the raw merged facts.");
    }
  }
}
const message = renderBrief(brief, { dateLabel, channelCount: inputs.length, postCount, promoSkipped, notes });

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
