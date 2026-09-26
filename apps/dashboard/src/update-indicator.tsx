import { useEffect, useState } from "react";
import { api } from "./dashboard-api";
import { releaseCache, hasComparableStableVersions } from "./update-release";
import { useReleaseCheck } from "./use-release-check";

type Check = { current: string; latest: string; available: boolean };
const cacheKey = "lancerlogin-update-check";

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

export async function checkForUpdate(): Promise<Check> {
  const [installation, release] = await Promise.all([api<{ releaseVersion: string }>("/admin/update-info"), releaseCache.check()]);
  const latest = formatVersion(release.tag_name); const current = formatVersion(installation.releaseVersion);
  return { current, latest, available: hasComparableStableVersions(release, current) && isNewerRelease(latest, current) };
}

export function UpdateIndicator({ openUpdates }: { openUpdates: () => void }) {
  const [check, setCheck] = useState<Check>();
  const release = useReleaseCheck();
  useEffect(() => { let active = true; void checkForUpdate().then((next) => { if (active) setCheck(next); }).catch(() => undefined); return () => { active = false; }; }, [release.checkedAt, release.fresh, release.release?.tag_name]);
  if (!release.fresh || check?.latest !== formatVersion(release.release?.tag_name) || !check?.available) return null;
  return <button className="update-indicator" type="button" onClick={openUpdates} aria-label={`LancerLogin ${check.latest} is available. Open Updates.`}><span aria-hidden="true">↑</span> Update available <strong>{check.latest}</strong></button>;
}

export function UpdateAvailablePopup({ openUpdates, suppressed = false }: { openUpdates: () => void; suppressed?: boolean }) {
  const [check, setCheck] = useState<Check>();
  const release = useReleaseCheck();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { let active = true; void checkForUpdate().then((next) => { if (active) { setCheck(next); setDismissed(readDismissed(next.latest)); } }).catch(() => undefined); return () => { active = false; }; }, [release.checkedAt, release.fresh, release.release?.tag_name]);
  if (!release.fresh || check?.latest !== formatVersion(release.release?.tag_name) || !check?.available || dismissed || suppressed) return null;
  const available = check;
  function dismiss() { try { localStorage.setItem(`lancerlogin-update-dismissed:${available.latest}`, "true"); } catch { /* Dismiss in memory. */ } setDismissed(true); }
  return <aside className="ui-card ui-status update-available-popup" role="status" aria-label="Update available"><div><strong>LancerLogin {check.latest} is ready</strong><span>This dashboard is running {check.current}. Review and install the available update.</span></div><button className="primary-button" type="button" onClick={openUpdates}>Open Updates</button><button className="popup-dismiss" type="button" aria-label="Dismiss update notice" onClick={dismiss}>×</button></aside>;
}

export function clearUpdateCheckCache() { try { localStorage.removeItem(cacheKey); } catch { /* Legacy cache only. */ } }
function readDismissed(version: string) { try { return localStorage.getItem(`lancerlogin-update-dismissed:${version}`) === "true"; } catch { return false; } }
