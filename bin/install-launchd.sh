#!/bin/bash
# Installs the launchd agent pointing at this checkout. Re-run after moving the repo.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
label=xyz.aberash.ethio-digest
dst="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$repo/logs"
sed "s|__REPO__|$repo|g" "$repo/launchd/$label.plist" >"$dst"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$dst"
echo "installed $dst"
echo "test now:   launchctl kickstart -k gui/$(id -u)/$label"
echo "uninstall:  launchctl bootout gui/$(id -u)/$label"
