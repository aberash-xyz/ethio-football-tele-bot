import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { PostRow } from "./db.ts";

const MODEL = "claude-sonnet-5";

export const TranslationSchema = z.object({
  posts: z.array(z.object({ id: z.number(), en: z.string() })),
  digest_md: z.string(),
});
export type Translation = z.infer<typeof TranslationSchema>;

let systemPrompt: string | undefined;
async function loadSystem(): Promise<string> {
  systemPrompt ??= await Bun.file(new URL("../prompts/system.md", import.meta.url)).text();
  return systemPrompt;
}

export async function translateChannel(
  client: Anthropic,
  channelName: string,
  posts: PostRow[],
): Promise<Translation> {
  const payload = posts.map((p) => ({
    id: p.post_id,
    posted_at: p.posted_at,
    text_am: p.text_am,
    url: p.url,
    photo_count: (JSON.parse(p.photo_urls || "[]") as string[]).length,
  }));

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(TranslationSchema) },
    system: [{ type: "text", text: await loadSystem(), cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Channel: ${channelName}\n\nPosts (JSON):\n${JSON.stringify(payload, null, 1)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`refusal: ${response.stop_details?.explanation ?? "no explanation"}`);
  }
  if (response.stop_reason === "max_tokens") throw new Error("max_tokens hit; output truncated");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("structured output failed to parse");

  // Keep only ids we actually sent; guard against invented ones.
  const known = new Set(posts.map((p) => p.post_id));
  parsed.posts = parsed.posts.filter((p) => known.has(p.id));

  const u = response.usage;
  console.error(
    `[translate] ${channelName}: ${posts.length} posts, in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`,
  );
  return parsed;
}
