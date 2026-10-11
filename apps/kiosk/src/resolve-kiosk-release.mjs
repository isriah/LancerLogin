import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { completeOfficialRelease, compareReleaseVersions, releaseAllowed } from "../../../packages/shared/src/release-policy.mjs";
const apiRoot = "https://api.github.com/repos/isriah/LancerLogin";
export async function resolveKioskRelease({ request, installedVersion, fetcher = fetch, now = Date.now() }) {
  async function get(path) {
    const response = await fetcher(`${apiRoot}${path}`, { redirect: "error", headers: { accept: "application/vnd.github+json", "user-agent": "LancerLogin" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("official_release_unavailable"); return response.json();
  }
  let tag; let channel = "stable"; let pinned;
  if (request !== undefined) {
    if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some((key) => !["targetTag", "targetCommit", "channel", "expiresAt"].includes(key))
      || !releaseAllowed(request.targetTag, request.channel, request.targetTag?.includes("-beta.")) || !/^[0-9a-f]{40}$/.test(request.targetCommit ?? "")
      || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= now || Date.parse(request.expiresAt) > now + 15 * 60_000) throw new Error("invalid_update_request");
    tag = request.targetTag; channel = request.channel; pinned = request.targetCommit;
  }
  const release = await get(tag ? `/releases/tags/${tag}` : "/releases/latest");
  const target = completeOfficialRelease(release, channel);
  if (!target || tag && target.tag !== tag || compareReleaseVersions(target.tag, installedVersion) !== 1) throw new Error("newer_official_release_required");
  const commit = await get(`/commits/${target.tag}`);
  if (!/^[0-9a-f]{40}$/.test(commit.sha ?? "") || pinned && commit.sha !== pinned) throw new Error("release_commit_mismatch");
  return { tag: target.tag, version: target.tag.slice(1), sha: commit.sha };
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
  const target = await resolveKioskRelease({ request, installedVersion: version }); process.stdout.write(target.version);
}
if (process.argv[1]?.endsWith("resolve-kiosk-release.mjs")) main().catch(() => { console.error("The kiosk update target could not be verified. No downgrade or unverified install was attempted."); process.exitCode = 1; });
