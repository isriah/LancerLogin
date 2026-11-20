import { useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { PinRequestList, pinRequestHint, usePinRequestAnswers, type PinRequest } from "./kiosk-pin-requests";
import { useModalFocus } from "./modal-focus";
import { countPinRequests, pinRequestCountText, setPinRequestCounts, usePinRequestCounts } from "./pin-request-counts";
import { visiblePoll } from "./visible-poll";

type WaitingPinRequest = PinRequest & { kioskId: string; kioskName: string };
type Notice = { message: string; tone: "success" | "error" };

/**
 * The top bar's count of PIN requests waiting at any kiosk, for Admins and Operators, beside the Reviews count. It shows
 * only while at least one request is waiting. The count comes with the shell's module refresh, so it asks for nothing
 * itself until it is opened.
 *
 * Opening it lists every waiting request by kiosk, read from GET /admin/kiosks/pin-requests and again every 10 seconds while
 * the dialog is open, as Manage kiosk does. Approve and Decline are the ones on Manage kiosk.
 */
export function PinRequestIndicator({ enabled }: { enabled: boolean }) {
  const counts = usePinRequestCounts();
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState<WaitingPinRequest[]>();
  const [now, setNow] = useState(Date.now());
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<Notice>();
  const dialog = useRef<HTMLElement>(null);
  function close() { setOpen(false); setNotice(undefined); setRequests(undefined); }
  useEffect(() => { if (!enabled) close(); }, [enabled]);
  useEffect(() => {
    if (!open || !enabled) return;
    let current = true;
    const stop = visiblePoll(async () => {
      const result = await api<{ requests: WaitingPinRequest[] }>("/admin/kiosks/pin-requests");
      if (!current) return;
      const waiting = result.requests ?? [];
      setRequests(waiting); setNow(Date.now());
    }, 10_000, (error) => { if (current) setNotice({ message: error.message, tone: "error" }); }, true);
    return () => { current = false; stop(); };
  }, [open, enabled, reload]);
  const { busy, answer } = usePinRequestAnswers<WaitingPinRequest>((message, tone) => setNotice({ message, tone }), (request, answered) => {
    if (answered) setRequests((items) => items?.filter((item) => item.id !== request.id));
    setReload((value) => value + 1);
  });
  // What the dialog shows is the newest answer there is, so the top bar and the Kiosks list follow it at once.
  useEffect(() => { if (requests) setPinRequestCounts(countPinRequests(requests)); }, [requests]);
  useModalFocus(dialog, open, false, close);
  if (!enabled || (!counts.total && !open)) return null;

  const count = counts.total;
  const kiosks = new Map<string, { name: string; requests: WaitingPinRequest[] }>();
  for (const request of requests ?? []) {
    const kiosk = kiosks.get(request.kioskId) ?? { name: request.kioskName, requests: [] };
    kiosk.requests.push(request); kiosks.set(request.kioskId, kiosk);
  }
  return <>
    {count > 0 && <button className="contest-indicator pin-request-indicator" type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="pin-requests-dialog" onClick={() => { setNotice(undefined); setOpen(true); }} aria-label={`${pinRequestCountText(count)} waiting. Open PIN requests.`} title={`${pinRequestCountText(count)} waiting`}><span aria-hidden="true">{count}</span> PIN {count === 1 ? "request" : "requests"}</button>}
    {open && <div className="dialog-backdrop"><section id="pin-requests-dialog" className="ui-dialog contest-review-dialog pin-requests-dialog" role="dialog" aria-modal="true" aria-labelledby="pin-requests-dialog-title" tabIndex={-1} ref={dialog}>
      <div className="dialog-heading"><div><h2 id="pin-requests-dialog-title">PIN requests</h2><p>Approve or decline waiting PIN requests without leaving your current page.</p></div><button type="button" aria-label="Close PIN requests dialog" onClick={close}>×</button></div>
      {notice && <p className="ui-status setup-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p>}
      {!requests ? !notice && <p className="ui-status" role="status">Loading PIN requests…</p> : kiosks.size ? <>
        {[...kiosks].map(([kioskId, kiosk]) => <section className="pin-request-kiosk" key={kioskId} aria-label={`PIN requests at ${kiosk.name}`}>
          <h3>{kiosk.name}</h3>
          <PinRequestList requests={kiosk.requests} now={now} busy={busy} onAnswer={(request, decision) => void answer(request, decision)} />
        </section>)}
        <p className="kiosk-pin-hint">{pinRequestHint}</p>
      </> : <p className="empty-state">No PIN requests are waiting.</p>}
    </section></div>}
  </>;
}
