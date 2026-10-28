// Read source files of an official plugin at the commit Core pins in scripts/official-modules.json, for source checks of
// modules that moved out of Core. The pin is reached as scripts/test-plugin-sources.mjs describes: an explicit
// LANCERLOGIN_<NAME>_PLUGIN_SOURCE/COMMIT override, the https repository with LANCERLOGIN_PLUGIN_TOKEN when it is set, a local
// development checkout containing the pinned commit, or otherwise the https repository fetched anonymously (the official
// plugins are public). When the pin cannot be read, `officialPluginSource` returns undefined and callers skip with
// `officialPluginUnavailable`, which states the precise reason. Set LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN=1
// to fail instead.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { officialModuleList, pluginTokenVariable, resolveTestPin, unreachablePinAdvice } from "../../scripts/test-plugin-sources.mjs";
import { isolatedGitEnv } from "../../scripts/git-env.mjs";

const official = officialModuleList();
const reasons = new Map();

export function officialPluginPin(moduleId) {
  return official.modules.find((module) => module.id === moduleId);
}

export const officialPluginUnavailable = (moduleId) => reasons.get(moduleId) ?? `The official ${moduleId} plugin pinned in scripts/official-modules.json is not available`;

// Fetch exactly one commit of an https repository. Without LANCERLOGIN_PLUGIN_TOKEN the fetch is anonymous, which is enough
// for public repositories; with it, the token travels only as a transient, host-scoped header, never in a URL or log.
export function fetchCommit(source, commit, environment = process.env) {
  const directory = mkdtempSync(join(tmpdir(), "lancerlogin-official-source-"));
  process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
  const token = environment[pluginTokenVariable];
  const env = isolatedGitEnv(environment, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
  delete env[pluginTokenVariable];
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${new URL(source).origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` });
  const redact = (text) => token ? text.replaceAll(token, "[redacted]").replaceAll(Buffer.from(`x-access-token:${token}`).toString("base64"), "[redacted]") : text;
  for (const args of [["init", "--quiet", "--template=", directory], ["-C", directory, "fetch", "--quiet", "--depth=1", "--no-tags", source, commit]]) {
    const result = spawnSync("git", args, { env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Unable to fetch ${source} at ${commit}: ${redact(String(result.stderr)).trim()}`);
  }
  return directory;
}

/** Read files of the pinned plugin commit, keyed by plugin-relative path, or undefined when the repository is unavailable. */
export function officialPluginSource(moduleId, paths) {
  const pin = officialPluginPin(moduleId);
  const resolved = pin ? resolveTestPin(pin) : { reason: `scripts/official-modules.json does not pin ${moduleId}` };
  if (resolved.reason) {
    reasons.set(moduleId, resolved.reason);
    if (process.env.LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN === "1") throw new Error(resolved.reason);
    return undefined;
  }
  const { source, commit } = resolved.pin;
  let directory;
  try { directory = source.startsWith("file:") ? fileURLToPath(source) : fetchCommit(source, commit); }
  catch (error) {
    const reason = `${error instanceof Error ? error.message : String(error)}. ${unreachablePinAdvice(resolved.pin)}`;
    reasons.set(moduleId, reason);
    if (process.env.LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN === "1") throw new Error(reason);
    return undefined;
  }
  return Object.fromEntries(paths.map((path) => {
    const result = spawnSync("git", ["-C", directory, "show", `${commit}:${path}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: isolatedGitEnv() });
    if (result.status !== 0) throw new Error(`Unable to read ${path} at ${commit}: ${result.stderr}`);
    return [path, result.stdout];
  }));
}
