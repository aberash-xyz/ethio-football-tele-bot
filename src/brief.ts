import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { BriefSchema, type Brief, type Fixture, type Item, type Result, type StoredFacts } from "./schema.ts";

const MODEL = "claude-opus-5";

export interface ChannelInput extends StoredFacts {
  channel: string; // display name
}

let systemPrompt: string | undefined;
async function loadSystem(): Promise<string> {
  systemPrompt ??= await Bun.file(new URL("../prompts/brief.md", import.meta.url)).text();
  return systemPrompt;
}

/**
 * Pass 2: merge every channel's facts into one brief - dedupe the same match
 * reported four times, rank by what a reader actually needs, write the lede.
 */
export async function summarize(client: Anthropic, inputs: ChannelInput[], dateLabel: string): Promise<Brief> {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(BriefSchema) },
    system: [{ type: "text", text: await loadSystem(), cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Today: ${dateLabel}\n\nChannel reports (JSON):\n${JSON.stringify(inputs, null, 1)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`refusal: ${response.stop_details?.explanation ?? "no explanation"}`);
  }
  if (response.stop_reason === "max_tokens") throw new Error("max_tokens hit; output truncated");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("structured output failed to parse");

  const u = response.usage;
  console.error(
    `[brief] ${inputs.length} channels -> ${parsed.results.length}R/${parsed.fixtures.length}F/${parsed.items.length}I, in=${u.input_tokens} out=${u.output_tokens}`,
  );
  return parsed;
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
const pair = (a: string, b: string) => [norm(a), norm(b)].sort().join("|");

/**
 * Deterministic fallback when the editorial pass fails: concatenate and dedupe
 * on exact-ish matches. Worse than the model's merge, better than sending nothing.
 */
export function mergeFacts(inputs: ChannelInput[]): Brief {
  const results = new Map<string, Result>();
  const fixtures = new Map<string, Fixture>();
  const items = new Map<string, Item>();

  for (const ch of inputs) {
    for (const r of ch.results) {
      const key = `${pair(r.home, r.away)}|${norm(r.score)}`;
      const prev = results.get(key);
      if (!prev) results.set(key, { ...r });
      else {
        prev.note ??= r.note;
        prev.competition ??= r.competition;
        prev.url ??= r.url;
      }
    }
    for (const f of ch.fixtures) {
      const key = pair(f.home, f.away);
      const prev = fixtures.get(key);
      if (!prev) fixtures.set(key, { ...f });
      else {
        prev.venue ??= f.venue;
        prev.competition ??= f.competition;
        prev.url ??= f.url;
      }
    }
    for (const i of ch.items) {
      const key = norm(i.text);
      if (!items.has(key)) items.set(key, { ...i });
    }
  }

  return {
    headline: "", // no lede without the editorial pass; render skips it
    results: [...results.values()],
    fixtures: [...fixtures.values()],
    items: [...items.values()],
  };
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const httpUrl = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);

/** Wraps a short label. Only http(s) links reach an href; anything else is plain text. */
function link(label: string, url: string | null): string {
  const href = httpUrl(url);
  return href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label);
}

/** For long text: leave it plain and hang the source off the end, so a whole
 *  sentence doesn't render as one unreadable block of link. */
function withSource(text: string, url: string | null): string {
  const href = httpUrl(url);
  return href ? `${esc(text)} <a href="${esc(href)}">↗</a>` : esc(text);
}

const TOPIC_ORDER: Item["topic"][] = ["squad", "transfer", "injury", "official", "other"];

export interface BriefMeta {
  dateLabel: string;
  channelCount: number;
  postCount: number;
  promoSkipped: number;
  notes: string[]; // failure lines appended verbatim
}

/** Telegram HTML. The model never emits markup - every tag below is ours. */
export function renderBrief(brief: Brief, meta: BriefMeta): string {
  const out: string[] = [`<b>⚽ Ethiopian football — ${esc(meta.dateLabel)}</b>`];

  if (brief.headline.trim()) out.push(esc(brief.headline.trim()));

  if (brief.results.length) {
    const lines = brief.results.map((r) => {
      const comp = r.competition ? ` <i>(${esc(r.competition)})</i>` : "";
      const note = r.note ? ` — ${esc(r.note)}` : "";
      return `• ${link(`${r.home} ${r.score} ${r.away}`, r.url)}${comp}${note}`;
    });
    out.push([`<b>RESULTS</b>`, ...lines].join("\n"));
  }

  if (brief.fixtures.length) {
    const lines = brief.fixtures.map((f) => {
      const comp = f.competition ? ` <i>(${esc(f.competition)})</i>` : "";
      const venue = f.venue ? `, ${esc(f.venue)}` : "";
      return `• ${esc(f.when_eat)} — ${link(`${f.home} v ${f.away}`, f.url)}${comp}${venue}`;
    });
    out.push([`<b>COMING UP</b>`, ...lines].join("\n"));
  }

  if (brief.items.length) {
    const sorted = brief.items
      .slice()
      .sort((a, b) => TOPIC_ORDER.indexOf(a.topic) - TOPIC_ORDER.indexOf(b.topic));
    const lines = sorted.map((i) => `• ${withSource(i.text, i.url)}`);
    out.push([`<b>ALSO</b>`, ...lines].join("\n"));
  }

  if (!brief.results.length && !brief.fixtures.length && !brief.items.length && !brief.headline.trim()) {
    out.push("<i>No new posts in the last 24h.</i>");
  } else {
    const promo = meta.promoSkipped ? `, ${meta.promoSkipped} promo skipped` : "";
    out.push(
      `<i>${meta.channelCount} channel${meta.channelCount === 1 ? "" : "s"}, ${meta.postCount} post${meta.postCount === 1 ? "" : "s"}${promo}</i>`,
    );
  }

  out.push(...meta.notes.map((n) => `<i>${esc(n)}</i>`));
  return out.join("\n\n");
}
