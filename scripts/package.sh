#!/usr/bin/env bash
# Builds dist/com.phmatray.claudedeck.streamDeckPlugin, the double-clickable installer.
# Only a real install imports the bundled "Claude Deck" profile, so install this once
# even when you plan to develop against a symlink (stream-deck/scripts/link-plugin.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="com.phmatray.claudedeck.sdPlugin"

cd "$ROOT/stream-deck"
corepack pnpm install --frozen-lockfile
corepack pnpm build

# Pack runs against a throwaway copy, never the working tree. `streamdeck pack` rewrites
# the manifest it is given — it pads Version to four parts (3.1.0 becomes 3.1.0.0) and
# there is no undo — so packing in place would leave the repository dirty after every
# build and fight release-please, which writes a plain three-part version into that same
# field. The folder has to keep its name inside the staging directory: validate treats a
# UUID that does not match its folder as an error.
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
cp -R "$PLUGIN" "$STAGING/$PLUGIN"

mkdir -p "$ROOT/dist"
corepack pnpm exec streamdeck pack "$STAGING/$PLUGIN" --output "$ROOT/dist/" --force --no-update-check
