# ethio-football-tele-bot

Daily English digest of Amharic football Telegram channels, delivered via a Telegram bot. See `PLAN.md` for design.

## Setup

```sh
bun install
cp .env.example .env   # ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
```

Telegram bot: `@BotFather` → `/newbot` → token. Message the bot once, then
`curl https://api.telegram.org/bot<TOKEN>/getUpdates` → `message.chat.id`.

## Run

```sh
bun run src/main.ts --no-translate        # fetch only, prints skeleton
bun run src/main.ts --dry-run             # fetch + translate, print, no send
bun run src/main.ts --since 2026-09-12    # backfill window start
bun run src/main.ts                       # full run, sends to Telegram
```

Bun loads `.env` automatically. Re-runs are idempotent for fetch/translate; a full run re-sends the digest.

## Channels

Edit `channels.json`. Corpus lives in `data/digest.sqlite` (committed by the workflow).

## GitHub Actions

`.github/workflows/digest.yml` runs 03:00 UTC daily. Secrets: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
