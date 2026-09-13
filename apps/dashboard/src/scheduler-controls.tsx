import { useEffect, useId, useRef, useState } from "react";
import { api } from "./dashboard-api";

type Job = { next: number; last: number | null; outcome: "waiting" | "running" | "ok" | "failed" | "paused" };
type Snapshot = { enabled: boolean; jobs: Record<string, Job> };
const labels: Record<string, string> = {
  "attendance.google-calendar": "Google Calendar updates",
  "attendance.discord-calendar": "Discord calendar updates",
  "attendance.discord-channel": "Discord channel management",
  "attendance.discord-notices": "Attendance notices",
  "attendance.discord-expiry": "Notice expiry",
  "attendance.discord-anomalies": "Attendance anomaly reports",
};
const outcomes: Record<Job["outcome"], string> = { waiting: "Waiting", running: "Pass in progress", ok: "Pass completed", failed: "Pass failed", paused: "Paused" };
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8_640_000_000_000_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
async function readStatus(): Promise<Snapshot> {
  const value = await api<unknown>("/admin/scheduler");
  if (!record(value) || typeof value.enabled !== "boolean" || !record(value.jobs) || Object.keys(value.jobs).length > 64
    || Object.keys(labels).some(id => !Object.hasOwn(value.jobs as object, id))
    || Object.entries(value.jobs).some(([id, job]) => !id.length || id.length > 80 || !record(job) || !timestamp(job.next)
      || (job.last !== null && !timestamp(job.last)) || typeof job.outcome !== "string" || !Object.hasOwn(outcomes, job.outcome))) throw new Error("Invalid scheduler status");
  return value as Snapshot;
}
function time(value: number | null) { return value === null ? "Not yet attempted" : new Date(value).toLocaleString(); }

export function SchedulerControls() {
  const [stored, setStored] = useState<Snapshot>();
  const [busy, setBusy] = useState(true);
  const [mustReload, setMustReload] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const pending = useRef(false), id = useId();
  const actionButton = useRef<HTMLButtonElement>(null), reloadButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<"action" | "reload" | null>(null);
  useEffect(() => {
    if (!busy && restoreFocus.current) {
      (restoreFocus.current === "action" && !mustReload ? actionButton : reloadButton).current?.focus();
      restoreFocus.current = null;
    }
  }, [busy, mustReload]);
  async function reload() {
    if (pending.current) return;
    if (document.activeElement === reloadButton.current) restoreFocus.current = "reload";
    pending.current = true; setBusy(true); setNotice(undefined);
    try { setStored(await readStatus()); setMustReload(false); }
    catch { setMustReload(true); setNotice({ error: true, text: "Scheduler status is unavailable. This deployment may not have a scheduler configured, or your Admin access or connection may be unavailable. Reload to check again." }); }
    finally { pending.current = false; setBusy(false); }
  }
  useEffect(() => { void reload(); }, []);
  async function change() {
    if (pending.current || busy || mustReload || !stored) return;
    const enabled = !stored.enabled;
    restoreFocus.current = "action";
    pending.current = true; setBusy(true); setNotice(undefined);
    try {
      await api(`/admin/scheduler/${enabled ? "start" : "stop"}`, { method: "POST", body: "{}" });
      const current = await readStatus();
      setStored(current);
      if (current.enabled !== enabled) throw new Error("Scheduler state changed");
      setNotice({ error: false, text: `Scheduler ${enabled ? "started" : "stopped"}. The current server state was verified.` });
    } catch { setMustReload(true); setNotice({ error: true, text: "The scheduler change could not be verified. Reload scheduler status before another action. The request may have taken effect; it will not be retried automatically." }); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="scheduler-controls" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Background scheduler</h2>
    <p>Run background checks even when the dashboard is closed. Stopping waits for the current job pass and cannot retract a provider request already sent.</p>
    {notice && <p className="ui-status" data-tone={notice.error ? "error" : "success"} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    {busy && <p role="status">Checking scheduler state…</p>}
    {stored && <p>Last loaded scheduler state: <strong>{stored.enabled ? "Running" : "Stopped"}</strong>.{mustReload && " This snapshot may be out of date."}</p>}
    <div className="scheduler-actions">
      {stored && <button ref={actionButton} type="button" className="primary-button" disabled={busy || mustReload} onClick={() => void change()}>{stored.enabled ? "Stop scheduler" : "Start scheduler"}</button>}
      <button ref={reloadButton} type="button" className="quiet-button" disabled={busy} onClick={() => void reload()}>Reload scheduler status</button>
    </div>
    <p>Job outcomes describe a single pass, not delivery to a provider. <a href="/settings/integrations">Review provider status in Integrations</a>.</p>
    {stored && <><h3>Last loaded job activity</h3>{Object.keys(stored.jobs).length === 0 ? <p>No job activity was reported.</p> : <dl className="scheduler-jobs">{Object.entries(stored.jobs).map(([jobId, job]) => <div key={jobId}>
      <dt>{Object.hasOwn(labels, jobId) ? labels[jobId] : jobId}</dt>
      <dd><span>{outcomes[job.outcome]}</span><span>Last attempt: {time(job.last)}</span><span>{stored.enabled ? "Next eligible pass" : "Retained next-pass time"}: {time(job.next)}</span></dd>
    </div>)}</dl>}</>}
  </section>;
}
