# ethio-football-tele-bot

Daily English digest of Amharic football Telegram channels, delivered via a Telegram bot. See `PLAN.md` for design and `METHODOLOGY.md` for the weekly visibility index.

## Setup

```sh
bun install
cp .env.example .env   # ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
git config core.hooksPath .githooks   # refuses to commit .env or *.sqlite
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

## Weekly visibility index

```sh
bun run src/weekly.ts --dry-run               # last completed week: write reports/<monday>/, print, no send
bun run src/weekly.ts --week 2026-10-19       # a specific week (any day in it)
bun run src/weekly.ts                         # sends chart + table to Telegram
```

Writes `index.json`, `index.md`, `chart.svg` and `chart.png` to `reports/<monday>/`. Club roster and aliases: `clubs.json`. Definition: `METHODOLOGY.md`.

## Channels

Edit `channels.json`. Corpus lives in `data/digest.sqlite` — local only, not committed (translated content stays private). Back it up with whatever backs up the machine.

## Scheduling (macOS launchd)

Daily digest at 06:00 local; weekly index Wednesdays at 08:00 local.

```sh
bin/install-launchd.sh                                   # install / reinstall agent
launchctl kickstart -k gui/$(id -u)/xyz.aberash.ethio-digest   # run now
tail -f logs/$(date +%F).log
```

`bin/run.sh` is plain bash, so cron works too: `0 6 * * * /path/to/repo/bin/run.sh`.

## Tests

```sh
bun test
```
