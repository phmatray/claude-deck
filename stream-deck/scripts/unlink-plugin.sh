#!/usr/bin/env bash
# Removes the symlink created by link-plugin.sh.
set -euo pipefail

PLUGIN_NAME="com.phmatray.claudedeck.sdPlugin"
LINK="${HOME}/Library/Application Support/com.elgato.StreamDeck/Plugins/${PLUGIN_NAME}"
if [ -L "$LINK" ] || [ -e "$LINK" ]; then
  rm -rf "$LINK"
  echo "Unlinked: $LINK"
else
  echo "Nothing to unlink at $LINK"
fi
