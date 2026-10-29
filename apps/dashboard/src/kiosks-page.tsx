import { KioskScanReviews } from "./kiosk-scan-reviews";
import { KioskFingerprintMatch } from "./kiosk-fingerprint-match";
import { visiblePoll } from "./visible-poll";
import { RouteLink, usePath } from "./router";
import "./mobile-kiosks.css";
import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { dashboardReleaseVersion } from "./hardware-pairing-key";
import { PairKioskDialog } from "./pair-kiosk-dialog";
import { useDashboardLoadingOverlay } from "./loading-overlay";
import { formatVersion, isNewerRelease } from "./update-indicator";
import { hasComparableStableVersions, kioskUpdateTransition } from "./update-release";
import { useReleaseCheck } from "./use-release-check";
import { diagnosticUrl } from "./web-update";
import { KioskEnrollmentDialog, type EnrollmentSession } from "./kiosk-enrollment-dialog";

type Kiosk = { id: string; name: string; active: number; lastSeenAt?: string; readerOnline?: number; authenticationMethod?: KioskAuthenticationMethod; configuredAuthenticationMethod?: KioskAuthenticationMethod; releaseVersion?: string; uptimeSeconds?: number; networkType?: "wifi" | "ethernet" | "offline"; networkSignal?: number | null; lastWifiScanAt?: string; pendingEvents?: number; lastSyncAt?: string; errorCategory?: string; scansNeedReview?: number | null; clockConfirmed?: number | null; clockPendingScans?: number | null; reviewSyncFailing?: number | null; weakMatches?: number | null; readerTemplates?: number | null; linkedTemplates?: number | null; pairedAt: string };
type Simulator = { name: string; active: number; online: number; lastSeenAt?: string; readerOnline: false; releaseVersion: string };
type KioskCommand = "reload_display" | "restart_service" | "reboot" | "reset_network_pin" | "install_latest" | "erase_unlinked_fingerprints";
type KioskAuthenticationMethod = "fingerprint" | "rfid" | "nfc" | "member_id" | "qr";
type Notice = { message: string; tone: "neutral" | "success" | "error" };
const authenticationMethodLabels: Record<KioskAuthenticationMethod, string> = { fingerprint: "Fingerprint", rfid: "RFID badge", nfc: "NFC badge", member_id: "Member ID entry", qr: "QR code" };

function formatUptime(seconds?: number) {
  if (!Number.isFinite(seconds)) return "—";
  const totalMinutes = Math.floor(Number(seconds) / 60); const days = Math.floor(totalMinutes / 1_440); const hours = Math.floor(totalMinutes % 1_440 / 60); const minutes = totalMinutes % 60;
  return `${days ? `${days}d ` : ""}${hours}h ${minutes}m`;
}

function kioskHealth(kiosk?: Kiosk) {
  const online = Boolean(kiosk?.lastSeenAt && Date.now() - Date.parse(kiosk.lastSeenAt) < 90_000);
  const healthy = Boolean(kiosk && online && kiosk.readerOnline && kiosk.networkType !== "offline" && (kiosk.pendingEvents ?? 0) === 0 && !kiosk.errorCategory);
  const health = !kiosk ? "unpaired" : !online ? "offline" : healthy ? "healthy" : "degraded";
  return { online, health, label: health === "unpaired" ? "Not paired" : health[0].toUpperCase() + health.slice(1) };
}

const scans = (count: number) => `${count} ${count === 1 ? "scan" : "scans"}`;
// Why a kiosk reports an issue. Kiosks before 2.0.0-beta.14 send only the category, so they keep the general advice.
function kioskIssues(kiosk: Kiosk) {
  if (!kiosk.errorCategory) return [];
  const issues: string[] = [], detailed = typeof kiosk.clockConfirmed === "number";
  if (!detailed) return [kiosk.errorCategory === "offline_queue" ? "Saved scans need attention. Open maintenance on this kiosk to check its clock and review rejected scans." : kiosk.errorCategory.replaceAll("_", " ")];
  if (kiosk.reviewSyncFailing) issues.push("Rejected scans could not be sent for review. The kiosk retries every minute.");
  if (kiosk.clockConfirmed === 0) issues.push("Clock not confirmed. Reconnect the kiosk to the network, or open maintenance on the kiosk to confirm the date and time.");
  if (kiosk.clockPendingScans) issues.push(`${scans(kiosk.clockPendingScans)} saved while the clock was unconfirmed.`);
  if (kiosk.scansNeedReview) issues.push(`${scans(kiosk.scansNeedReview)} rejected and not yet reviewed. Review them under Rejected scans; the kiosk clears this within two minutes.`);
  if (kiosk.pendingEvents) issues.push(`${scans(kiosk.pendingEvents)} waiting to upload.`);
  return issues.length ? issues : [kiosk.errorCategory.replaceAll("_", " ")];
}

export function KiosksPage({ role, discordConfigured, walkthroughOpen = false, kioskId }: { role: "admin" | "operator"; discordConfigured: boolean; walkthroughOpen?: boolean; kioskId?: string }) {
  const { path, navigate } = usePath();
  const managing = Boolean(kioskId);
  const [kiosks, setKiosks] = useState<Kiosk[]>([]);
  const [simulator, setSimulator] = useState<Simulator | null>(null);
  const [walkthroughReady, setWalkthroughReady] = useState(false);
  const [notice, setNotice] = useState<Notice>({ message: "Loading kiosk status…", tone: "neutral" });
  useDashboardLoadingOverlay(notice.message === "Loading kiosk status…", "Loading kiosk status…");
  const [pairing, setPairing] = useState(false);
  const [enrolling, setEnrolling] = useState<{ kiosk: Kiosk; session: EnrollmentSession }>();
  const [enrollmentBusy, setEnrollmentBusy] = useState(false);
  async function beginEnrollment(kiosk: Kiosk) {
    setEnrollmentBusy(true);
    try {
      const { session } = await api<{ session: EnrollmentSession }>(`/admin/kiosks/${encodeURIComponent(kiosk.id)}/enrollment`, { method: "POST" });
      setEnrolling({ kiosk, session });
    } catch (error) { setNotice({ message: (error as Error).message, tone: "error" }); }
    finally { setEnrollmentBusy(false); }
  }
  const [editing, setEditing] = useState<string>();
  const [renameBusy, setRenameBusy] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);
  const editButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  useEffect(() => { if (editing) renameInput.current?.focus(); }, [editing]);
  const [maintenanceHelp, setMaintenanceHelp] = useState(false);
  const [discordBusy, setDiscordBusy] = useState(false);
  const [discordMessageUrl, setDiscordMessageUrl] = useState<string>();
  const [name, setName] = useState("");
  const [selectedKioskId, setSelectedKioskId] = useState<string>();
  const [authenticationMethod, setAuthenticationMethod] = useState<KioskAuthenticationMethod>("fingerprint");
  const [authenticationBusy, setAuthenticationBusy] = useState(false);
  const release = useReleaseCheck();
  const latestRelease = formatVersion(release.release?.tag_name);

  async function load({ preserveNotice = false }: { preserveNotice?: boolean } = {}) {
    const [hardware, simulated] = await Promise.all([api<{ kiosks: Kiosk[] }>("/admin/kiosks"), role === "admin" ? api<{ simulator: Simulator | null }>("/admin/simulator") : Promise.resolve({ simulator: null })]);
    setKiosks(hardware.kiosks); setSimulator(simulated.simulator); setWalkthroughReady(true); if (!preserveNotice) setNotice({ message: "", tone: "neutral" });
  }
  useEffect(() => {
    setWalkthroughReady(false);
    return visiblePoll(() => load(), 30_000, (error) => setNotice({ message: error.message, tone: "error" }), true);
  }, [role]);
  const activeKiosks = kiosks.filter((kiosk) => kiosk.active === 1);
  const paired = kioskId ? activeKiosks.find((kiosk) => kiosk.id === kioskId) : activeKiosks.find((kiosk) => kiosk.id === selectedKioskId) ?? activeKiosks[0];
  useEffect(() => {
    if (!activeKiosks.length) setSelectedKioskId(undefined);
    else if (!selectedKioskId || !activeKiosks.some((kiosk) => kiosk.id === selectedKioskId)) setSelectedKioskId(activeKiosks[0]!.id);
  }, [kiosks, selectedKioskId]);
  const example = walkthroughOpen && !paired && !managing;
  const active: Kiosk | undefined = paired ?? (example ? {
    id: "walkthrough-example", name: "Example kiosk", active: 1, readerOnline: 1, authenticationMethod: "fingerprint",
    networkType: "wifi", networkSignal: 90, pendingEvents: 0, uptimeSeconds: 7200,
    pairedAt: "2026-01-01T12:00:00Z", lastSeenAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(), releaseVersion: dashboardReleaseVersion,
  } : undefined);
  const health = kioskHealth(active);
  const issues = active && health.online ? kioskIssues(active) : [];
  // Fingerprints the reader stores that no member is linked to; only kiosks from 2.0.0-beta.14 report the counts.
  const unlinkedTemplates = typeof active?.readerTemplates === "number" && typeof active.linkedTemplates === "number" ? Math.max(0, active.readerTemplates - active.linkedTemplates) : 0;
  const { online } = health;
  const configuredAuthenticationMethod = active?.configuredAuthenticationMethod ?? "fingerprint";
  useEffect(() => { setAuthenticationMethod(configuredAuthenticationMethod); }, [active?.id, configuredAuthenticationMethod]);
  const activeAuthenticationMethod = active?.authenticationMethod ?? "fingerprint";
  const releaseCurrent = Boolean(release.fresh && hasComparableStableVersions(release.release, active?.releaseVersion ?? "") && !isNewerRelease(latestRelease, active!.releaseVersion!));

  function cancelRename() { const id = editing; setEditing(undefined); if (id) editButtons.current[id]?.focus(); }
  async function rename(event: FormEvent) {
    event.preventDefault(); if (!editing || example || renameBusy) return;
    const id = editing; setRenameBusy(true);
    try { await api(`/admin/kiosks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }); cancelRename(); setNotice({ message: "Kiosk renamed.", tone: "success" }); await load({ preserveNotice: true }); }
    catch (error) { setNotice({ message: (error as Error).message, tone: "error" }); }
    finally { setRenameBusy(false); }
  }
  async function retire() { if (!active || example || !window.confirm(`Retire ${active.name}? Its credential will stop working, but its history will remain.`)) return; try { await api(`/admin/kiosks/${encodeURIComponent(active.id)}`, { method: "DELETE", body: JSON.stringify({ confirmation: "RETIRE KIOSK" }) }); setNotice({ message: "Kiosk retired. Other active kiosks continue working.", tone: "success" }); await load({ preserveNotice: true }); } catch (error) { setNotice({ message: (error as Error).message, tone: "error" }); } }
  async function command(type: KioskCommand, label: string, confirmation?: string) { if (!active || example || type === "install_latest" && (!release.fresh || release.checking || !["upgrade", "replace-development"].includes(kioskUpdateTransition(release.release, active.releaseVersion ?? ""))) || confirmation && !window.confirm(confirmation)) return; if (type === "install_latest" && kioskUpdateTransition(release.release, active.releaseVersion ?? "") === "replace-development" && !window.confirm(`Replace development build ${active.releaseVersion} with verified official release ${latestRelease}? Development-only changes may be removed.`)) return; try { await api(`/admin/kiosks/${encodeURIComponent(active.id)}/commands`, { method: "POST", body: JSON.stringify({ command: type, ...(type === "install_latest" && kioskUpdateTransition(release.release, active.releaseVersion ?? "") === "replace-development" ? { replaceDevelopmentBuild: true } : {}) }) }); setNotice({ message: `${label} queued. The kiosk normally receives it within five seconds.`, tone: "success" }); } catch (error) { setNotice({ message: (error as Error).message, tone: "error" }); } }
  const [simulatorBusy, setSimulatorBusy] = useState(false);
  // Starting reuses the Attendance setup route, which an Admin may call after setup to bring a stopped simulator back.
  async function startSimulator(simulatorName: string) { setSimulatorBusy(true); try { await api("/module-setup/attendance/input", { method: "POST", body: JSON.stringify({ action: "start", name: simulatorName }) }); setNotice({ message: "Browser simulator started.", tone: "success" }); await load({ preserveNotice: true }); } catch (error) { setNotice({ message: (error as Error).message, tone: "error" }); } finally { setSimulatorBusy(false); } }
  async function stopSimulator() { try { await api("/admin/simulator", { method: "POST", body: JSON.stringify({ action: "stop" }) }); setNotice({ message: "Browser simulator stopped.", tone: "success" }); await load({ preserveNotice: true }); } catch (error) { setNotice({ message: (error as Error).message, tone: "error" }); } }
  async function saveAuthenticationMethod(event: FormEvent) { event.preventDefault(); if (!active || example || authenticationBusy) return; setAuthenticationBusy(true); try { await api(`/admin/kiosks/${encodeURIComponent(active.id)}/authentication-method`, { method: "PATCH", body: JSON.stringify({ authenticationMethod }) }); setNotice({ message: `${authenticationMethodLabels[authenticationMethod]} selected for ${active.name}. It will use this method after its next sync.`, tone: "success" }); await load({ preserveNotice: true }); } catch (error) { setNotice({ message: (error as Error).message, tone: "error" }); } finally { setAuthenticationBusy(false); } }
  async function syncDiscordStatus() {
    if (example) return;
    setDiscordBusy(true); setNotice({ message: "Syncing physical kiosk health to Discord…", tone: "neutral" });
    try {
      const result = await api<{ changed: boolean; messageUrl?: string }>("/discord/kiosk-status", { method: "POST", body: JSON.stringify({}) });
      setDiscordMessageUrl(result.messageUrl);
      setNotice({ message: result.changed ? "Persistent Discord kiosk status updated." : "Persistent Discord kiosk status is already current.", tone: "success" });
    } catch (error) { setNotice({ message: (error as Error).message, tone: "error" }); }
    finally { setDiscordBusy(false); }
  }

  return <section className="page-stack" aria-labelledby="kiosks-title" data-walkthrough-page="kiosks" data-walkthrough-ready={walkthroughReady ? "true" : undefined} tabIndex={-1}>
    <div className="page-intro">{managing && <RouteLink className="kiosk-back-link" href="/kiosks" currentPath={path} navigate={navigate}>← Kiosks</RouteLink>}<h1 id="kiosks-title">{managing ? "Manage kiosk" : "Kiosks"}</h1>{managing && active && <div className="kiosk-state"><strong>{active.name}</strong><span className="status-pill ui-status" data-tone={health.health === "healthy" ? "success" : health.health === "degraded" ? "warning" : "error"}>{health.label}</span></div>}</div>
    {notice.message && <p className="setup-status ui-status kiosk-notice" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p>}
    <div className="kiosk-grid">
      <article className="task-card kiosk-device-card">
        {!managing && <div className="kiosk-card-heading" data-walkthrough="kiosk-pairing"><div><h2>Physical kiosks</h2>{activeKiosks.length > 0 && <p>{activeKiosks.length} active {activeKiosks.length === 1 ? "device" : "devices"}</p>}</div>{role === "admin" && <button className="primary-button" type="button" onClick={() => setPairing(true)}>Add kiosk</button>}</div>}
        {example && <p className="ui-status" data-tone="neutral">Example kiosk for this walkthrough. No device is paired; these management controls are disabled.</p>}
        {active && !managing && <div className="kiosk-device-switcher" role="group" aria-label="Active physical kiosks">{(example ? [active] : activeKiosks).map((kiosk) => {
          const state = kioskHealth(kiosk);
          return <div className="kiosk-device-option" key={kiosk.id} data-selected={active?.id === kiosk.id ? "true" : undefined}>
            {role === "admin" && <button className="ui-button kiosk-enrollment-button" type="button" disabled={example || enrollmentBusy || !state.online || !kiosk.readerOnline || kiosk.configuredAuthenticationMethod !== "fingerprint" || kiosk.authenticationMethod !== "fingerprint"} onClick={() => void beginEnrollment(kiosk)} aria-label={`Begin enrollment on ${kiosk.name}`}>Begin enrollment</button>}
            <div className="kiosk-device-row" data-walkthrough={active?.id === kiosk.id ? "kiosk-status" : undefined}>
              <button className="ui-button kiosk-device-select" type="button" disabled={example} aria-pressed={active?.id === kiosk.id} onClick={() => { setSelectedKioskId(kiosk.id); setEditing(undefined); setMaintenanceHelp(false); }}><strong>{kiosk.name}</strong><span className="status-pill ui-status" data-tone={state.health === "healthy" ? "success" : state.health === "degraded" ? "warning" : "error"}>{state.label}</span></button>
              {role === "admin" && <button className="ui-button kiosk-edit-button" type="button" aria-label={`Rename ${kiosk.name}`} title={`Rename ${kiosk.name}`} disabled={example || renameBusy} data-walkthrough={active?.id === kiosk.id ? "kiosk-rename" : undefined} ref={element => { editButtons.current[kiosk.id] = element; }} onClick={() => { setSelectedKioskId(kiosk.id); setName(kiosk.name); setEditing(kiosk.id); }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5" /></svg></button>}
            </div>
            {editing === kiosk.id && <form className="kiosk-rename-form ui-form" onSubmit={event => void rename(event)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelRename(); } }}><label htmlFor="kiosk-device-name">Device name</label><input className="ui-control" id="kiosk-device-name" ref={renameInput} required maxLength={80} value={name} disabled={renameBusy} onChange={event => setName(event.target.value)} /><div className="kiosk-rename-actions"><button className="ui-button ui-button--primary" type="submit" disabled={renameBusy}>{renameBusy ? "Saving..." : "Save name"}</button><button className="ui-button" type="button" disabled={renameBusy} onClick={cancelRename}>Cancel</button></div></form>}
          </div>;
        })}</div>}
        {!active && <p data-walkthrough="kiosk-status">{managing ? "This kiosk is unavailable or retired." : "No kiosk paired"}</p>}

        {active ? <>
          <dl className="kiosk-diagnostics kiosk-summary" data-walkthrough="kiosk-diagnostics"><div><dt>Authentication</dt><dd>{authenticationMethodLabels[activeAuthenticationMethod]}{configuredAuthenticationMethod !== activeAuthenticationMethod && <small>{authenticationMethodLabels[configuredAuthenticationMethod]} configured - waiting for kiosk sync</small>}</dd></div><div><dt>{activeAuthenticationMethod === "fingerprint" ? "Fingerprint reader" : "Input service"}</dt><dd>{active.readerOnline ? "Online" : "Offline"}</dd></div><div><dt>Installed release</dt><dd>{active.releaseVersion ?? "Unknown"}</dd></div><div><dt>{release.channel === "stable" ? "Latest stable release" : release.channel === "beta" ? "Latest beta release" : "Latest release"}</dt><dd>{example ? <>{dashboardReleaseVersion}<small>Up to date</small></> : <>{latestRelease || "Unavailable"}{!release.fresh && latestRelease ? <small>Previously checked; confirmation required</small> : release.fresh && kioskUpdateTransition(release.release, active.releaseVersion ?? "") === "replace-development" ? <small>Replace development build with confirmation</small> : release.fresh && hasComparableStableVersions(release.release, active.releaseVersion ?? "") ? <small>{releaseCurrent ? "Up to date" : "Update available"}</small> : null}</>}</dd></div>{issues.length > 0 && <div className="kiosk-diagnostic-error"><dt>Needs attention</dt><dd>{issues.length === 1 ? issues[0] : <ul className="kiosk-issues">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}</dd></div>}</dl>
          {!managing && !example && <RouteLink className="ui-button kiosk-manage-link" href={`/kiosks/${encodeURIComponent(active.id)}/manage`} currentPath={path} navigate={navigate}>Manage kiosk</RouteLink>}
          {(managing || walkthroughOpen) && <details className="kiosk-management-section" open={walkthroughOpen || undefined}><summary>Diagnostics</summary><dl className="kiosk-diagnostics"><div><dt>Network</dt><dd>{active.networkType === "wifi" ? `Wi-Fi${active.networkSignal !== null && active.networkSignal !== undefined ? ` · ${active.networkSignal}% signal` : ""}` : active.networkType === "ethernet" ? "Ethernet" : active.networkType === "offline" ? "Offline" : "Unavailable"}</dd></div><div><dt>Last Wi-Fi scan</dt><dd>{active.lastWifiScanAt ? new Date(active.lastWifiScanAt).toLocaleString() : "Never"}</dd></div><div><dt>Uptime</dt><dd>{formatUptime(active.uptimeSeconds)}</dd></div><div><dt>Pending scans</dt><dd>{active.pendingEvents ?? 0}</dd></div>{typeof active.readerTemplates === "number" && typeof active.linkedTemplates === "number" && <div><dt>Reader fingerprints</dt><dd>{active.readerTemplates} of 200 stored<small>{active.linkedTemplates} linked to members{unlinkedTemplates ? `, ${unlinkedTemplates} unlinked` : ""}</small></dd></div>}{typeof active.weakMatches === "number" && <div><dt>Weak matches asked to rescan</dt><dd>{active.weakMatches}<small>Since the kiosk last started</small></dd></div>}<div><dt>Last successful sync</dt><dd>{active.lastSyncAt ? new Date(active.lastSyncAt).toLocaleString() : "Never"}</dd></div><div><dt>Last heartbeat</dt><dd>{active.lastSeenAt ? new Date(active.lastSeenAt).toLocaleString() : "Never"}</dd></div><div><dt>Paired</dt><dd>{new Date(active.pairedAt).toLocaleString()}</dd></div></dl></details>}
          {role === "admin" && (example || !releaseCurrent) && <div className="kiosk-update-action"><button className="primary-button" type="button" data-walkthrough="kiosk-update" disabled={example || !online || release.checking || !release.fresh || !["upgrade", "replace-development"].includes(kioskUpdateTransition(release.release, active.releaseVersion ?? ""))} onClick={() => void command("install_latest", "Kiosk update")}>Update kiosk</button></div>}
          {role === "admin" && (managing || walkthroughOpen) && <>
            <details className="kiosk-management-section" open={walkthroughOpen || undefined}><summary>Authentication settings</summary>
            <form className="kiosk-authentication-form ui-form" onSubmit={(event) => void saveAuthenticationMethod(event)}><label htmlFor="kiosk-authentication-method">Authentication method for selected kiosk</label><select id="kiosk-authentication-method" className="ui-native-select" value={authenticationMethod} disabled={example || authenticationBusy} onChange={(event) => setAuthenticationMethod(event.target.value as KioskAuthenticationMethod)}><option value="fingerprint">Fingerprint</option><option value="rfid">RFID badge</option><option value="nfc">NFC badge</option><option value="member_id">Member ID entry</option><option value="qr">QR code</option></select><button className="ui-button ui-button--primary" type="submit" disabled={example || authenticationBusy || authenticationMethod === configuredAuthenticationMethod}>{authenticationBusy ? "Saving…" : "Save method"}</button><p>Applies to {active.name}. Badge and QR mappings stay local. Fingerprint recovery is in Settings.</p></form>
              <button type="button" disabled={example} data-walkthrough="kiosk-fingerprints" onClick={() => setMaintenanceHelp((value) => !value)}>Authentication maintenance</button>
            {maintenanceHelp && <div className="settings-callout kiosk-maintenance"><div><strong>Open maintenance on the physical kiosk</strong><p>Press and hold the organization name or logo for three seconds, then enter the local settings PIN. Fingerprints stay inside the sensor unless installation cloud storage is enabled. Cloud storage uses a server-managed encryption key and automatic transfers to paired kiosks. Badge and QR credentials are transformed and mapped only in owner-protected local kiosk storage.</p></div></div>}
            </details>
            <details className="kiosk-management-section" open={walkthroughOpen || undefined}><summary>Device maintenance</summary>
            <div className="kiosk-actions" data-walkthrough="kiosk-actions">

              <button type="button" disabled={example} data-walkthrough="kiosk-reload" onClick={() => void command("reload_display", "Display reload")}>Reload display</button>
              <button type="button" disabled={example} data-walkthrough="kiosk-restart" onClick={() => void command("restart_service", "Software restart")}>Restart software</button>
              <button type="button" disabled={example} data-walkthrough="kiosk-reboot" onClick={() => void command("reboot", "Device reboot", `Reboot ${active.name}? Attendance scanning will pause while the Pi restarts.`)}>Reboot Pi</button>
              {unlinkedTemplates > 0 && <button type="button" disabled={example} onClick={() => void command("erase_unlinked_fingerprints", "Unlinked fingerprint erase", `Erase up to ${unlinkedTemplates} fingerprints stored on ${active.name}'s reader that no member is linked to? These are retired or replaced fingerprints and cannot be recovered. Linked fingerprints are kept, and scanning pauses for a few seconds.`)}>Erase unlinked fingerprints</button>}
              <button type="button" disabled={example} data-walkthrough="kiosk-network-pin" onClick={() => void command("reset_network_pin", "Network PIN reset", `Reset the local settings PIN on ${active.name}? Anyone at the kiosk can then create a new PIN.`)}>Reset network PIN</button>


              {discordConfigured && <button type="button" disabled={example || discordBusy} onClick={() => void syncDiscordStatus()}>{discordBusy ? "Syncing…" : "Sync Discord status"}</button>}
              {discordConfigured && diagnosticUrl(discordMessageUrl) && <a className="secondary-button action-link" href={diagnosticUrl(discordMessageUrl)} target="_blank" rel="noreferrer">View Discord status message</a>}
            </div>
            </details>
            <details className="kiosk-management-section" open={walkthroughOpen || undefined}><summary>Retire kiosk</summary><button className="danger-button" type="button" disabled={example} data-walkthrough="kiosk-retire" onClick={() => void retire()}>Retire kiosk</button></details>
          </>}
        </> : !managing && <p>Pair a Raspberry Pi to begin unattended attendance. Fingerprint is the default, and an Admin can select another authentication method after pairing.</p>}
      </article>
      {role === "admin" && !managing && <article className="task-card kiosk-simulator-card" data-walkthrough="kiosk-simulator"><h2>Browser simulator</h2><div className="kiosk-state"><strong>{simulator?.name ?? "Not configured"}</strong><span className="status-pill ui-status" data-tone={simulator?.active && simulator.online ? "success" : simulator?.active ? "error" : "neutral"}>{simulator?.active ? simulator.online ? "Online" : "Offline" : simulator ? "Stopped" : "Not paired"}</span></div><p>Uses the kiosk scan surface with browser-selected simulated reads. Events are audited and do not count as physical kiosk activity.</p>{simulator && simulator.active !== 1 && <div className="kiosk-actions"><button className="primary-button" type="button" disabled={simulatorBusy} onClick={() => void startSimulator(simulator.name)}>{simulatorBusy ? "Starting…" : "Start simulator"}</button></div>}{!simulator && <RouteLink className="secondary-button action-link" href="/settings/guided-setup" currentPath={path} navigate={navigate}>Set up browser simulator</RouteLink>}{simulator?.active === 1 && <div className="kiosk-actions"><a className="primary-button action-link" href="/simulator">Open simulator</a><button type="button" onClick={() => void stopSimulator()}>Stop simulator</button></div>}</article>}
    </div>
    {role === "admin" && !managing && <KioskScanReviews />}
    {role === "admin" && !managing && <KioskFingerprintMatch />}
    {pairing && <PairKioskDialog onClose={() => setPairing(false)} onPaired={load} />}
    {enrolling && <KioskEnrollmentDialog kiosk={enrolling.kiosk} initial={enrolling.session} onClose={() => setEnrolling(undefined)} />}
  </section>;
}
