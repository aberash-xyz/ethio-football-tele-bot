import { z } from "zod";

// Shared between the per-channel extraction pass (translate.ts) and the
// cross-channel editorial pass (brief.ts). Both passes speak the same item
// shapes so the second can merge, dedupe and rank the first's output.

export const ResultSchema = z.object({
  home: z.string(),
  away: z.string(),
  score: z.string(), // "2-0", or "1-1 (4-3 pens)"
  competition: z.string().nullable(),
  note: z.string().nullable(), // scorers, red cards, table impact - one clause
  url: z.string().nullable(),
});
export type Result = z.infer<typeof ResultSchema>;

export const FixtureSchema = z.object({
  home: z.string(),
  away: z.string(),
  competition: z.string().nullable(),
  when_eat: z.string(), // "Sat 27 Sep, 16:00 EAT", or "Sat 27 Sep" if no kickoff given
  venue: z.string().nullable(),
  url: z.string().nullable(),
});
export type Fixture = z.infer<typeof FixtureSchema>;

export const ItemSchema = z.object({
  topic: z.enum(["squad", "transfer", "official", "injury", "other"]),
  text: z.string(), // one self-contained sentence
  url: z.string().nullable(),
});
export type Item = z.infer<typeof ItemSchema>;

/** One channel's contribution: full translations for the archive, facts for the brief. */
export const ChannelFactsSchema = z.object({
  posts: z.array(z.object({ id: z.number(), en: z.string() })),
  results: z.array(ResultSchema),
  fixtures: z.array(FixtureSchema),
  items: z.array(ItemSchema),
  promo_skipped: z.number(),
});
export type ChannelFacts = z.infer<typeof ChannelFactsSchema>;

/** What actually gets sent: one brief across every channel. */
export const BriefSchema = z.object({
  headline: z.string(), // 1-3 sentences, the lede
  results: z.array(ResultSchema),
  fixtures: z.array(FixtureSchema),
  items: z.array(ItemSchema),
});
export type Brief = z.infer<typeof BriefSchema>;

/** The facts half of ChannelFacts - what gets persisted per channel until sent. */
export type StoredFacts = Omit<ChannelFacts, "posts">;
