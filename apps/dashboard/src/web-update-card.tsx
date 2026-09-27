import { visiblePoll } from "./visible-poll";
import { useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "./dashboard-api";
import { formatVersion } from "./update-indicator";
import { isTerminalWebUpdate, diagnosticUrl, webUpdateError, webUpdateStatus, type WebUpdateRequest, type WebUpdateResponse } from "./web-update";
import { InfoHeading } from "./info-tip";

export function WebUpdateCard({ current, served, running, converged, reloadAvailable, available, workflowUrl, latestTag, releaseUrl, releaseNotes }: { current: string; served: string; running: string; converged: boolean; reloadAvailable: boolean; available: boolean; workflowUrl: string; latestTag?: string; releaseUrl?: string; releaseNotes?: string }) {
  const [status, setStatus] = useState<WebUpdateResponse>();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false); const [downloaded, setDownloaded] = useState("");
  const flight = useRef(false); const mutation = useRef(false); const alive = useRef(true);
  const revision = useRef(0);
  const confirmation = useRef<HTMLInputElement>(null);
  const splitStatus = Boolean(status && ("activeRequest" in status || "latestCompletedRequest" in status));
  const legacyRequest = status?.request ?? undefined;
  const request: WebUpdateRequest | undefined = splitStatus ? status?.activeRequest ?? undefined : legacyRequest && !isTerminalWebUpdate(legacyRequest) ? legacyRequest : undefined;
  const previousRequest: WebUpdateRequest | undefined = splitStatus ? status?.latestCompletedRequest ?? undefined : legacyRequest && isTerminalWebUpdate(legacyRequest) ? legacyRequest : undefined;
  async function read(path: string, body?: object): Promise<WebUpdateResponse> {
    const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", cache: "no-store", ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const result = await response.json() as WebUpdateResponse & { code?: string; error?: string };
    if (!response.ok) throw new Error(webUpdateError(result.code, result.error ?? "Unable to read web update status."));
    return result;
  }
  async function refresh() {
    if (flight.current || mutation.current) return;
    flight.current = true;
    const observed = revision.current;
    try { const result = await read("/admin/web-updates/status"); if (alive.current && !mutation.current && revision.current === observed) { setStatus(result); setError(""); } }
    catch (cause) { if (alive.current && revision.current === observed) setError(`${(cause as Error).message} Progress is unconfirmed; do not start another update until status is available.`); }
    finally { flight.current = false; }
  }
  useEffect(() => { alive.current = true; void refresh(); const stop = visiblePoll(refresh, 10_000); return () => { alive.current = false; stop(); }; }, []);
  useEffect(() => { setSaved(false); setDownloaded(""); }, [request?.requestId]);
  useEffect(() => { if (downloaded && !busy && request?.state === "prepared" && request.requestId === downloaded) confirmation.current?.focus(); }, [downloaded, busy, request?.requestId, request?.state]);
  async function mutate(operation: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true; revision.current += 1; setBusy(true); setError("");
    try { await operation(); } catch (cause) { if (alive.current) setError((cause as Error).message); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  }
  async function prepare() {
    await mutate(async () => { const result = await read("/admin/web-updates/prepare", {}); if (alive.current) { setStatus(result); setSaved(false); setDownloaded(""); } });
  }
  async function backup() {
    if (!request || request.state !== "prepared" || Date.parse(request.expiresAt) <= Date.now()) return;
    const id = request.requestId;
    await mutate(async () => {
      setSaved(false);
      const response = await fetch(`${apiBaseUrl}/admin/data/backup?scope=installation&updateRequestId=${encodeURIComponent(id)}`, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("The required pre-update backup could not be created. Download it again before starting.");
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      try { const link = document.createElement("a"); link.href = url; link.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "lancerlogin-installation-backup.json"; document.body.append(link); link.click(); link.remove(); }
      finally { window.setTimeout(() => URL.revokeObjectURL(url), 1_000); }
      const result = await read("/admin/web-updates/status");
      const active = result.activeRequest ?? result.request;
      if (alive.current) { setStatus(result); if (active?.requestId === id && active.backupExported) setDownloaded(id); }
    });
  }
  async function start() {
    if (!request || request.state !== "prepared" || Date.parse(request.expiresAt) <= Date.now() || !saved || !(request.backupExported || downloaded === request.requestId)) return;
    const id = request.requestId;
    await mutate(async () => {
      try { const result = await read("/admin/web-updates/start", { requestId: id, backupSaved: true }); if (alive.current) { setStatus(result); setSaved(false); } }
      catch (cause) { setSaved(false); throw new Error(`${(cause as Error).message} Refresh status before continuing; an accepted request must never be blindly redispatched.`); }
    });
  }
  const prepared = request?.state === "prepared";
  const expired = prepared && Date.parse(request.expiresAt) <= Date.now();
  const repeatable = !request;
  const exported = Boolean(prepared && request.backupExported);
  const diagnostics = diagnosticUrl(request?.runUrl) ?? diagnosticUrl(previousRequest?.runUrl) ?? diagnosticUrl(status?.workflowUrl || workflowUrl);
  const notesUrl = diagnosticUrl(releaseUrl);
  const notesTag = request?.targetTag ?? latestTag;
  const notes = request ? request.releaseNotes : releaseNotes;
  const tone = error || request?.state === "recovery_required" ? "error" : reloadAvailable ? "success" : request ? "warning" : "neutral";
  return <article className="web-update-card" aria-labelledby="dashboard-update-title">
    <div className="panel-heading"><InfoHeading id="dashboard-update-title" info="Cloudflare dashboard installation">Dashboard</InfoHeading>
      {(repeatable || expired) && !reloadAvailable && <button className="primary-button" type="button" disabled={busy || !status || Boolean(error) || !available || !workflowUrl || !converged} onClick={() => void prepare()}>{busy ? "Preparing update…" : "Back up and begin update"}</button>}
    </div>
    <div className="version-grid"><div><span>Installed</span><strong>{current}</strong><small>Pages serves {served || "Unknown"}. This tab runs {running || "Unknown"}.</small></div><div><span>Available</span><strong>{latestTag ? formatVersion(latestTag) : "Unavailable"}</strong>{notesUrl && <a href={notesUrl} target="_blank" rel="noreferrer">Read release notes</a>}</div></div>
    <p className="ui-status web-update-status" data-tone={tone} role="status">{error || (request ? webUpdateStatus(expired ? { ...request, state: "expired" } : request) : reloadAvailable ? `Dashboard ${current} is installed. Reload this tab to use it.` : !converged ? "The Worker and Pages releases do not match yet. Wait for deployment verification before updating." : `Dashboard ${current} is installed.`)}</p>
    {request?.state === "awaiting_approval" && diagnostics && <a className="web-update-approval" href={diagnostics} target="_blank" rel="noreferrer">Review approval in GitHub</a>}
    {prepared && !expired && <div className="web-update-backup">
      <p id="web-backup-help" className="field-help">Prepared until {new Date(request.expiresAt).toLocaleString()}. Keep the backup file securely outside this installation. Refreshing never confirms that you saved it.</p>
      <button className={exported ? "quiet-button" : "primary-button"} type="button" disabled={busy} onClick={() => void backup()}>{busy ? "Working…" : exported ? "Download backup again" : "Download entire-installation backup"}</button>
      {exported && <><label className="web-update-confirmation"><input ref={confirmation} type="checkbox" checked={saved} disabled={busy} aria-describedby="web-backup-help" onChange={(event) => setSaved(event.target.checked)} />I saved this update’s entire-installation backup file securely.</label><button className="primary-button" type="button" disabled={busy || !saved || Boolean(error)} onClick={() => void start()}>{busy ? "Starting update…" : `Start update to ${request.targetTag}`}</button></>}
    </div>}
    {reloadAvailable && <button className="primary-button" type="button" onClick={() => window.location.reload()}>Reload updated dashboard</button>}
    <button className="quiet-button" type="button" disabled={busy} onClick={() => void refresh()}>Refresh update status</button>
    {notesTag && <section className="web-update-notes" aria-label="Update release notes"><h3>Release notes for {notesTag}</h3><p>{notes || (notesUrl ? "Read the release notes using the link above." : "No release notes supplied.")}</p></section>}
    <details className="web-update-diagnostics"><summary>Diagnostics and manual recovery</summary>{previousRequest && <section aria-label="Previous update"><h3>Previous update to {previousRequest.targetTag}</h3><p className="field-help">{webUpdateStatus(previousRequest)}</p><p>{previousRequest.releaseNotes}</p></section>}{request && <p className="field-help">Stage: {request.stage.replaceAll("_", " ")}. Request: {request.requestId}. Last updated {new Date(request.updatedAt).toLocaleString()}.</p>}{diagnostics && <a href={diagnostics} target="_blank" rel="noreferrer">Open diagnostic workflow / manual recovery</a>}</details>
    {!request && !previousRequest && <ol className="update-steps"><li>Review the available release and prepare your update.</li><li>Download the entire-installation backup and confirm the file was saved.</li><li>Start once here. Track GitHub approval, deployment and health verification.</li><li>Reload only after the installation is verified.</li></ol>}
  </article>;
}
