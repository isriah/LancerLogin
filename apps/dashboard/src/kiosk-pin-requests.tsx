import { useEffect, useState } from "react";
import { api } from "./dashboard-api";
import { visiblePoll } from "./visible-poll";
import "./kiosk-pins.css";

export type PinRequest = { id: string; member: { rosterId: string; memberId: string; firstName: string; lastName: string }; createdAt: string; expiresAt: string };

/** "2 minutes ago", counted from when the member asked at the kiosk. */
export function askedAgo(createdAt: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60_000));
  return minutes < 1 ? "less than a minute ago" : `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
}

/**
 * Manage kiosk > PIN requests: members at this kiosk waiting for an Operator's approval to set a PIN. Polls every
 * 10 seconds while the page is open and renders nothing while no request is waiting. Admins and Operators answer.
 */
export function KioskPinRequests({ kioskId, onNotice }: { kioskId: string; onNotice: (message: string, tone: "success" | "error") => void }) {
  const [requests, setRequests] = useState<PinRequest[]>([]);
  const [busy, setBusy] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const [reload, setReload] = useState(0);
  useEffect(() => {
    // The parent keys this card by kiosk, so a reload after an answer keeps the rows shown until the refresh lands.
    let current = true;
    const stop = visiblePoll(async () => {
      const result = await api<{ requests: PinRequest[] }>(`/admin/kiosks/${encodeURIComponent(kioskId)}/pin-requests`);
      if (current) { setRequests(result.requests ?? []); setNow(Date.now()); }
    }, 10_000, () => undefined, true);
    return () => { current = false; stop(); };
  }, [kioskId, reload]);

  async function answer(request: PinRequest, decision: "approve" | "decline") {
    if (busy) return;
    const name = `${request.member.firstName} ${request.member.lastName}`;
    setBusy(request.id);
    try {
      await api(`/admin/pin-requests/${encodeURIComponent(request.id)}/${decision}`, { method: "POST", body: JSON.stringify({}) });
      setRequests((items) => items.filter((item) => item.id !== request.id));
      onNotice(decision === "approve" ? `Approved. ${name} can choose a PIN on the kiosk within 5 minutes.` : `Declined ${name}'s PIN request.`, "success");
    } catch (error) { onNotice((error as Error).message, "error"); }
    finally { setBusy(undefined); setReload((value) => value + 1); }
  }

  if (!requests.length) return null;
  return <article className="task-card ui-card kiosk-pin-requests" aria-labelledby="kiosk-pin-requests-title">
    <div className="kiosk-pin-card-heading"><h2 id="kiosk-pin-requests-title">PIN requests</h2><span className="status-pill ui-status" data-tone="warning">{requests.length} waiting</span></div>
    <ul className="kiosk-pin-request-list">{requests.map((request) => {
      const name = `${request.member.firstName} ${request.member.lastName}`;
      return <li className="kiosk-pin-request" key={request.id}>
        <div className="kiosk-pin-request-member"><span><strong>{name}</strong> · {request.member.memberId}</span><small>Asked to set up a PIN · {askedAgo(request.createdAt, now)}</small></div>
        <div className="kiosk-pin-request-actions" role="group" aria-label={`PIN request from ${name}`}>
          <button className="ui-button" type="button" disabled={Boolean(busy)} onClick={() => void answer(request, "decline")}>Decline</button>
          <button className="ui-button ui-button--primary" type="button" disabled={Boolean(busy)} onClick={() => void answer(request, "approve")}>Approve</button>
        </div>
      </li>;
    })}</ul>
    <p className="kiosk-pin-hint">Approving lets the member choose a PIN on the kiosk within 5 minutes. Admins and Operators can approve.</p>
  </article>;
}
