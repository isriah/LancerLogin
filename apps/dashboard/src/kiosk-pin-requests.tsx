import { useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { setKioskPinRequestCount } from "./pin-request-counts";
import { visiblePoll } from "./visible-poll";
import "./kiosk-pins.css";

export type PinRequest = { id: string; member: { rosterId: string; memberId: string; firstName: string; lastName: string }; createdAt: string; expiresAt: string };

/** "2 minutes ago", counted from when the member asked at the kiosk. */
export function askedAgo(createdAt: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60_000));
  return minutes < 1 ? "less than a minute ago" : `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
}

export type PinRequestNotice = (message: string, tone: "success" | "error") => void;

/**
 * Approve and Decline for a waiting request, the same wherever its row is shown: one answer at a time, sent to
 * POST /admin/pin-requests/:id/approve or /decline, then the notice. `onSettled` runs after every try, with whether the
 * answer was taken, so the caller drops the row and reads its list again.
 */
export function usePinRequestAnswers<T extends PinRequest>(onNotice: PinRequestNotice, onSettled: (request: T, answered: boolean) => void) {
  const [busy, setBusy] = useState<string>();
  async function answer(request: T, decision: "approve" | "decline") {
    if (busy) return;
    const name = `${request.member.firstName} ${request.member.lastName}`;
    setBusy(request.id);
    let answered = false;
    try {
      await api(`/admin/pin-requests/${encodeURIComponent(request.id)}/${decision}`, { method: "POST", body: JSON.stringify({}) });
      answered = true;
      onNotice(decision === "approve" ? `Approved. ${name} can choose a PIN on the kiosk within 5 minutes.` : `Declined ${name}'s PIN request.`, "success");
    } catch (error) { onNotice((error as Error).message, "error"); }
    finally { setBusy(undefined); onSettled(request, answered); }
  }
  return { busy: Boolean(busy), answer };
}

/** The rows of waiting requests, each with Decline and Approve. Shared by Manage kiosk and the top bar's dialog. */
export function PinRequestList<T extends PinRequest>({ requests, now, busy, onAnswer }: { requests: T[]; now: number; busy: boolean; onAnswer: (request: T, decision: "approve" | "decline") => void }) {
  return <ul className="kiosk-pin-request-list">{requests.map((request) => {
    const name = `${request.member.firstName} ${request.member.lastName}`;
    return <li className="kiosk-pin-request" key={request.id}>
      <div className="kiosk-pin-request-member"><span><strong>{name}</strong> · {request.member.memberId}</span><small>Asked to set up a PIN · {askedAgo(request.createdAt, now)}</small></div>
      <div className="kiosk-pin-request-actions" role="group" aria-label={`PIN request from ${name}`}>
        <button className="ui-button" type="button" disabled={busy} onClick={() => onAnswer(request, "decline")}>Decline</button>
        <button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => onAnswer(request, "approve")}>Approve</button>
      </div>
    </li>;
  })}</ul>;
}

export const pinRequestHint = "Approving lets the member choose a PIN on the kiosk within 5 minutes. Admins and Operators can approve.";
/** The id of the Manage kiosk card, which a Kiosks list count links to. */
export const kioskPinRequestsCardId = "kiosk-pin-requests";

/**
 * Manage kiosk > PIN requests: members at this kiosk waiting for an Operator's approval to set a PIN. Polls every
 * 10 seconds while the page is open and renders nothing while no request is waiting. Admins and Operators answer.
 * Each read also updates this kiosk's count in the top bar and the Kiosks list.
 */
export function KioskPinRequests({ kioskId, onNotice }: { kioskId: string; onNotice: PinRequestNotice }) {
  const [requests, setRequests] = useState<PinRequest[]>([]);
  const [now, setNow] = useState(Date.now());
  const [reload, setReload] = useState(0);
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    // The parent keys this card by kiosk, so a reload after an answer keeps the rows shown until the refresh lands.
    let current = true;
    const stop = visiblePoll(async () => {
      const result = await api<{ requests: PinRequest[] }>(`/admin/kiosks/${encodeURIComponent(kioskId)}/pin-requests`);
      if (current) { setRequests(result.requests ?? []); setNow(Date.now()); setKioskPinRequestCount(kioskId, (result.requests ?? []).length); }
    }, 10_000, () => undefined, true);
    return () => { current = false; stop(); };
  }, [kioskId, reload]);
  const { busy, answer } = usePinRequestAnswers<PinRequest>(onNotice, (request, answered) => {
    if (answered) setRequests((items) => items.filter((item) => item.id !== request.id));
    setReload((value) => value + 1);
  });
  // A Kiosks list count opened in a new tab lands on this card.
  const shown = requests.length > 0;
  useEffect(() => { if (shown && window.location.hash === `#${kioskPinRequestsCardId}`) card.current?.scrollIntoView({ block: "nearest" }); }, [shown]);

  if (!shown) return null;
  return <article id={kioskPinRequestsCardId} ref={card} className="task-card ui-card kiosk-pin-requests" aria-labelledby="kiosk-pin-requests-title">
    <div className="kiosk-pin-card-heading"><h2 id="kiosk-pin-requests-title">PIN requests</h2><span className="status-pill ui-status" data-tone="warning">{requests.length} waiting</span></div>
    <PinRequestList requests={requests} now={now} busy={busy} onAnswer={(request, decision) => void answer(request, decision)} />
    <p className="kiosk-pin-hint">{pinRequestHint}</p>
  </article>;
}
