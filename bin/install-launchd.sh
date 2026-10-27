#!/bin/bash
# Installs every launchd agent in launchd/ pointing at this checkout. Re-run after moving the repo.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/Library/LaunchAgents" "$repo/logs"
for src in "$repo"/launchd/*.plist; do
  label="$(basename "$src" .plist)"
  dst="$HOME/Library/LaunchAgents/$label.plist"
  sed "s|__REPO__|$repo|g" "$src" >"$dst"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dst"
  echo "installed $dst"
  echo "  test now:   launchctl kickstart -k gui/$(id -u)/$label"
  echo "  uninstall:  launchctl bootout gui/$(id -u)/$label"
done
