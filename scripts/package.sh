#!/usr/bin/env bash
# Builds dist/ClaudeAsk.streamDeckPlugin, the double-clickable installer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="com.claudeask.streamdeck.sdPlugin"
SRC="$ROOT/streamdeck/$PLUGIN_DIR"
DIST="$ROOT/dist"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

node "$ROOT/scripts/build-profile.mjs" "$SRC/Claude Ask.streamDeckProfile"

echo "installing runtime dependencies"
(cd "$SRC" && npm install --omit=dev --silent --no-audit --no-fund)

mkdir -p "$DIST" "$STAGING/$PLUGIN_DIR"
cp -R "$SRC/." "$STAGING/$PLUGIN_DIR/"
rm -rf "$STAGING/$PLUGIN_DIR/logs" "$STAGING/$PLUGIN_DIR/package-lock.json"

rm -f "$DIST/ClaudeAsk.streamDeckPlugin"
(cd "$STAGING" && zip -qry "$DIST/ClaudeAsk.streamDeckPlugin" "$PLUGIN_DIR" -x "*.DS_Store")

echo "built dist/ClaudeAsk.streamDeckPlugin ($(du -h "$DIST/ClaudeAsk.streamDeckPlugin" | cut -f1))"
