import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { ContestReviewList, contestsChangedEvent, type Contest } from "./contest-review-list";
import { useModalFocus } from "./modal-focus";

export function ContestIndicator({ enabled }: { enabled: boolean }) {
  const [contests, setContests] = useState<Contest[]>([]); const [available, setAvailable] = useState(false); const [open, setOpen] = useState(false); const [notice, setNotice] = useState(""); const dialog = useRef<HTMLElement>(null);
  const load = useCallback(async () => { const capabilities = await api<{ integrations: { discord: { configured: boolean } } }>("/integrations/capabilities"); const configured = capabilities.integrations.discord.configured; setAvailable(configured); if (!configured) { setContests([]); setOpen(false); return; } const result = await api<{ contests: Contest[] }>("/discord/contests"); setContests(result.contests.filter((contest) => contest.status === "open")); }, []);
  function close() { setOpen(false); setNotice(""); }
  useEffect(() => {
    if (!enabled) { setAvailable(false); setContests([]); setOpen(false); setNotice(""); return; }
    const refresh = () => { void load().catch(() => { setAvailable(false); setContests([]); setOpen(false); }); };
    refresh(); window.addEventListener(contestsChangedEvent, refresh);
    return () => window.removeEventListener(contestsChangedEvent, refresh);
  }, [enabled, load]);
  useModalFocus(dialog, open, false, close);
  if (!enabled || !available || (!contests.length && !open && !notice)) return null;
  const count = contests.length;
  return <>{count > 0 && <button className="contest-indicator" type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="contest-review-dialog" onClick={() => { setNotice(""); setOpen(true); }} aria-label={`${count} attendance contest${count === 1 ? "" : "s"} awaiting review. Open contest review.`}><span aria-hidden="true">!</span> {count} contest{count === 1 ? "" : "s"} awaiting review</button>}{open && <div className="dialog-backdrop"><section id="contest-review-dialog" className="contest-review-dialog" role="dialog" aria-modal="true" aria-labelledby="contest-review-title" tabIndex={-1} ref={dialog}><div className="dialog-heading"><div><h2 id="contest-review-title">Contests awaiting review</h2><p>Review pending attendance contests without leaving your current page.</p></div><button type="button" aria-label="Close contest review dialog" onClick={close}>×</button></div>{notice && <p className="setup-status" role="status">{notice}</p>}{count ? <ContestReviewList contests={contests} onResolved={(resolution) => setNotice(`Contest ${resolution}.`)} /> : <p className="empty-state">No attendance contests need review.</p>}</section></div>}</>;
}
