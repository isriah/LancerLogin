import { useEffect, useState } from "react";
import { api } from "./dashboard-api";

type Check = { current: string; latest: string; available: boolean };
const cacheKey = "lancerlogin-update-check";
const latestReleaseUrl = "https://api.github.com/repos/isriah/LancerLogin/releases/latest";

export function isNewerRelease(candidate: string, installed: string) {
  const parse = (value: string) => value.replace(/^v/, "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const next = parse(candidate); const current = parse(installed);
  if (next.some(Number.isNaN) || current.some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index += 1) {
    if ((next[index] ?? 0) !== (current[index] ?? 0)) return (next[index] ?? 0) > (current[index] ?? 0);
  }
  return false;
}
export const formatVersion = (value?: string) => value ? value.replace(/^v/, "") : "";

async function checkForUpdate(): Promise<Check> {
  const cached = localStorage.getItem(cacheKey);
  if (cached) { try { const value = JSON.parse(cached) as Check & { checkedAt: number }; if (Date.now() - value.checkedAt < 6 * 60 * 60_000) return value; } catch { localStorage.removeItem(cacheKey); } }
  const [installation, releaseResponse] = await Promise.all([api<{ releaseVersion: string }>("/admin/update-info"), fetch(latestReleaseUrl, { headers: { accept: "application/vnd.github+json" } })]);
  if (!releaseResponse.ok) throw new Error("Release check unavailable"); const release = await releaseResponse.json() as { tag_name?: string }; const latest = formatVersion(release.tag_name); const current = formatVersion(installation.releaseVersion); const result = { current, latest, available: Boolean(latest && isNewerRelease(latest, current)) }; localStorage.setItem(cacheKey, JSON.stringify({ ...result, checkedAt: Date.now() })); return result;
}

export function UpdateIndicator({ openUpdates }: { openUpdates: () => void }) {
  const [check, setCheck] = useState<Check>();
  useEffect(() => { void checkForUpdate().then(setCheck).catch(() => undefined); }, []);
  if (!check?.available) return null;
  return <button className="update-indicator" type="button" onClick={openUpdates} aria-label={`LancerLogin ${check.latest} is available. Open Updates.`}><span aria-hidden="true">↑</span> Update available <strong>{check.latest}</strong></button>;
}

export function clearUpdateCheckCache() { localStorage.removeItem(cacheKey); }
