#!/usr/bin/env bash
# Builds dist/com.phmatray.claudedeck.streamDeckPlugin, the double-clickable installer.
# Only a real install imports the bundled "Claude Deck" profile, so install this once
# even when you plan to develop against a symlink (stream-deck/scripts/link-plugin.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/stream-deck"
corepack pnpm install --frozen-lockfile
corepack pnpm build
# pack validates first, strips Nodejs.Debug from the packed manifest, and rewrites
# manifest.json's Version on disk — already 4-part, so the tree stays clean.
corepack pnpm exec streamdeck pack com.phmatray.claudedeck.sdPlugin --output ../dist/ --force --no-update-check
