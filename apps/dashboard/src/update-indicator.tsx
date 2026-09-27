import { useEffect, useState } from "react";
import { releaseCache, hasComparableStableVersions, isNewerRelease, createSingleFlight } from "./update-release";
import { useReleaseCheck } from "./use-release-check";
import { visiblePoll } from "./visible-poll";
import { readDashboardReleaseState } from "./dashboard-release";

type Check = { current: string; served: string; running: string; latest: string; available: boolean; reloadAvailable: boolean };
const cacheKey = "lancerlogin-update-check";

export { isNewerRelease } from "./update-release";
export const formatVersion = (value?: string) => value ? value.replace(/^v/, "") : "";

export const checkForUpdate = createSingleFlight(async (): Promise<Check> => {
  const state = await readDashboardReleaseState();
  let release;
  try { release = await releaseCache.check(); } catch { release = releaseCache.snapshot().release; }
  const latest = formatVersion(release?.tag_name); const current = formatVersion(state.worker);
  return { current, served: state.served, running: state.running, latest,
    available: state.converged && hasComparableStableVersions(release, current) && isNewerRelease(latest, current),
    reloadAvailable: state.reloadAvailable };
});

function useUpdateCheck() {
  const [check, setCheck] = useState<Check>();
  const release = useReleaseCheck();
  useEffect(() => {
    let active = true;
    async function refresh() {
      try { const next = await checkForUpdate(); if (active) setCheck(next); }
      catch { if (active) setCheck(undefined); }
    }
    const stop = visiblePoll(refresh, 30_000, undefined, true);
    return () => { active = false; stop(); };
  }, [release.checkedAt, release.fresh, release.release?.tag_name]);
  if (check?.reloadAvailable) return check;
  return release.fresh && check?.latest === formatVersion(release.release?.tag_name) && check.available ? check : undefined;
}

export function UpdateIndicator({ openUpdates }: { openUpdates: () => void }) {
  const check = useUpdateCheck();
  if (!check) return null;
  const version = check.reloadAvailable ? check.served : check.latest;
  return <button className="update-indicator" type="button" onClick={openUpdates} aria-label={check.reloadAvailable ? `LancerLogin ${version} is installed. Open Updates to reload.` : `LancerLogin ${version} is available. Open Updates.`}><span aria-hidden="true">↑</span> {check.reloadAvailable ? "Reload update" : "Update available"} <strong>{version}</strong></button>;
}

export function UpdateAvailablePopup({ openUpdates, suppressed = false }: { openUpdates: () => void; suppressed?: boolean }) {
  const check = useUpdateCheck();
  const [dismissedVersion, setDismissedVersion] = useState<string>();
  const noticeKey = check?.reloadAvailable ? `reload-${check.served}` : `update-${check?.latest}`;
  if (!check || dismissedVersion === noticeKey || readDismissed(noticeKey) || suppressed) return null;
  function dismiss() { try { localStorage.setItem(`lancerlogin-update-dismissed:${noticeKey}`, "true"); } catch { /* Dismiss in memory. */ } setDismissedVersion(noticeKey); }
  return <aside className="ui-card ui-status update-available-popup" role="status" aria-label={check.reloadAvailable ? "Dashboard reload available" : "Update available"}><div>{check.reloadAvailable
    ? <><strong>LancerLogin {check.served} is installed</strong><span>This tab is still running {check.running}. Reload to use the updated dashboard.</span></>
    : <><strong>LancerLogin {check.latest} is ready</strong><span>This installation is running {check.current}. Review and install the available update.</span></>}</div><button className="primary-button" type="button" onClick={check.reloadAvailable ? () => window.location.reload() : openUpdates}>{check.reloadAvailable ? "Reload dashboard" : "Open Updates"}</button><button className="popup-dismiss" type="button" aria-label="Dismiss update notice" onClick={dismiss}>×</button></aside>;
}

export function clearUpdateCheckCache() { try { localStorage.removeItem(cacheKey); } catch { /* Legacy cache only. */ } }
function readDismissed(version: string) { try { return localStorage.getItem(`lancerlogin-update-dismissed:${version}`) === "true"; } catch { return false; } }
