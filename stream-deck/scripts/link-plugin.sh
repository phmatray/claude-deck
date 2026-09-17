#!/usr/bin/env bash
# Symlinks this plugin's `.sdPlugin/` directory into the Stream Deck app's
# Plugins folder (~/Library/Application Support/com.elgato.StreamDeck/Plugins/).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_NAME="com.phmatray.claudedeck.sdPlugin"
PLUGIN_DIR="${ROOT}/${PLUGIN_NAME}"

# Sanity: plugin folder must exist
if [ ! -d "$PLUGIN_DIR" ]; then
  echo "error: plugin folder not found at $PLUGIN_DIR" >&2
  exit 1
fi

PLUGINS_DIR="${HOME}/Library/Application Support/com.elgato.StreamDeck/Plugins"
LINK="${PLUGINS_DIR}/${PLUGIN_NAME}"
mkdir -p "$PLUGINS_DIR"
if [ -L "$LINK" ] || [ -e "$LINK" ]; then
  rm -rf "$LINK"
fi
ln -s "$PLUGIN_DIR" "$LINK"
echo "✓ symlink: ${LINK} → ${PLUGIN_DIR}"
