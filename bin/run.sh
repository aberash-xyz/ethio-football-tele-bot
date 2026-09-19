#!/bin/bash
# Daily digest runner for launchd/cron. Logs to logs/, keeps last 30 days.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p logs
log="logs/$(date +%F).log"
{
  echo "=== $(date -u +%FT%TZ) start"
  bun run src/main.ts "$@"
  echo "=== $(date -u +%FT%TZ) done"
} >>"$log" 2>&1
find logs -name '*.log' -mtime +30 -delete
