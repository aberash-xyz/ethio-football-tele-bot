import Anthropic from "@anthropic-ai/sdk";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { openDb } from "./db.ts";
import { sendTelegram, sendTelegramPhoto } from "./send.ts";
import { computeWeek, renderMarkdown, renderSvg, renderTelegram, weekLabel, weekStart, type WeekIndex } from "./visibility.ts";
import channels from "../channels.json";
import clubs from "../clubs.json";

const { values: args } = parseArgs({
  options: {
    week: { type: "string" }, // YYYY-MM-DD, any day of the week; default: last completed week
    db: { type: "string", default: "data/digest.sqlite" },
    "dry-run": { type: "boolean", default: false }, // write files and print, no Telegram
    "no-llm": { type: "boolean", default: false }, // skip commentary
  },
});

const MODEL = "claude-opus-5-5";

/** 2-3 sentences over the finished table. The model never computes a number. */
async function commentary(idx: WeekIndex): Promise<string> {
  const system = await Bun.file(new URL("../prompts/weekly.md", import.meta.url)).text();
  const payload = {
    week: weekLabel(idx),
    table: idx.rows.map((r) => ({ rank: r.rank, prev_rank: r.prev_rank, club: r.name, share: Number(r.share.toFixed(1)), posts: r.posts })),
    top_posts: idx.top_posts.map((p) => ({ clubs: p.clubs, views: p.views, text: p.text })),
  };
  const response = await new Anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system,
    messages: [{ role: "user", content: JSON.stringify(payload, null, 1) }],
  });
  if (response.stop_reason === "refusal") throw new Error(`refusal: ${response.stop_details?.explanation ?? "no explanation"}`);
  if (response.stop_reason === "max_tokens") throw new Error("max_tokens hit; output truncated");
  return response.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim();
}

const start = weekStart(args.week ? new Date(`${args.week}T12:00:00+03:00`) : new Date(Date.now() - 7 * 24 * 3600e3));
const db = openDb(args.db);
const idx = computeWeek(db, start, clubs, channels);
db.close();

if (!idx.posts_total) {
  console.error(`[weekly] no posts for week of ${weekLabel(idx)}; nothing to publish`);
  process.exit(1);
}

let text = "";
if (!args["no-llm"] && idx.posts_tagged) {
  try {
    text = await commentary(idx);
  } catch (e) {
    console.error(`[weekly] commentary FAILED, publishing without it: ${(e as Error).message}`);
  }
}

// Week folder named by its Monday in EAT.
const dir = `reports/${new Date(start.getTime() + 3 * 3600e3).toISOString().slice(0, 10)}`;
await mkdir(dir, { recursive: true });
await Bun.write(`${dir}/index.json`, JSON.stringify({ ...idx, commentary: text }, null, 2));
await Bun.write(`${dir}/index.md`, renderMarkdown(idx, text));
await Bun.write(`${dir}/chart.svg`, renderSvg(idx));

let png: Blob | null = null;
const conv = Bun.spawnSync(["rsvg-convert", "-z", "2", "-o", `${dir}/chart.png`, `${dir}/chart.svg`], { stderr: "pipe" });
if (conv.success) png = Bun.file(`${dir}/chart.png`);
else console.error(`[weekly] no PNG (install librsvg: brew install librsvg): ${conv.stderr.toString().trim()}`);
console.error(`[weekly] ${weekLabel(idx)}: ${idx.posts_tagged}/${idx.posts_total} posts tagged -> ${dir}`);

if (args["dry-run"]) {
  console.log(renderMarkdown(idx, text));
} else {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required (or use --dry-run)");
  if (png) await sendTelegramPhoto(png, { token, chatId });
  await sendTelegram(renderTelegram(idx, text), { token, chatId });
  console.error("[weekly] sent");
}
