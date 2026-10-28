// Public update policy. No URL, branch, build metadata or arbitrary prerelease is accepted.
// Core releases are stable X.Y.Z or beta X.Y.Z-beta.N. Module plugin repositories also publish testing-only nightly
// prereleases X.Y.Z-nightly.YYYYMMDD; those parse only when a caller opts in with { nightly: true }, so every Core
// release, update and kiosk path keeps refusing them. Within one X.Y.Z, nightly < beta < stable.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*)|-nightly\.(\d{8}))?$/;
const validNightlyDate = (value) => {
  const [year, month, day] = [Number(value.slice(0, 4)), Number(value.slice(4, 6)), Number(value.slice(6, 8))];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
export function parseReleaseVersion(value, { nightly = false } = {}) {
  if (typeof value !== "string" || value.length > 80) return;
  const match = versionPattern.exec(value.replace(/^v/, ""));
  if (!match || match[0] !== value.replace(/^v/, "")) return;
  if (match[5] !== undefined && (nightly !== true || !validNightlyDate(match[5]))) return;
  if (!match.slice(1, 5).filter((part) => part !== undefined).every((part) => Number.isSafeInteger(Number(part)))) return;
  const version = { parts: match.slice(1, 4).map(BigInt), beta: match[4] === undefined ? undefined : BigInt(match[4]) };
  return match[5] === undefined ? version : { ...version, nightly: BigInt(match[5]) };
}
// Rank within one X.Y.Z: nightly (by date), then beta (by N), then stable.
const rank = (version) => version.nightly !== undefined ? [0n, version.nightly] : version.beta !== undefined ? [1n, version.beta] : [2n, 0n];
export function compareReleaseVersions(left, right, options = {}) {
  const a = parseReleaseVersion(left, options); const b = parseReleaseVersion(right, options);
  if (!a || !b) return;
  for (let index = 0; index < 3; index++) if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  const [x, y] = [rank(a), rank(b)];
  for (let index = 0; index < 2; index++) if (x[index] !== y[index]) return x[index] > y[index] ? 1 : -1;
  return 0;
}
export function releaseAllowed(tag, channel = "stable", prerelease = false) {
  const version = parseReleaseVersion(tag);
  return Boolean(typeof tag === "string" && tag.startsWith("v") && version && ["stable", "beta"].includes(channel)
    && (version.beta === undefined ? prerelease === false : channel === "beta" && prerelease === true));
}
export function completeOfficialRelease(value, channel = "stable") {
  if (!value || typeof value !== "object" || value.draft !== false || !releaseAllowed(value.tag_name, channel, value.prerelease) || value.prerelease === true && value.immutable !== true || !Array.isArray(value.assets)) return;
  const version = value.tag_name.slice(1); const names = new Set(value.assets.map((asset) => asset?.name));
  const required = ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => {
    const archive = `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`; return [archive, `${archive}.sha256`];
  })];
  if (!required.every((name) => names.has(name))) return;
  return { tag: value.tag_name, notes: typeof value.body === "string" ? value.body.slice(0, 32_000) : "", prerelease: value.prerelease };
}
// GitHub records a SHA-256 digest for each uploaded release asset. On an immutable release those assets cannot be
// replaced, so the API digest binds the kiosk installer and archives without trusting a checksum file from the same
// release. Returns the lowercase hex digest, or undefined when the asset is missing, duplicated or has no digest.
export function officialAssetDigest(value, name) {
  if (!value || typeof value !== "object" || !Array.isArray(value.assets)) return;
  const matches = value.assets.filter((asset) => asset?.name === name);
  const digest = matches.length === 1 && typeof matches[0].digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(matches[0].digest) : undefined;
  return digest?.[1];
}
// Physical kiosks install release assets as root, so every track (stable too) requires an immutable release and
// GitHub asset digests for the installer and both archives.
export function completeKioskRelease(value, channel = "stable") {
  const target = completeOfficialRelease(value, channel);
  if (!target || value.immutable !== true) return;
  const version = target.tag.slice(1);
  const digests = {
    installer: officialAssetDigest(value, "install-lancerlogin.sh"),
    arm64: officialAssetDigest(value, `lancerlogin-kiosk-${version}-linux-arm64.tar.gz`),
    armv7: officialAssetDigest(value, `lancerlogin-kiosk-${version}-linux-armv7.tar.gz`),
  };
  if (!digests.installer || !digests.arm64 || !digests.armv7) return;
  return { ...target, digests };
}
export function newestOfficialRelease(values, channel = "stable") {
  if (!Array.isArray(values)) return;
  return values.map((value) => completeOfficialRelease(value, channel)).filter(Boolean)
    .sort((a, b) => compareReleaseVersions(b.tag, a.tag))[0];
}

// Module plugin release tracks. Stable offers stable releases; Beta offers beta and stable; Nightly (test installations
// only) also offers nightly prereleases. The highest version on the track wins, never the most recent publication.
// Plugin releases have no assets, but must be published, immutable and flagged consistently with their tag.
export const pluginReleaseTracks = Object.freeze(["stable", "beta", "nightly"]);
export function pluginReleaseKind(tag) {
  const version = typeof tag === "string" && tag.startsWith("v") ? parseReleaseVersion(tag, { nightly: true }) : undefined;
  if (!version) return;
  return version.nightly !== undefined ? "nightly" : version.beta !== undefined ? "beta" : "stable";
}
export function pluginTrackOffers(track, tag, prerelease) {
  const kind = pluginReleaseKind(tag);
  if (!kind || !pluginReleaseTracks.includes(track) || prerelease !== (kind !== "stable")) return false;
  return kind === "stable" || kind === "beta" && track !== "stable" || kind === "nightly" && track === "nightly";
}
// The release track an installation records for one plugin in lancerlogin.modules.json ("track"; absent means stable).
// Dashboard Upgrade offers the newest release on that track. Composition ignores it and builds the pinned commit.
export const pluginSelectionTracks = Object.freeze(["stable", "nightly"]);
export function newestPluginRelease(values, track = "stable") {
  if (!Array.isArray(values)) return;
  return values.filter((value) => value && typeof value === "object" && value.draft === false && value.immutable === true && pluginTrackOffers(track, value.tag_name, value.prerelease))
    .sort((a, b) => compareReleaseVersions(b.tag_name, a.tag_name, { nightly: true }))[0];
}

// Development identities are installed-state metadata only, never release targets.
export function kioskReleaseTransition(candidate, installed) {
  const target = parseReleaseVersion(candidate);
  if (!target) return "unavailable";
  if (parseReleaseVersion(installed)) return compareReleaseVersions(candidate, installed) === 1 ? "upgrade" : "current";
  if (typeof installed !== "string" || installed.length > 128) return "unavailable";
  const development = /^(\d+\.\d+\.\d+)-dev\.[a-z0-9]+(?:-[a-z0-9]+)*\.[a-f0-9]{7,40}$/.exec(installed);
  const base = development && parseReleaseVersion(development[1]);
  if (!base) return "unavailable";
  for (let i = 0; i < 3; i++) {
    if (target.parts[i] < base.parts[i]) return "unavailable";
    if (target.parts[i] > base.parts[i]) return "replace-development";
  }
  return "replace-development";
}
