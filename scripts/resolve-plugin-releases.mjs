#!/usr/bin/env node
// Re-pin plugin selection entries to the highest release on one track.
//
//   npm run plugins:resolve -- --selection <file> [--track stable|beta|nightly] [--module <id>] [--dry-run]
//
// <file> is an installation's lancerlogin.modules.json, Core's scripts/official-modules.json or a test selection. Each
// selected entry (every entry, or only --module) must use an https://github.com/<owner>/<repository>.git source. The
// helper lists that repository's GitHub releases with the maintainer's existing GitHub CLI login, chooses the highest
// published, immutable release the track offers (Stable: stable; Beta: beta and stable; Nightly: nightly, beta and
// stable), resolves its tag to the full commit SHA and writes that SHA into the entry. Tags are resolved here and never
// stored: composition still accepts only exact commits. Nightly releases are for test installations only. Without
// --track, each entry uses its own release track: "track": "nightly" in the entry, or stable when it has none.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newestPluginRelease, pluginReleaseKind, pluginReleaseTracks, pluginSelectionTracks } from "../packages/shared/src/release-policy.mjs";

const commitPattern = /^[0-9a-f]{40}$/;

/** owner/repository for a GitHub https source, or undefined for any other source. */
export function githubRepository(source) {
  let url;
  try { url = new URL(source); } catch { return; }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.host !== "github.com" || url.username || url.password || url.search || url.hash || !match) return;
  return `${match[1]}/${match[2]}`;
}

function gh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000, env: { ...process.env, GH_HOST: "github.com", GH_DEBUG: "" }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`GitHub CLI request failed (${args.at(-1)}): ${String(error.stderr ?? error.message).trim().split("\n").at(-1)}`);
  }
}

/** Every release of a repository, including prereleases, via the GitHub CLI. */
export function listGitHubReleases(repository, run = gh) {
  const releases = [];
  for (let page = 1; page <= 20; page++) {
    const batch = JSON.parse(run(["api", "-H", "Accept: application/vnd.github+json", `repos/${repository}/releases?per_page=100&page=${page}`]));
    if (!Array.isArray(batch)) throw new Error(`Unexpected release list for ${repository}`);
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error(`${repository} has too many releases to list`);
}

/** The full commit SHA a tag points to (annotated tags are dereferenced). */
export function resolveGitHubTag(repository, tag, run = gh) {
  const sha = JSON.parse(run(["api", "-H", "Accept: application/vnd.github+json", `repos/${repository}/commits/${encodeURIComponent(tag)}`])).sha;
  if (typeof sha !== "string" || !commitPattern.test(sha)) throw new Error(`${repository} tag ${tag} does not resolve to a commit`);
  return sha;
}

/**
 * Rewrite selection entries in place. Returns one result per resolved entry. Throws, writing nothing, when a selected
 * entry cannot be resolved, so a selection is never partly updated.
 */
export function resolveSelection(selection, { track, moduleId, listReleases = listGitHubReleases, resolveTag = resolveGitHubTag }) {
  if (track !== undefined && !pluginReleaseTracks.includes(track)) throw new Error(`--track must be one of ${pluginReleaseTracks.join(", ")}`);
  if (!selection || typeof selection !== "object" || !Array.isArray(selection.modules)) throw new Error("The selection has no modules list");
  const entries = selection.modules.filter((entry) => moduleId === undefined || entry?.id === moduleId);
  if (!entries.length) throw new Error(moduleId ? `The selection has no module ${moduleId}` : "The selection has no modules");
  // The entry's own track, as the dashboard stores it; composition ignores it.
  for (const entry of selection.modules) if (entry?.track !== undefined && !pluginSelectionTracks.includes(entry.track)) throw new Error(`Module ${entry?.id} track ${JSON.stringify(entry.track)} is not supported; use "stable" or "nightly", or leave it out for stable`);
  const planned = entries.map((entry) => {
    const entryTrack = track ?? entry.track ?? "stable";
    const repository = githubRepository(entry?.source);
    if (!repository) throw new Error(`Module ${entry?.id} source ${entry?.source} is not an https://github.com/<owner>/<repository>.git source; its releases cannot be resolved`);
    const release = newestPluginRelease(listReleases(repository), entryTrack);
    if (!release) throw new Error(`${repository} has no published, immutable release on the ${entryTrack} track`);
    const commit = resolveTag(repository, release.tag_name);
    return { entry, id: entry.id, repository, track: entryTrack, tag: release.tag_name, kind: pluginReleaseKind(release.tag_name), previous: entry.commit, commit };
  });
  for (const plan of planned) plan.entry.commit = plan.commit;
  return planned.map(({ entry: _entry, ...result }) => result);
}

function parseArguments(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => { const next = argv[++index]; if (!next || next.startsWith("--")) throw new Error(`${argument} needs a value`); return next; };
    if (argument === "--selection") options.selection = value();
    else if (argument === "--track") options.track = value();
    else if (argument === "--module") options.moduleId = value();
    else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.selection) throw new Error("Usage: npm run plugins:resolve -- --selection <file> [--track stable|beta|nightly] [--module <id>] [--dry-run]");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const path = resolve(options.selection);
    const selection = JSON.parse(readFileSync(path, "utf8"));
    const results = resolveSelection(selection, options);
    for (const result of results) {
      const change = result.previous === result.commit ? "unchanged" : `was ${result.previous ?? "unpinned"}`;
      console.log(`${result.id}: ${result.repository} ${result.tag} (${result.kind}) -> ${result.commit} (${change})`);
      if (result.kind === "nightly") console.log(`  ${result.tag} is a nightly testing build. Use it only on test installations.`);
      if (commitPattern.test(result.previous ?? "") && result.previous !== result.commit) console.log("  Review the change between the two commits before deploying it.");
    }
    if (!options.dryRun) writeFileSync(path, `${JSON.stringify(selection, null, 2)}\n`);
    console.log(options.dryRun ? "Dry run: the selection file was not changed." : `Updated ${options.selection}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
