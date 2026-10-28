import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { completeKioskRelease, kioskReleaseTransition, releaseAllowed } from "../../../packages/shared/src/release-policy.mjs";
const apiRoot = "https://api.github.com/repos/isriah/LancerLogin";
const commandIdPattern = /^[A-Za-z0-9_-]{8,128}$/;
export async function resolveKioskRelease({ request, installedVersion, fetcher = fetch, now = Date.now() }) {
  async function get(path) {
    const response = await fetcher(`${apiRoot}${path}`, { redirect: "error", headers: { accept: "application/vnd.github+json", "user-agent": "LancerLogin" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("official_release_unavailable"); return response.json();
  }
  let tag; let channel = "stable"; let pinned;
  if (request !== undefined) {
    // expiresAt is set from the kiosk's own clock when the command is received, so this check compares one clock.
    if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some((key) => !["targetTag", "targetCommit", "channel", "expiresAt", "commandId"].includes(key))
      || !releaseAllowed(request.targetTag, request.channel, request.targetTag?.includes("-beta.")) || !/^[0-9a-f]{40}$/.test(request.targetCommit ?? "")
      || !commandIdPattern.test(request.commandId ?? "")
      || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= now || Date.parse(request.expiresAt) > now + 15 * 60_000) throw new Error("invalid_update_request");
    tag = request.targetTag; channel = request.channel; pinned = request.targetCommit;
  }
  const release = await get(tag ? `/releases/tags/${tag}` : "/releases/latest");
  // Every track requires an immutable release with GitHub asset digests; a same-release .sha256 file is not trusted.
  const target = completeKioskRelease(release, channel);
  const transition = target && kioskReleaseTransition(target.tag, installedVersion);
  if (!target || tag && target.tag !== tag || !(transition === "upgrade" || transition === "replace-development" && request !== undefined)) throw new Error("newer_official_release_required");
  const commit = await get(`/commits/${target.tag}`);
  if (!/^[0-9a-f]{40}$/.test(commit.sha ?? "") || pinned && commit.sha !== pinned) throw new Error("release_commit_mismatch");
  return { tag: target.tag, version: target.tag.slice(1), sha: commit.sha, digests: target.digests };
}

// Root-owned single-use ledger for dashboard update command ids. The kiosk service account cannot write it, so a
// request file cannot be replayed to start a second install with the same command, whatever the clocks say.
export async function consumeUpdateCommand(path, commandId, now = Date.now()) {
  if (!commandIdPattern.test(commandId ?? "")) throw new Error("invalid_update_request");
  let entries = [];
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry.id !== "string")) throw new Error("update_ledger_invalid");
    entries = parsed;
  } catch (error) { if (error.code !== "ENOENT") throw new Error("update_ledger_invalid"); }
  if (entries.some((entry) => entry.id === commandId)) throw new Error("update_request_replayed");
  const next = [...entries, { id: commandId, consumedAt: new Date(now).toISOString() }].slice(-500);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export function resolvedHelperLine(target) {
  const { installer, arm64, armv7 } = target.digests;
  return `${target.version} ${installer} ${arm64} ${armv7}`;
}

async function main() {
  const path = "/var/lib/lancerlogin/update-request.json"; let request;
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if ((await file.stat()).size > 2_048) throw new Error("invalid_update_request");
    request = JSON.parse(await file.readFile("utf8"));
  } catch (error) { if (error.code !== "ENOENT") throw new Error("invalid_update_request"); }
  finally { await file?.close(); }
  const configuration = await readFile("/etc/systemd/system/lancerlogin-kiosk.service.d/10-version.conf", "utf8");
  const version = /^Environment=LANCERLOGIN_VERSION=(\S+)$/m.exec(configuration)?.[1];
  const target = await resolveKioskRelease({ request, installedVersion: version });
  if (request !== undefined) await consumeUpdateCommand("/var/lib/lancerlogin-update/consumed-commands.json", request.commandId);
  // Output: version, installer digest, arm64 archive digest, armv7 archive digest. Parsed and revalidated by the helper.
  process.stdout.write(resolvedHelperLine(target));
}
if (process.argv[1]?.endsWith("resolve-kiosk-release.mjs")) main().catch(() => { console.error("The kiosk update target could not be verified. No downgrade, replayed or unverified install was attempted."); process.exitCode = 1; });
