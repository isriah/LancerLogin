import { useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { ContestReviewList, contestsChangedEvent, type Contest } from "./contest-review-list";
import { useModalFocus } from "./modal-focus";
import { createRetryingRead } from "./retrying-read";

/** `enabled` is the app shell's shared answer to whether Discord is configured, so only the contests themselves are requested here. */
export function ContestIndicator({ enabled }: { enabled: boolean }) {
  const [contests, setContests] = useState<Contest[]>([]); const [available, setAvailable] = useState(false); const [open, setOpen] = useState(false); const [notice, setNotice] = useState(""); const dialog = useRef<HTMLElement>(null);
  function close() { setOpen(false); setNotice(""); }
  useEffect(() => {
    if (!enabled) { setAvailable(false); setContests([]); setOpen(false); setNotice(""); return; }
    // A failed read changes nothing: the last count and an open dialog stay, and the read is tried again (retrying-read.ts)
    // until one succeeds, so a failed first read no longer leaves Reviews hidden until the next contest change. Before the
    // first answer nothing is shown, as there is no count to keep.
    const reader = createRetryingRead<Contest[]>({ fetch: () => api<{ contests: Contest[] }>("/discord/contests").then((result) => result.contests.filter((contest) => contest.status === "open")), onValue: (waiting) => { setAvailable(true); setContests(waiting); }, empty: [] });
    const refresh = () => { void reader.load(); };
    refresh(); window.addEventListener(contestsChangedEvent, refresh);
    return () => { reader.stop(); window.removeEventListener(contestsChangedEvent, refresh); };
  }, [enabled]);
  useModalFocus(dialog, open, false, close);
  if (!enabled || !available || (!contests.length && !open && !notice)) return null;
  const count = contests.length;
  return <>{count > 0 && <button className="contest-indicator" data-count={count} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="contest-review-dialog" onClick={() => { setNotice(""); setOpen(true); }} aria-label={`${count} attendance contest${count === 1 ? "" : "s"} awaiting review. Open contest review.`}><span aria-hidden="true">{count}</span> Reviews</button>}{open && <div className="dialog-backdrop"><section id="contest-review-dialog" className="ui-dialog contest-review-dialog" role="dialog" aria-modal="true" aria-labelledby="contest-review-title" tabIndex={-1} ref={dialog}><div className="dialog-heading"><div><h2 id="contest-review-title">Contests awaiting review</h2><p>Review pending attendance contests without leaving your current page.</p></div><button type="button" aria-label="Close contest review dialog" onClick={close}>×</button></div>{notice && <p className="ui-status setup-status" role="status">{notice}</p>}{count ? <ContestReviewList contests={contests} onResolved={(resolution, resolved) => { setContests((current) => current.filter((contest) => contest.meetingId !== resolved.meetingId || contest.memberId !== resolved.memberId)); setNotice(`Contest ${resolution}.`); }} /> : <p className="empty-state">No attendance contests need review.</p>}</section></div>}</>;
}
