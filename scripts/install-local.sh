#!/usr/bin/env bash
# Copies the plugin straight into Stream Deck's plugin folder and restarts the app.
# For working on the plugin. End users should install the .streamDeckPlugin instead —
# only the real installer imports the bundled profile, which is what lets the plugin
# switch your deck to its own page.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="com.claudeask.streamdeck.sdPlugin"
SRC="$ROOT/streamdeck/$PLUGIN_DIR"
DEST="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/$PLUGIN_DIR"
APP="/Applications/Elgato Stream Deck.app"

if [[ ! -d "$DEST" ]]; then
  echo "error: $PLUGIN_DIR is not installed yet." >&2
  echo "Run scripts/package.sh and double-click dist/ClaudeAsk.streamDeckPlugin first," >&2
  echo "so Stream Deck imports the 'Claude Ask' profile. Then use this script to iterate." >&2
  exit 1
fi

(cd "$SRC" && npm install --omit=dev --silent --no-audit --no-fund)

echo "stopping Stream Deck"
killall "Stream Deck" 2>/dev/null || true
sleep 3

# Leave the bundled profile alone: it is already imported, and replacing the
# file here has no effect on the installed copy.
rsync -a --delete --exclude logs --exclude "*.streamDeckProfile" "$SRC/" "$DEST/"

echo "starting Stream Deck"
open "$APP"
echo "done — code changes are live after the app finishes loading"
