import { apiBaseUrl } from "./dashboard-api";

/** A refused pairing-code request. A name held by a kiosk that stopped checking in also carries its id for Retire and replace. */
export class PairingCodeError extends Error {
  readonly status: number; readonly code?: string; readonly replaceableKioskId?: string;
  constructor(message: string, status: number, code?: string, replaceableKioskId?: string) { super(message); this.name = "PairingCodeError"; this.status = status; this.code = code; this.replaceableKioskId = replaceableKioskId; }
}

/** POST to /admin/pairing-codes, keeping the error body's code and replaceableKioskId that the shared api() helper drops. */
export async function requestPairingCode<T>(path: "/admin/pairing-codes", body: Record<string, unknown>): Promise<T> {
  const result = await fetch(`${apiBaseUrl}${path}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await result.json().catch(() => ({})) as T & { error?: string; details?: string[]; code?: string; replaceableKioskId?: string };
  if (!result.ok) throw new PairingCodeError(payload.details?.join(" ") ?? payload.error ?? "Request failed", result.status, payload.code, payload.code === "kiosk_name_in_use" && typeof payload.replaceableKioskId === "string" ? payload.replaceableKioskId : undefined);
  return payload;
}

/** Offered when the name belongs to an active kiosk that has not checked in for 10 minutes. */
export function RetireAndReplace({ name, message, busy, onReplace }: { name: string; message: string; busy: boolean; onReplace: () => void }) {
  return <div className="settings-callout kiosk-replace-callout" role="alert">
    <div><strong>{message}</strong><p>The kiosk named {name} hasn't checked in for at least 10 minutes. Retire and replace stops its credential and keeps its attendance history, then creates the code for the new device.</p></div>
    <button className="ui-button ui-button--danger" type="button" disabled={busy} onClick={onReplace}>Retire and replace</button>
  </div>;
}
