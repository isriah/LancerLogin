import { compareReleaseVersions, parseReleaseVersion } from "../packages/shared/src/release-policy.mjs";
export function releasePublicationPolicy(tag) {
  const version = parseReleaseVersion(tag);
  if (!version || !tag.startsWith("v")) throw new Error("canonical_release_tag_required");
  const prerelease = version.beta !== undefined;
  return { branch: prerelease ? "modular" : "main", prerelease, latest: !prerelease };
}
export function assertLatestPromotion(tag, currentLatest) {
  if (!releasePublicationPolicy(tag).latest) return;
  const current = parseReleaseVersion(currentLatest);
  if (!current || current.beta !== undefined || !currentLatest.startsWith("v") || compareReleaseVersions(tag, currentLatest) !== 1) throw new Error("latest_must_advance");
}
if (process.argv[1]?.endsWith("release-channel.mjs")) {
  try { if (process.argv[3]) assertLatestPromotion(process.argv[2], process.argv[3]); for (const [key, value] of Object.entries(releasePublicationPolicy(process.argv[2]))) console.log(`${key}=${value}`); }
  catch { console.error("A canonical stable or beta.N release tag is required."); process.exitCode = 1; }
}
