// Public update policy. No URL, branch, build metadata or arbitrary prerelease is accepted.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
export function parseReleaseVersion(value) {
  if (typeof value !== "string" || value.length > 80) return;
  const match = versionPattern.exec(value.replace(/^v/, ""));
  if (!match || match[0] !== value.replace(/^v/, "")) return;
  if (!match.slice(1).filter((part) => part !== undefined).every((part) => Number.isSafeInteger(Number(part)))) return;
  return { parts: match.slice(1, 4).map(BigInt), beta: match[4] === undefined ? undefined : BigInt(match[4]) };
}
export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left); const b = parseReleaseVersion(right);
  if (!a || !b) return;
  for (let index = 0; index < 3; index++) if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  if (a.beta === b.beta) return 0;
  if (a.beta === undefined) return 1;
  if (b.beta === undefined) return -1;
  return a.beta > b.beta ? 1 : -1;
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
export function newestOfficialRelease(values, channel = "stable") {
  if (!Array.isArray(values)) return;
  return values.map((value) => completeOfficialRelease(value, channel)).filter(Boolean)
    .sort((a, b) => compareReleaseVersions(b.tag, a.tag))[0];
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
