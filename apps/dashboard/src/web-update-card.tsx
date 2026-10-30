import { visiblePoll } from "./visible-poll";
import { useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "./dashboard-api";
import { formatVersion } from "./update-indicator";
import { canReloadPluginChanges, isTerminalWebUpdate, diagnosticUrl, webUpdateError, webUpdateErrorLinks, webUpdateStatus, type UpdateSetup, type WebUpdateRequest, type WebUpdateResponse } from "./web-update";
import { credentialExpiryNotice, DashboardUpdatesNotSetUp, FixLinks } from "./web-update-setup";

const loadedAt = Date.now();
import { InfoHeading } from "./info-tip";

/**
 * The durable back up, confirm, start and progress flow. mode "release" is Settings > Updates and handles release updates
 * only; mode "modules" is Apply changes on Settings > Modules and handles module-changes requests only. Each card leaves
 * the other's request to it and only points there, since one active request blocks preparing another.
 */
export function WebUpdateCard({ current, served, running, converged, reloadAvailable, available, workflowUrl, latestTag, releaseUrl, releaseNotes, mode = "release", onStatus }: { current: string; served: string; running: string; converged: boolean; reloadAvailable: boolean; available: boolean; workflowUrl: string; latestTag?: string; releaseUrl?: string; releaseNotes?: string; mode?: "release" | "modules"; onStatus?: (status: WebUpdateResponse) => void }) {
  const [status, setStatus] = useState<WebUpdateResponse>();
  const [error, setError] = useState(""); const [errorCode, setErrorCode] = useState(""); const [busy, setBusy] = useState(false);
  // Prepare and start responses carry no setup readiness; keep the last one status reported.
  const [setup, setSetup] = useState<UpdateSetup>();
  const [saved, setSaved] = useState(false); const [downloaded, setDownloaded] = useState("");
  const flight = useRef(false); const mutation = useRef(false); const alive = useRef(true);
  const revision = useRef(0);
  const confirmation = useRef<HTMLInputElement>(null);
  const splitStatus = Boolean(status && ("activeRequest" in status || "latestCompletedRequest" in status));
  const legacyRequest = status?.request ?? undefined;
  const activeRequest: WebUpdateRequest | undefined = splitStatus ? status?.activeRequest ?? undefined : legacyRequest && !isTerminalWebUpdate(legacyRequest) ? legacyRequest : undefined;
  const completedRequest: WebUpdateRequest | undefined = splitStatus ? status?.latestCompletedRequest ?? undefined : legacyRequest && isTerminalWebUpdate(legacyRequest) ? legacyRequest : undefined;
  const own = (value?: WebUpdateRequest) => Boolean(value) && (value!.mode === "modules") === (mode === "modules");
  const request = own(activeRequest) ? activeRequest : undefined;
  const previousRequest = own(completedRequest) ? completedRequest : undefined;
  // The other card's request: shown only as a pointer to where it is followed.
  const foreign = activeRequest && !request ? activeRequest : undefined;
  async function read(path: string, body?: object): Promise<WebUpdateResponse> {
    const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", cache: "no-store", ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const result = await response.json() as WebUpdateResponse & { code?: string; error?: string };
    if (!response.ok) throw Object.assign(new Error(webUpdateError(result.code, result.error ?? "Unable to read web update status.")), { code: result.code ?? "" });
    if (result.setup) setSetup(result.setup);
    return result;
  }
  function fail(cause: unknown, message = (cause as Error).message) { setError(message); setErrorCode((cause as { code?: string }).code ?? ""); }
  async function refresh() {
    if (flight.current || mutation.current) return;
    flight.current = true;
    const observed = revision.current;
    try { const result = await read("/admin/web-updates/status"); if (alive.current && !mutation.current && revision.current === observed) { setStatus(result); setError(""); setErrorCode(""); onStatus?.(result); } }
    catch (cause) { if (alive.current && revision.current === observed) fail(cause, `${(cause as Error).message} Progress is unconfirmed; do not start another update until status is available.`); }
    finally { flight.current = false; }
  }
  useEffect(() => { alive.current = true; void refresh(); const stop = visiblePoll(refresh, 10_000); return () => { alive.current = false; stop(); }; }, []);
  useEffect(() => { setSaved(false); setDownloaded(""); }, [request?.requestId]);
  useEffect(() => { if (downloaded && !busy && request?.state === "prepared" && request.requestId === downloaded) confirmation.current?.focus(); }, [downloaded, busy, request?.requestId, request?.state]);
  async function mutate(operation: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true; revision.current += 1; setBusy(true); setError(""); setErrorCode("");
    try { await operation(); } catch (cause) { if (alive.current) fail(cause); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  }
  async function prepare() {
    await mutate(async () => { const result = await read("/admin/web-updates/prepare", mode === "modules" ? { mode } : {}); if (alive.current) { setStatus(result); setSaved(false); setDownloaded(""); onStatus?.(result); } });
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
      if (alive.current) { setStatus(result); onStatus?.(result); if (active?.requestId === id && active.backupExported) setDownloaded(id); }
    });
  }
  async function start() {
    if (!request || request.state !== "prepared" || Date.parse(request.expiresAt) <= Date.now() || !saved || !(request.backupExported || downloaded === request.requestId)) return;
    const id = request.requestId;
    await mutate(async () => {
      try { const result = await read("/admin/web-updates/start", { requestId: id, backupSaved: true }); if (alive.current) { setStatus(result); setSaved(false); onStatus?.(result); } }
      catch (cause) { setSaved(false); throw Object.assign(new Error(`${(cause as Error).message} Refresh status before continuing; an accepted request must never be blindly redispatched.`), { code: (cause as { code?: string }).code }); }
    });
  }
  const prepared = request?.state === "prepared";
  const expired = prepared && Date.parse(request.expiresAt) <= Date.now();
  const repeatable = !request && !foreign;
  const exported = Boolean(prepared && request.backupExported);
  const diagnostics = diagnosticUrl(request?.runUrl) ?? diagnosticUrl(previousRequest?.runUrl) ?? diagnosticUrl(status?.workflowUrl || workflowUrl);
  const notesUrl = diagnosticUrl(releaseUrl);
  const notesTag = request?.targetTag ?? latestTag;
  const notes = request ? request.releaseNotes : releaseNotes;
  const pluginReload = canReloadPluginChanges(previousRequest, loadedAt);
  const reloadReady = reloadAvailable || pluginReload;
  const modules = mode === "modules";
  const requestModules = request?.mode === "modules";
  const tone = error || request?.state === "recovery_required" ? "error" : reloadReady ? "success" : request ? "warning" : "neutral";
  const idle = pluginReload ? "Module changes are installed. Reload this tab to use them." : reloadAvailable ? `Dashboard ${current} is installed. Reload this tab to use it.` : !converged ? "The Worker and Pages releases do not match yet. Wait for deployment verification before updating." : modules ? (available ? "Module changes are committed but not deployed. Apply changes backs up this installation and deploys them." : "No module changes are waiting to be applied.") : `Dashboard ${current} is installed.`;
  const foreignText = foreign ? modules ? "A release update is in progress. Follow it in Settings > Updates; module changes can be applied after it finishes." : "Module changes are being applied from Settings > Modules. Follow them there; release updates are available after they finish." : "";
  const titleId = modules ? "module-apply-title" : "dashboard-update-title";
  // Without the optional dispatch credential nothing is broken: updates run from the deployment repository instead.
  const notSetUp = setup?.dispatchCredential.state === "missing";
  const fixes = webUpdateErrorLinks(errorCode || (error ? "" : request?.errorCode), setup?.repository);
  const expiryNotice = credentialExpiryNotice(setup?.dispatchCredential);
  return <article className="web-update-card" aria-labelledby={titleId}>
    <div className="panel-heading">{modules ? <h3 id={titleId}>Apply changes</h3> : <InfoHeading id={titleId} info="Cloudflare dashboard installation">Dashboard</InfoHeading>}
      {(repeatable || expired) && !reloadReady && <button className="primary-button" type="button" disabled={busy || !status || Boolean(error) || !available || !workflowUrl || !converged || notSetUp} onClick={() => void prepare()}>{busy ? "Preparing update…" : modules ? "Apply changes" : "Back up and begin update"}</button>}
    </div>
    {modules ? <p className="field-help">Redeploys the installed release, {current}, with the committed module changes. It uses the same backup, approval, maintenance and verification steps as an update.</p>
      : <div className="version-grid"><div><span>Installed</span><strong>{current}</strong><small>Pages serves {served || "Unknown"}. This tab runs {running || "Unknown"}.</small></div><div><span>Available</span><strong>{latestTag ? formatVersion(latestTag) : "Unavailable"}</strong>{notesUrl && <a href={notesUrl} target="_blank" rel="noreferrer">Read release notes</a>}</div></div>}
    <p className="ui-status web-update-status" data-tone={tone} role="status">{error || (request ? webUpdateStatus(expired ? { ...request, state: "expired" } : request) : foreignText || idle)}</p>
    {foreign && <a className="web-update-elsewhere" href={modules ? "/settings/updates" : "/settings/modules"}>{modules ? "Open Settings > Updates" : "Open Settings > Modules"}</a>}
    {modules && previousRequest && !request && <p className="field-help web-update-last-result">Last apply: {webUpdateStatus(previousRequest)}</p>}
    <FixLinks label="Fix this update problem" links={fixes} />
    {notSetUp && !request && !reloadReady && <DashboardUpdatesNotSetUp repository={setup!.repository} />}
    {expiryNotice && <p className="field-help web-update-credential-notice">{expiryNotice}</p>}
    {request?.state === "awaiting_approval" && diagnostics && <a className="web-update-approval" href={diagnostics} target="_blank" rel="noreferrer">Review approval in GitHub</a>}
    {prepared && !expired && <div className="web-update-backup">
      <p id="web-backup-help" className="field-help">Prepared until {new Date(request.expiresAt).toLocaleString()}. Keep the backup file securely outside this installation. Refreshing never confirms that you saved it.</p>
      <button className={exported ? "quiet-button" : "primary-button"} type="button" disabled={busy} onClick={() => void backup()}>{busy ? "Working…" : exported ? "Download backup again" : "Download entire-installation backup"}</button>
      {exported && <><label className="web-update-confirmation"><input ref={confirmation} type="checkbox" checked={saved} disabled={busy} aria-describedby="web-backup-help" onChange={(event) => setSaved(event.target.checked)} />I saved this update’s entire-installation backup file securely.</label><button className="primary-button" type="button" disabled={busy || !saved || Boolean(error)} onClick={() => void start()}>{busy ? "Starting update…" : requestModules ? "Start applying changes" : `Start update to ${request.targetTag}`}</button></>}
    </div>}
    {reloadReady && <button className="primary-button" type="button" onClick={() => window.location.reload()}>Reload updated dashboard</button>}
    <button className="quiet-button" type="button" disabled={busy} onClick={() => void refresh()}>Refresh update status</button>
    {notesTag && !modules && !requestModules && <section className="web-update-notes" aria-label="Update release notes"><h3>Release notes for {notesTag}</h3><p>{notes || (notesUrl ? "Read the release notes using the link above." : "No release notes supplied.")}</p></section>}
    <details className="web-update-diagnostics"><summary>Diagnostics and manual recovery</summary>{previousRequest && <section aria-label="Previous update"><h3>{previousRequest.mode === "modules" ? `Previous module changes for ${previousRequest.targetTag}` : `Previous update to ${previousRequest.targetTag}`}</h3><p className="field-help">{webUpdateStatus(previousRequest)}</p><p>{previousRequest.releaseNotes}</p></section>}{request && <p className="field-help">Stage: {request.stage.replaceAll("_", " ")}. Request: {request.requestId}. Last updated {new Date(request.updatedAt).toLocaleString()}.</p>}{diagnostics && <a href={diagnostics} target="_blank" rel="noreferrer">Open diagnostic workflow / manual recovery</a>}</details>
    {!request && !previousRequest && !modules && <details className="settings-disclosure"><summary>Update steps</summary><ol className="update-steps"><li>Review the available release and prepare your update.</li><li>Download the entire-installation backup and confirm the file was saved.</li><li>Start once here. Track GitHub approval, deployment and health verification.</li><li>Reload only after the installation is verified.</li></ol></details>}
  </article>;
}
