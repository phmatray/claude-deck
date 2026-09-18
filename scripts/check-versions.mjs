// Self-check for the four version fields that must agree, in a repository where three of
// them are written by release-please and the fourth is derived from them at build time.
//
// The failure this exists to catch is silent in every direction. A marketplace entry that
// disagrees with the plugin it points at makes `claude plugin update` a no-op: Claude Code
// compares the marketplace version against the installed one, so a stale entry leaves users
// on the old hooks with no error anywhere. A Stream Deck manifest that disagrees ships a
// plugin reporting the wrong version in the app's UI, and puts that wrong version inside the
// bundled profile (build-profile.mjs copies it into every action's Plugin.Version).
//
// Run: node scripts/check-versions.mjs   — after `pnpm build`, which stamps the manifest.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (...p) => JSON.parse(readFileSync(path.join(root, ...p), "utf8"));

// release-please writes these three (see release-please-config.json extra-files).
const plugin = read("claude-code", ".claude-plugin", "plugin.json").version;
const marketplace = read(".claude-plugin", "marketplace.json").plugins[0].version;
const streamDeckPackage = read("stream-deck", "package.json").version;
// build-profile.mjs derives this one from plugin.json.
const manifest = read("stream-deck", "com.phmatray.claudedeck.sdPlugin", "manifest.json").Version;

assert.match(plugin, /^\d+\.\d+\.\d+$/, `claude-code plugin.json version "${plugin}" is not plain semver`);

assert.equal(
  marketplace,
  plugin,
  `.claude-plugin/marketplace.json plugins[0].version (${marketplace}) must match claude-code/.claude-plugin/plugin.json (${plugin}) — ` +
    "Claude Code reads the marketplace entry to decide whether an update exists, so a stale one makes `claude plugin update` do nothing at all.",
);

assert.equal(
  streamDeckPackage,
  plugin,
  `stream-deck/package.json version (${streamDeckPackage}) must match claude-code/.claude-plugin/plugin.json (${plugin}).`,
);

assert.equal(
  manifest,
  `${plugin}.0`,
  `com.phmatray.claudedeck.sdPlugin manifest Version (${manifest}) must be ${plugin}.0 — ` +
    "Stream Deck's validator requires four parts, and build-profile.mjs stamps it. Run `corepack pnpm build` in stream-deck/.",
);

// The release-please manifest is the version release-please believes it last released. It
// trails by one only between the release PR being opened and merged, and this check runs on
// that PR too — so compare against the same source of truth the PR itself rewrites.
const released = read(".release-please-manifest.json")["."];
assert.equal(
  released,
  plugin,
  `.release-please-manifest.json (${released}) must match claude-code/.claude-plugin/plugin.json (${plugin}) — ` +
    "release-please rewrites both in the same commit, so a mismatch means one was hand-edited.",
);

console.log(`ok: versions (${plugin}, Stream Deck manifest ${manifest})`);
