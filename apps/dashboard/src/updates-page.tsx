import { visiblePoll } from "./visible-poll";
import { useEffect, useRef, useState } from "react";
import { formatVersion, isNewerRelease } from "./update-indicator";
import { useDashboardLoadingOverlay } from "./loading-overlay";
import { createSingleFlight, hasComparableStableVersions } from "./update-release";
import { useReleaseCheck } from "./use-release-check";
import { WebUpdateCard } from "./web-update-card";
import { UpdateChannelCard } from "./update-channel-card";
import { ModuleMigrationNotice } from "./plugin-management";
import { readDashboardReleaseState, type DashboardReleaseState } from "./dashboard-release";
import { CredentialExpiryBanner, UpdateSetupPanel } from "./web-update-setup";
import type { UpdateSetup } from "./web-update";


export function UpdatesPage() {
  const [dashboard, setDashboard] = useState<DashboardReleaseState>({ worker: "", served: "", running: __LANCERLOGIN_VERSION__, workflowUrl: "", converged: false, reloadAvailable: false }); const release = useReleaseCheck(); const latest = release.release; const [notice, setNotice] = useState(""); const [installationError, setInstallationError] = useState(""); const [loading, setLoading] = useState(true);
  const reconciledRelease = useRef("");
  const [migrationRequired, setMigrationRequired] = useState(false);
  const [setup, setSetup] = useState<UpdateSetup>();
  useDashboardLoadingOverlay(loading, "Checking for updates…");
  async function load() {
    try { setDashboard(await readDashboardReleaseState()); setInstallationError(""); }
    catch (error) { setDashboard(current => ({ ...current, worker: "", served: "", workflowUrl: "", converged: false, reloadAvailable: false })); setInstallationError((error as Error).message); }
    finally { setLoading(false); }
  }
  const refresh = useRef<(() => Promise<void>) | null>(null); if (!refresh.current) refresh.current = createSingleFlight(load);
  useEffect(() => { const refreshUpdates = refresh.current!; void refreshUpdates().catch((error: Error) => { setLoading(false); setNotice(error.message); }); return visiblePoll(refreshUpdates, 5_000); }, []);
  useEffect(() => {
    const key = `${dashboard.worker}:${latest?.tag_name ?? ""}`;
    if (!release.fresh || !dashboard.worker || !isNewerRelease(dashboard.worker, latest?.tag_name ?? "") || reconciledRelease.current === key) return;
    reconciledRelease.current = key; void release.check(true).catch(() => undefined);
  }, [dashboard.worker, latest?.tag_name, release.checkedAt, release.fresh]);
  const checkingRelease = release.checking;
  const comparable = release.fresh && hasComparableStableVersions(latest, dashboard.worker);
  const retrying = Boolean(release.retryAt && release.retryAt > Date.now());
  const releaseNotice = checkingRelease ? "Checking for updates…" : !dashboard.converged ? `Deployment verification is incomplete. Worker ${dashboard.worker || "Unknown"}; Pages ${dashboard.served || "Unknown"}.` : dashboard.reloadAvailable ? `Dashboard ${dashboard.worker} is installed. Reload this tab to use it.` : release.error ? `${release.error} Installed information is available. ${retrying ? `Try again after ${new Date(release.retryAt!).toLocaleString()}.` : "Another check is available."}` : !comparable ? "A compatible release on the selected track could not be confirmed. Updates are unavailable until valid information is available." : isNewerRelease(latest?.tag_name ?? "", dashboard.worker) ? setup?.dispatchCredential.state === "missing" ? "A newer release on this update track is available. Dashboard updates are not set up yet, so upgrade by running the \"Install or upgrade LancerLogin\" workflow with operation \"upgrade\"." : "A newer release on this update track is available. Review its notes before upgrading." : isNewerRelease(dashboard.worker, latest?.tag_name ?? "") ? `This installation is newer than the latest confirmed published release ${formatVersion(latest?.tag_name)}.` : "This installation is current.";
  const dashboardUpdateAvailable = !migrationRequired && dashboard.converged && !dashboard.reloadAvailable && !checkingRelease && comparable && isNewerRelease(latest?.tag_name ?? "", dashboard.worker);
  const updateTone = checkingRelease ? "neutral" : !dashboard.converged ? "warning" : comparable ? dashboardUpdateAvailable ? "warning" : "success" : "error";
  return <section className="settings-page settings-updates" aria-labelledby="updates-title"><div className="panel-heading updates-header"><div className="page-intro"><h1 id="updates-title">Updates</h1><p>Compare current and available releases, then back up before updating.</p></div><button className="quiet-button" type="button" aria-describedby="release-check-status" disabled={checkingRelease || retrying} onClick={() => void release.check(true).catch(() => undefined)}>{checkingRelease ? "Checking for updates…" : "Check for updates"}</button></div><p id="release-check-status" className="field-help" role="status">{release.checkedAt ? `Last successful check ${new Date(release.checkedAt).toLocaleString()}.` : "No successful release check yet."}{release.error && release.attemptedAt ? ` Last failed attempt ${new Date(release.attemptedAt).toLocaleString()}.` : ""}{latest && !release.fresh ? " Previously checked release; confirmation is required before updating." : ""}{retrying ? ` Next check after ${new Date(release.retryAt!).toLocaleString()}.` : ""}</p><p className="ui-status settings-notice" data-tone={updateTone} role="status">{installationError || notice || releaseNotice}</p><CredentialExpiryBanner setup={setup} /><ModuleMigrationNotice onRequired={setMigrationRequired} /><section className="release-comparisons" aria-label="Release comparisons"><WebUpdateCard current={dashboard.worker || "Unavailable"} served={dashboard.served} running={dashboard.running} converged={dashboard.converged} reloadAvailable={dashboard.reloadAvailable} available={dashboardUpdateAvailable} workflowUrl={dashboard.workflowUrl} latestTag={latest?.tag_name} releaseUrl={latest?.html_url} releaseNotes={latest?.body} onStatus={(status) => { if (status.setup) setSetup(status.setup); }} /></section><UpdateChannelCard /><UpdateSetupPanel setup={setup} onSetup={setSetup} /></section>;
}
