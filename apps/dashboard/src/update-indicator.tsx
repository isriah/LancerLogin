import { useEffect, useState } from "react";
import { controlRequest, hasUpdateControl } from './update-control';
import { api } from "./dashboard-api";
import { createUpdatePolling } from "./update-polling";

export type UpdaterStatus = { configured: boolean; maintenance?: { state: string }; installedVersion: string; schema?: number; recoveryUrl?: string; controlUrl?: string; expiresAt?: number; ended?: boolean; recoveryAvailable: boolean; admission?: { requestId: string; state: string; reason: string | null } | null; job: null | { id: string; requestId: string; mode: string; status: string; step: string; completedSteps: number; totalSteps: number; operationId: string | null; failure: string | null; retryPreparationOperationId: string | null }; availability: { status: string; checked: number; total: number; checkedAt: number; version?: string; releaseId?: number } };
type Check = { current: string; latest: string; available: boolean; checking: boolean };
const cacheKey = "lancerlogin-private-update-check-v1";
export function isNewerRelease(candidate: string, installed: string) {
  const parse = (value: string) => value.replace(/^v/, "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const next = parse(candidate), current = parse(installed);
  if (next.some(Number.isNaN) || current.some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index++) if ((next[index] ?? 0) !== (current[index] ?? 0)) return (next[index] ?? 0) > (current[index] ?? 0);
  return false;
}
export const formatVersion = (value?: string) => value ? value.replace(/^v/, "") : "";
export const updaterPolling = createUpdatePolling<UpdaterStatus>({
  read: async () => {
    if(hasUpdateControl())return controlRequest('status');
    let status = await api<UpdaterStatus>("/admin/updater/status");
    if (document.visibilityState === 'visible' && status.configured && (!status.job || ["succeeded", "recovered"].includes(status.job.status)) && (status.availability.status === "not-checked" || status.availability.status === "checking" || (status.availability.status !== "failed" && Date.now() - status.availability.checkedAt > 6 * 60 * 60_000))) status = await api<UpdaterStatus>("/admin/updater/check", { method: "POST", body: "{}" });
    return status;
  },
  cadence: status => !status.configured ? 300_000 : status.availability.status === 'checking' || ['running', 'reconciling'].includes(status.job?.status ?? '') ? 5000 : 60_000,
});
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => updaterPolling.visibilityChanged());
function display(status: UpdaterStatus): Check {
  return { current: formatVersion(status.installedVersion), latest: formatVersion(status.availability.version), available: status.configured && status.availability.status === "available" && (!status.job || ["succeeded", "recovered"].includes(status.job.status)), checking: status.availability.status === "checking" };
}
export async function checkForUpdate(): Promise<Check> { return display(await updaterPolling.refresh()); }
function useUpdateCheck() {
  const [check, setCheck] = useState<Check>();
  useEffect(() => updaterPolling.subscribe(value => setCheck(display(value))), []);
  return check;
}
export function UpdateIndicator({ openUpdates }: { openUpdates: () => void }) {
  const check = useUpdateCheck();
  if (!check?.available) return null;
  return <button className="update-indicator" type="button" onClick={openUpdates} aria-label={`LancerLogin ${check.latest} is available. Open Updates.`}><span aria-hidden="true">Ã¢â€ â€˜</span> Update available <strong>{check.latest}</strong></button>;
}
export function UpdateAvailablePopup({ openUpdates }: { openUpdates: () => void }) {
  const check = useUpdateCheck(); const [dismissed, setDismissed] = useState("");
  if (window.location.pathname === "/settings/updates" || !check?.available || dismissed === check.latest || localStorage.getItem(`lancerlogin-update-dismissed:${check.latest}`) === "true") return null;
  const latest = check.latest;
  function dismiss() { localStorage.setItem(`lancerlogin-update-dismissed:${latest}`, "true"); setDismissed(latest); }
  return <aside className="ui-card ui-status update-available-popup" role="status" aria-label="Update available"><div><strong>LancerLogin {check.latest} is ready</strong><span>This dashboard is running {check.current}. Review and install the verified update.</span></div><button className="primary-button" type="button" onClick={openUpdates}>Open Updates</button><button className="popup-dismiss" type="button" aria-label="Dismiss update notice" onClick={dismiss}>Ãƒâ€”</button></aside>;
}
export function clearUpdateCheckCache() { localStorage.removeItem(cacheKey); updaterPolling.invalidate(); }
