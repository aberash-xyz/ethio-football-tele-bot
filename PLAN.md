# Ethiopian Football Telegram Digest — Plan

Daily English digest of Amharic football Telegram channels, delivered to me via a Telegram bot. Private tool. Corpus stored from day one so it can be counted later.

Written 2026-09-19. Move this file into the new repo as `PLAN.md`.

## Channels

| Handle | Name | Posts/day (observed 2026-09-19) |
|---|---|---|
| `soccer_ethiopia` | Soccer Ethiopia | ~25 |
| `EthiopiaFF1` | Ethiopian Football Federation | ~8 |
| `stgeorge123` | Saint George SC (official) | ~9 |
| `ethiopianlea` | Ethiopian Premier League Share Company | ~2 |

All four are public and readable at `https://t.me/s/<handle>` with no auth. Verified.

## What the preview page gives us

Each post is a `div.tgme_widget_message_wrap` containing:

- `data-post="<handle>/<id>"` on `.tgme_widget_message` — the post id, monotonic per channel
- `<time datetime="2026-09-19T17:54:57+00:00">` — ISO, UTC
- `.tgme_widget_message_text` — HTML body (Amharic, emoji, `<br>`, links)
- `.tgme_widget_message_photo_wrap` with `style="background-image:url(...)"` — photos, public CDN URL
- Page shows ~20 posts. Older: `?before=<id>`. `soccer_ethiopia` exceeds 20/day, so a daily run must paginate until it passes the last-seen id.

Observed content shapes that matter for the prompt:

- Ethiopian calendar dates in text: "መስከረም 29/2019". Must convert to Gregorian in the digest.
- Scores and scorers as text with minute markers: "58' ኢትዮጵያ 0-4 ታንዛኒያ 31' በሽር ኪባልያ". Preserve exactly.
- Fixture lists and results often posted as images with a one-line caption. v1 links the post; v2 reads the image.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Runtime | Bun + TypeScript | Same as synia-sports-web. `bun:sqlite` built in. |
| Source | Scrape `t.me/s/<handle>` | No API keys, no login, no phone number. Fallback if markup breaks: `gramjs` (MTProto). |
| State + corpus | SQLite file committed to repo | One table from day one. Git history = backup. Small (KBs/day). |
| Translation | Claude API, `claude-sonnet-5`, one request per channel per run | Whole day's posts in one call keeps names and context consistent. ~45 posts/day ≈ cents/day. |
| Output shape | Structured output (`output_config.format`) → JSON `{ posts: [{id, en}], digest_md }` | Per-post translation goes to DB; `digest_md` goes to Telegram. |
| Delivery | Telegram Bot API `sendMessage`, HTML parse mode, split at 4096 chars | Same app I already read. |
| Schedule | GitHub Actions cron, 03:00 UTC (06:00 Addis) | Free, no server, secrets in repo settings, commits DB back. |
| Window | Posts with `datetime` in the previous 24h, plus anything newer than last-seen id | Handles Actions cron drift. |

## Repo layout

```
.
├── PLAN.md
├── package.json              bun, @anthropic-ai/sdk, cheerio (or Bun HTMLRewriter)
├── channels.json             [{handle, name}] — edit to add channels
├── data/digest.sqlite        committed by the workflow
├── src/
│   ├── fetch.ts              t.me/s scraper + pagination → Post[]
│   ├── db.ts                 bun:sqlite: posts table, last_seen per channel
│   ├── translate.ts          one Claude call per channel → {posts, digest_md}
│   ├── send.ts               Telegram sendMessage with chunking
│   └── main.ts               orchestrates; never throws on a single channel failure
├── prompts/system.md         translator system prompt + glossary (cached, stable)
└── .github/workflows/digest.yml
```

### `posts` table

```sql
CREATE TABLE posts (
  channel     TEXT NOT NULL,
  post_id     INTEGER NOT NULL,
  posted_at   TEXT NOT NULL,      -- ISO UTC from <time>
  fetched_at  TEXT NOT NULL,
  text_am     TEXT,               -- plain text, HTML stripped, <br> → \n
  text_en     TEXT,               -- filled by translate step
  photo_urls  TEXT,               -- JSON array
  url         TEXT NOT NULL,      -- https://t.me/<channel>/<id>
  PRIMARY KEY (channel, post_id)
);
```

`last_seen` = `MAX(post_id) WHERE channel = ?`. No separate state table.

## Pipeline (`main.ts`)

1. Load `channels.json`.
2. For each channel: fetch page, parse posts, follow `?before=` until a post id ≤ last_seen or datetime < now − 36h. Insert new rows (`INSERT OR IGNORE`). On fetch failure, record the channel as unreachable and continue.
3. Select rows where `text_en IS NULL` and `posted_at` within the window, grouped by channel.
4. Per channel with ≥1 post: one Claude call. Write `text_en` back per post. Collect `digest_md`.
5. Assemble message: date header, then per-channel section in `channels.json` order, then "unreachable: X" footer if any. If nothing new anywhere, send one line saying so.
6. Send. Commit `data/digest.sqlite`.

Steps 2 and 4 are idempotent; re-running the same day re-translates nothing and re-sends the digest. Add `--dry-run` to print instead of send.

## Translation call

- Model `claude-sonnet-5` (was opus-5; ~2.5x cheaper, changed 2026-09-19). Thinking adaptive; `output_config.effort: "medium"` — translation, not reasoning.
- `system` = `prompts/system.md`, marked `cache_control: {type: "ephemeral"}`. Stable, never contains dates.
- User message = channel name + JSON array of `{id, posted_at, text_am, url, photo_count}`.
- Structured output schema:

```json
{
  "posts": [{ "id": 0, "en": "" }],
  "digest_md": ""
}
```

- Streaming not needed at this size. `max_tokens` 16000.
- Catch `Anthropic.RateLimitError` → SDK retries (default 2); on final failure, mark channel failed in the digest, do not write `text_en`, so tomorrow's run picks the posts up again.

### System prompt contents (`prompts/system.md`)

- Role: translator for an English-reading follower of Ethiopian football. Faithful, not summarised. Every score, scorer, minute, fixture, kickoff time, venue, and name survives.
- Ethiopian calendar: any date like "መስከረም 29/2019" → keep original, add Gregorian in parentheses. Ethiopian year 2019 ≈ Sept 2026–Sept 2027; መስከረም 1 = 11 Sept (12 Sept after a leap year). Include the month table in the prompt so the model does not guess.
- Times: Ethiopian 12-hour clock offsets 6h from Western ("8:30 ሰዓት" ≈ 14:30). Give both.
- Glossary, fixed transliterations: ቅዱስ ጊዮርጊስ → Saint George, ኢትዮጵያ ቡና → Ethiopia Bunna, ፋሲል ከነማ → Fasil Kenema, ሀዋሳ ከተማ → Hawassa City, መከላከያ → Mekelakeya (Defence), ወላይታ ድቻ → Wolaitta Dicha, etc. Extend as clubs appear. Player names: transliterate consistently; mark uncertain ones with `(?)` once.
- Ignore: promo, "share and subscribe", betting ads. Note them as one line ("3 promotional posts skipped") rather than dropping silently.
- `digest_md` format: channel heading, then one bullet per post: `HH:MM` local, one-line English gist, then full translation if the post is substantive, `[link]`. Telegram HTML, not Markdown — `<b>`, `<a href>`, no nested tags.

## Telegram bot setup (one-time, manual)

1. Message `@BotFather` → `/newbot` → get `TELEGRAM_BOT_TOKEN`.
2. Send the bot any message.
3. `curl https://api.telegram.org/bot<TOKEN>/getUpdates` → `message.chat.id` = `TELEGRAM_CHAT_ID`.
4. Bot cannot message you until you have messaged it first. This is the only gotcha.

## GitHub Actions (`digest.yml`)

- `schedule: cron: "0 3 * * *"` + `workflow_dispatch` for manual runs.
- Steps: checkout → `oven-sh/setup-bun` → `bun install` → `bun run src/main.ts` → commit `data/digest.sqlite` if changed (`git diff --quiet || git commit`).
- Secrets: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- `permissions: contents: write` for the commit-back.
- Failure = Actions email. Good enough for v1.

## Local dev

```
bun install
cp .env.example .env      # three secrets
bun run src/main.ts --dry-run          # prints digest, writes DB, no send
bun run src/main.ts --since 2026-09-17 # backfill window
```

## Build order (one session)

1. `fetch.ts` + `db.ts`. Run against all four channels, inspect rows. Confirm pagination on `soccer_ethiopia`.
2. `translate.ts` with `--dry-run`. Iterate on `prompts/system.md` against one real day. Check dates and scores by hand on 5 posts.
3. `send.ts`. Chunking test with a long fake digest.
4. Workflow. One `workflow_dispatch` run end to end.
5. Backfill 7 days with `--since` so the corpus starts with a week.

## Not in v1

- **Image reading.** Fixture graphics and result cards are images. v2: for posts with `photo_urls` and short/no text, pass the CDN URL as an image block (`source: {type: "url"}`) in the same call. ~10 lines. Do after a week of seeing how much is missed.
- **Counting.** Sponsor mentions, match-day post volume, club mention share. The table above already supports it; add `queries/` later.
- **Public output.** None. Translated content stays private. Only aggregate counts ever go public.
- **More channels.** Add to `channels.json`. Club official channels are the obvious next set.

## Risks

- `t.me/s` markup changes or starts blocking. Detection: zero posts parsed from a 200 response → fail loudly. Fallback: `gramjs` with a real account, which is a bigger setup.
- Actions cron can be late by up to an hour or skipped under load. Window logic tolerates it.
- Ethiopian-calendar conversion is the most likely translation error. Spot-check weekly.
- Committing a growing SQLite to git: fine for a year at this volume. Revisit at ~50MB.
