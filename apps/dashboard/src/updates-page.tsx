import { useEffect, useRef, useState } from "react";
import { connectUpdateControl,controlRequest,hasUpdateControl } from './update-control';
import { api } from "./dashboard-api";
import { updaterPolling, formatVersion, isNewerRelease, type UpdaterStatus } from "./update-indicator";
import { createUpdatePolling } from "./update-polling";
import { useDashboardLoadingOverlay } from "./loading-overlay";
import { fetchLatestRelease, type Release } from "./update-release";
import { kioskUpdateState, type KioskUpdateCommand as Command } from "./kiosk-update-status";
import { rememberRecoveryLink, savedRecoveryLink } from './recovery-link';

type Kiosk = { id: string; name: string; active: number; lastSeenAt?: string; releaseVersion?: string };
type Admission = { requestId: string; releaseId: number };
const recoveryKey = "lancerlogin-updater-recovery-v1";
const pendingKey = "lancerlogin-updater-admission-v1";
function savedAdmission(): Admission | null { try { const value = JSON.parse(localStorage.getItem(pendingKey) ?? "null") as Admission | null; return value && typeof value.requestId === "string" && Number.isSafeInteger(value.releaseId) ? value : null; } catch { return null; } }
export function UpdatesPage() {
  const [status, setStatus] = useState<UpdaterStatus>(); const [latest, setLatest] = useState<Release>(); const [kiosk, setKiosk] = useState<Kiosk>(); const [commands, setCommands] = useState<Command[]>([]);
  const [recoveryUrl, setRecoveryUrl] = useState(savedRecoveryLink);
  const [notice, setNotice] = useState(""); const [kioskNotice, setKioskNotice] = useState(""); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [kioskBusy, setKioskBusy] = useState(false); const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState<Admission | null>(savedAdmission); const pendingRef = useRef(pending); const recoveryRequest = useRef<{ jobId: string; mode: string; requestId: string } | null>(null);
  useDashboardLoadingOverlay(loading, "Checking installed update informationÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦");
  function show(next: UpdaterStatus) { setStatus(next); const id = pendingRef.current?.requestId; if (id && (next.job?.requestId === id || (next.admission?.requestId === id && ["accepted", "rejected"].includes(next.admission.state)))) { if (next.admission?.state === "rejected") setNotice("The saved update request was rejected. Check available releases before choosing again."); pendingRef.current = null; setPending(null); localStorage.removeItem(pendingKey); } if (next.job?.requestId === recoveryRequest.current?.requestId) { recoveryRequest.current = null; localStorage.removeItem(recoveryKey); } }
  const kioskPending = useRef(false);
  async function loadKiosk() {
    try {
      const active = (await api<{ kiosks: Kiosk[] }>("/admin/kiosks")).kiosks.find(item => item.active === 1); setKiosk(active);
      kioskPending.current = false;
      if (active) {
        const result = await api<{ commands: Command[] }>(`/admin/kiosks/${encodeURIComponent(active.id)}/commands`); const updates = result.commands.filter(command => command.type === "install_latest"); setCommands(updates); kioskPending.current = kioskUpdateState(updates[0], active).tone === 'warning';
        try { setLatest(await fetchLatestRelease()); setKioskNotice(""); } catch { setLatest(undefined); setKioskNotice("The kiosk release feed is temporarily unavailable. Installed kiosk information is still available."); }
      }
    } catch (error) { setKioskNotice("Kiosk information is temporarily unavailable."); throw error; }
  }
  const kioskPolling = useRef<ReturnType<typeof createUpdatePolling<void>> | null>(null);
  if (!kioskPolling.current) kioskPolling.current = createUpdatePolling({ read: loadKiosk, cadence: () => kioskPending.current ? 10_000 : 60_000 });
  const refresh = useRef<(() => Promise<void>) | null>(null);
  if (!refresh.current) refresh.current = async () => { await Promise.allSettled([updaterPolling.refresh(), kioskPolling.current!.refresh()]); };
  useEffect(() => {
    const cloud = updaterPolling.subscribe(next => { const link = rememberRecoveryLink(next.recoveryUrl); if (link) setRecoveryUrl(link); show(next); setLoading(false); }, error => { setNotice((error as Error).message); setLoading(false); });
    const physical = kioskPolling.current!.subscribe(() => {});
    const visibility = () => kioskPolling.current!.visibilityChanged(); document.addEventListener('visibilitychange', visibility);
    if (document.visibilityState === 'visible') void updaterPolling.join().catch(() => {});
    return () => { cloud(); physical(); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  async function action(name: string, body: unknown) { setBusy(true); setNotice(""); try { await updaterPolling.action(() => hasUpdateControl()&&['advance','retry-preparation'].includes(name)?controlRequest(name,body):api<UpdaterStatus>(`/admin/updater/${name}`, { method: "POST", body: JSON.stringify(body) })); } catch (error) { setNotice((error as Error).message + " Refresh status before repeating the action."); } finally { setBusy(false); } }
  async function begin() {
    const releaseId = status?.availability.releaseId; if (!pendingRef.current && !releaseId) return;
    const body = pendingRef.current ?? { requestId: crypto.randomUUID(), releaseId: releaseId! };
    pendingRef.current = body; setPending(body); localStorage.setItem(pendingKey, JSON.stringify(body));
    if(status?.controlUrl&&!hasUpdateControl(body)){setBusy(true);try{await connectUpdateControl(status.controlUrl,body);}catch(error){setNotice((error as Error).message);return;}finally{setBusy(false);}}
    await action("start", body);
  }
  async function recover(mode: string) {
    if (!status?.job) return;
    if (!recoveryRequest.current) { try { recoveryRequest.current = JSON.parse(localStorage.getItem(recoveryKey) ?? "null"); } catch { /* Ignore malformed local cache. */ } }
    if (recoveryRequest.current?.jobId !== status.job.id || recoveryRequest.current.mode !== mode) recoveryRequest.current = { jobId: status.job.id, mode, requestId: crypto.randomUUID() };
    localStorage.setItem(recoveryKey, JSON.stringify(recoveryRequest.current));
    await action("recovery", { requestId: recoveryRequest.current.requestId, failedJobId: status.job.id, mode, confirmation: mode === "restore" ? confirmation : "RECOVER APPLICATION CODE" });
  }
  async function updateKiosk() { if (!kiosk) return; setKioskBusy(true); try { await api(`/admin/kiosks/${encodeURIComponent(kiosk.id)}/commands`, { method: "POST", body: JSON.stringify({ command: "install_latest" }) }); await refresh.current!(); } catch (error) { setKioskNotice((error as Error).message); } finally { setKioskBusy(false); } }
  const job = status?.job, finishing = Boolean(job && ["succeeded", "recovered"].includes(job.status) && status?.maintenance && status.maintenance.state !== "open"), active = job && (finishing || !["succeeded", "recovered"].includes(job.status)), availability = status?.availability;
  const online = Boolean(kiosk?.lastSeenAt && Date.now() - Date.parse(kiosk.lastSeenAt) < 90000), kioskUpdate = kioskUpdateState(commands[0], kiosk);
  const updateTone = availability?.status === "failed" ? "error" : availability?.status === "available" ? "success" : "neutral"; const kioskTone = kioskUpdate.tone;
  const availabilityMessage = !status?.configured ? "The independent updater is not configured for this installation." : availability?.status === "checking" ? `Checking signed releases: ${availability.checked} of ${availability.total}.` : availability?.status === "available" ? "A verified compatible release is ready to install." : availability?.status === "failed" ? "Release checking failed. Check again to restart the search." : availability?.status === "no-compatible-release" ? "No newer compatible signed release was found." : "Signed release availability has not been checked.";
  return <section className="settings-page settings-updates" aria-labelledby="updates-title">
    <div className="page-intro"><h1 id="updates-title">Updates</h1><p>Install verified application releases and follow durable update progress.</p></div>
    {status?.expiresAt && <p className="ui-status settings-notice" role="status">Independent controls expire at {new Date(status.expiresAt*1000).toLocaleTimeString()}. Keep the controller available; use independent recovery after expiry.</p>}
    {notice && <p className="ui-status settings-notice" data-tone="warning" role="status">{notice}</p>}
    <section className="release-comparisons" aria-label="Release comparisons"><article>
      <div className="panel-heading"><div><h2>Application</h2><p>Dashboard and API</p></div><button className="quiet-button" type="button" disabled={busy || loading} onClick={() => void refresh.current!()}>Refresh status</button></div>
      <div className="version-grid"><div><span>Installed</span><strong>{formatVersion(status?.installedVersion) || "Unavailable"}</strong></div><div><span>Verified available</span><strong>{availability?.version ?? "Unavailable"}</strong></div></div>
      <p className="ui-status settings-notice" data-tone={updateTone} role="status">{availabilityMessage}</p>
      {recoveryUrl && <div className="settings-notice"><p>During maintenance, use the independent updater to continue progress. Its separate recovery sign-in remains available when this application is paused.</p><a className="quiet-button updater-recovery-link" href={recoveryUrl} target="_blank" rel="noopener noreferrer">Open independent updater</a></div>}
      {status?.configured && !active && <div className="panel-heading"><button className="quiet-button" type="button" disabled={busy} onClick={() => void action("check", {})}>{availability?.status === "checking" ? "Continue release check" : "Check for updates"}</button><button className="primary-button" type="button" disabled={busy || (!pending && availability?.status !== "available")} onClick={() => void begin()}>{busy ? "SubmittingÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦" : pending ? "Retry same update request" : "Install verified release"}</button></div>}
      {pending && !active && <p className="ui-status settings-notice" data-tone="warning" role="status">The update request is awaiting confirmation. Refresh status or retry the same saved request; its release selection is frozen.</p>}
      {job && <section aria-labelledby="update-job-title"><h3 id="update-job-title">Update progress</h3><p className="ui-status settings-notice" data-tone={finishing ? "warning" : job.status === "failed" ? "error" : ["succeeded", "recovered"].includes(job.status) ? "success" : "neutral"} role="status">{finishing ? "Finishing verification before reopening the application." : job.status === "succeeded" ? "Update installed successfully." : job.status === "recovered" ? "Recovery completed." : `${job.status}: ${job.step}.`} {job.completedSteps} of {job.totalSteps} steps complete.</p>{job.failure && <p>Failure: {job.failure}</p>}
        {(finishing || ["running", "reconciling"].includes(job.status)) && <button className="primary-button" type="button" disabled={busy} onClick={() => void action("advance", { jobId: job.id })}>{finishing ? "Finish reopening" : job.operationId ? "Reconcile current operation" : "Continue update"}</button>}
        {job.retryPreparationOperationId && <button className="primary-button" type="button" disabled={busy} onClick={() => void action("retry-preparation", { jobId: job.id, failedOperationId: job.retryPreparationOperationId })}>Retry failed preparation</button>}
        {status?.recoveryAvailable && <section className="settings-form" aria-labelledby="update-recovery-title"><h4 id="update-recovery-title">Recover this update</h4><p>Recovery uses the retained release and verified backup. Database restoration replaces application data with that backup.</p><div className="dialog-actions"><button className="quiet-button" type="button" disabled={busy} onClick={() => void recover("code-recovery")}>Recover previous code</button></div><label htmlFor="restore-confirmation">Type RESTORE APPLICATION DATABASE to enable restoration</label><input id="restore-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" /><div className="dialog-actions"><button className="quiet-button danger-button" type="button" disabled={busy || confirmation !== "RESTORE APPLICATION DATABASE"} onClick={() => void recover("restore")}>Restore verified backup</button></div></section>}
      </section>}
    </article>{kiosk && <article><div className="panel-heading"><div><h2>Physical kiosk</h2><p>{kiosk.name}</p></div><button className="primary-button" type="button" disabled={kioskBusy || !online || !latest || !isNewerRelease(latest.tag_name ?? "", kiosk.releaseVersion ?? "0.0.0")} onClick={() => void updateKiosk()}>{kioskBusy ? "QueueingÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦" : "Update to latest stable"}</button></div><div className="version-grid"><div><span>Installed</span><strong>{kiosk.releaseVersion ?? "Unknown"}</strong></div><div><span>Latest compatible</span><strong>{latest?.tag_name ? formatVersion(latest.tag_name) : "Unavailable"}</strong>{latest?.html_url && <a href={latest.html_url} target="_blank" rel="noreferrer">Read kiosk release notes</a>}{!online && <small>The kiosk must be online to update.</small>}</div></div><p className="kiosk-update-status ui-status" data-tone={kioskTone} role="status">{kioskUpdate.message}</p>{kioskNotice && <p role="status">{kioskNotice}</p>}</article>}</section>
  </section>;
}
