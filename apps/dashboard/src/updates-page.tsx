import { visiblePoll } from "./visible-poll";
import { useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { formatVersion, isNewerRelease } from "./update-indicator";
import { useDashboardLoadingOverlay } from "./loading-overlay";
import { createSingleFlight, hasComparableStableVersions } from "./update-release";
import { useReleaseCheck } from "./use-release-check";
import { WebUpdateCard } from "./web-update-card";
import { kioskUpdateState, type KioskUpdateCommand as Command } from "./kiosk-update-status";
import { readDashboardReleaseState, type DashboardReleaseState } from "./dashboard-release";

type Kiosk = { id: string; name: string; active: number; lastSeenAt?: string; releaseVersion?: string };

export function UpdatesPage() {
  const [dashboard, setDashboard] = useState<DashboardReleaseState>({ worker: "", served: "", running: __LANCERLOGIN_VERSION__, workflowUrl: "", converged: false, reloadAvailable: false }); const release = useReleaseCheck(); const latest = release.release; const [kiosk, setKiosk] = useState<Kiosk>(); const [commands, setCommands] = useState<Command[]>([]); const [notice, setNotice] = useState(""); const [installationError, setInstallationError] = useState(""); const [loading, setLoading] = useState(true); const [kioskBusy, setKioskBusy] = useState(false);
  const reconciledRelease = useRef("");
  useDashboardLoadingOverlay(loading, "Checking for updates…");
  async function loadCommands(active: Kiosk) {
    const status = await api<{ commands: Command[] }>(`/admin/kiosks/${encodeURIComponent(active.id)}/commands`); setCommands(status.commands.filter((command) => command.type === "install_latest"));
  }
  async function load() {
    let installation: DashboardReleaseState;
    let active: Kiosk | undefined;
    try {
      const [nextInstallation, kiosks] = await Promise.all([readDashboardReleaseState(), api<{ kiosks: Kiosk[] }>("/admin/kiosks")]);
      installation = nextInstallation; active = kiosks.kiosks.find((item) => item.active === 1); setDashboard(installation); setKiosk(active); setInstallationError("");
    } catch (error) {
      setDashboard((current) => ({ ...current, worker: "", served: "", workflowUrl: "", converged: false, reloadAvailable: false })); setInstallationError((error as Error).message); return;
    } finally {
      setLoading(false);
    }
    const commandsRequest = active ? loadCommands(active).catch(() => undefined) : Promise.resolve(setCommands([]));
    await commandsRequest;
  }
  const refresh = useRef<(() => Promise<void>) | null>(null); if (!refresh.current) refresh.current = createSingleFlight(load);
  useEffect(() => { const refreshUpdates = refresh.current!; void refreshUpdates().catch((error: Error) => { setLoading(false); setNotice(error.message); }); return visiblePoll(refreshUpdates, 5_000); }, []);
  useEffect(() => {
    const key = `${dashboard.worker}:${latest?.tag_name ?? ""}`;
    if (!release.fresh || !dashboard.worker || !isNewerRelease(dashboard.worker, latest?.tag_name ?? "") || reconciledRelease.current === key) return;
    reconciledRelease.current = key; void release.check(true).catch(() => undefined);
  }, [dashboard.worker, latest?.tag_name, release.checkedAt, release.fresh]);
  async function updateKiosk() { if (!kiosk || !kioskUpdateAvailable) return; setKioskBusy(true); try { await api(`/admin/kiosks/${encodeURIComponent(kiosk.id)}/commands`, { method: "POST", body: JSON.stringify({ command: "install_latest" }) }); await refresh.current!(); } catch (error) { setNotice((error as Error).message); } finally { setKioskBusy(false); } }
  const kioskOnline = Boolean(kiosk?.lastSeenAt && Date.now() - Date.parse(kiosk.lastSeenAt) < 90_000); const latestCommand = commands[0]; const kioskUpdate = kioskUpdateState(latestCommand, kiosk);
  const checkingRelease = release.checking;
  const comparable = release.fresh && hasComparableStableVersions(latest, dashboard.worker);
  const retrying = Boolean(release.retryAt && release.retryAt > Date.now());
  const releaseNotice = checkingRelease ? "Checking for updates…" : !dashboard.converged ? `Deployment verification is incomplete. Worker ${dashboard.worker || "Unknown"}; Pages ${dashboard.served || "Unknown"}.` : dashboard.reloadAvailable ? `Dashboard ${dashboard.worker} is installed. Reload this tab to use it.` : release.error ? `${release.error} Installed information is available. ${retrying ? `Try again after ${new Date(release.retryAt!).toLocaleString()}.` : "Another check is available."}` : !comparable ? "A compatible stable release could not be confirmed from the installed and latest version information. Updates are unavailable until valid information is available." : isNewerRelease(latest?.tag_name ?? "", dashboard.worker) ? "A newer community release is available. Review its notes before upgrading." : isNewerRelease(dashboard.worker, latest?.tag_name ?? "") ? `This installation is newer than the latest confirmed published release ${formatVersion(latest?.tag_name)}.` : "This installation is current.";
  const kioskUpdateAvailable = release.fresh && !checkingRelease && hasComparableStableVersions(latest, kiosk?.releaseVersion ?? "") && isNewerRelease(latest?.tag_name ?? "", kiosk?.releaseVersion ?? "");
  const dashboardUpdateAvailable = dashboard.converged && !dashboard.reloadAvailable && !checkingRelease && comparable && isNewerRelease(latest?.tag_name ?? "", dashboard.worker);
  const updateTone = checkingRelease ? "neutral" : !dashboard.converged ? "warning" : comparable ? dashboardUpdateAvailable ? "warning" : "success" : "error";
  const kioskTone = kioskUpdate.tone;
  return <section className="settings-page settings-updates" aria-labelledby="updates-title"><div className="panel-heading updates-header"><div className="page-intro"><h1 id="updates-title">Updates</h1><p>Compare current and available releases, then back up before updating.</p></div><button className="quiet-button" type="button" aria-describedby="release-check-status" disabled={checkingRelease || retrying} onClick={() => void release.check(true).catch(() => undefined)}>{checkingRelease ? "Checking for updates…" : "Check for updates"}</button></div><p id="release-check-status" className="field-help" role="status">{release.checkedAt ? `Last successful check ${new Date(release.checkedAt).toLocaleString()}.` : "No successful release check yet."}{release.error && release.attemptedAt ? ` Last failed attempt ${new Date(release.attemptedAt).toLocaleString()}.` : ""}{latest && !release.fresh ? " Previously checked release; confirmation is required before updating." : ""}{retrying ? ` Next check after ${new Date(release.retryAt!).toLocaleString()}.` : ""}</p><p className="ui-status settings-notice" data-tone={updateTone} role="status">{installationError || notice || releaseNotice}</p><section className="release-comparisons" aria-label="Release comparisons"><WebUpdateCard current={dashboard.worker || "Unavailable"} served={dashboard.served} running={dashboard.running} converged={dashboard.converged} reloadAvailable={dashboard.reloadAvailable} available={dashboardUpdateAvailable} workflowUrl={dashboard.workflowUrl} latestTag={latest?.tag_name} releaseUrl={latest?.html_url} releaseNotes={latest?.body} />{kiosk && <article><div className="panel-heading"><div><h2>Physical kiosk</h2><p>{kiosk.name}</p></div><button className="primary-button" type="button" disabled={kioskBusy || !kioskOnline || !kioskUpdateAvailable} onClick={() => void updateKiosk()}>{kioskBusy ? "Queueing…" : "Update to latest stable"}</button></div><div className="version-grid"><div><span>Current</span><strong>{kiosk.releaseVersion ?? "Unknown"}</strong></div><div><span>Available</span><strong>{latest?.tag_name ? formatVersion(latest.tag_name) : "Unavailable"}</strong>{!kioskOnline && <small>The kiosk must be online to update.</small>}</div></div><p className="kiosk-update-status ui-status" data-tone={kioskTone} role="status">{kioskUpdate.message}</p></article>}</section></section>;
}
