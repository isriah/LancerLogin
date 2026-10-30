import { useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";

export type Contest = {
  meetingId: string;
  meetingTitle: string;
  meetingStartsAt: string;
  memberId: string;
  externalId: string;
  firstName: string;
  lastName: string;
  status: "open" | "approved" | "rejected" | "reviewed";
  createdAt: string;
  lifetimeContestCount: number;
  priorReviews?: { createdAt: string; resolvedAt: string | null; status: string; reviewNote: string | null }[];
  hasPartialScan: boolean;
  rawScanStatus: "none" | "partial" | "complete";
};

export const contestsChangedEvent = "lancerlogin:contests-changed";

const contestKey = (contest: Contest) => `${contest.meetingId}:${contest.memberId}`;
const occurrenceDate = (contest: Contest) => new Date(contest.meetingStartsAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const memberPageHref = (contest: Contest) => `/roster/${encodeURIComponent(contest.externalId)}`;
const rawScanLabel = (status: Contest["rawScanStatus"]) => status === "partial" ? "Partial — checked in, no check-out" : status === "complete" ? "Complete — checked in and out" : "No scans";

export function ContestReviewList({ contests, onResolved, onBulkResolved }: { contests: Contest[]; onResolved?: (resolution: Contest["status"], contest: Contest) => void; onBulkResolved?: (contests: Contest[], resolution: "approved" | "rejected") => void }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkReason, setBulkReason] = useState("");
  const [bulkNotice, setBulkNotice] = useState("");
  const [bulkError, setBulkError] = useState("");
  const selectAll = useRef<HTMLInputElement>(null);
  const query = filter.trim().toLocaleLowerCase();
  const visible = contests.filter((contest) => contest.status === "open" && (!query || `${contest.firstName} ${contest.lastName} ${contest.externalId} ${contest.meetingTitle}`.toLocaleLowerCase().includes(query)));
  const selectedVisible = visible.filter((contest) => selected.includes(contestKey(contest)));
  const allSelected = visible.length > 0 && selectedVisible.length === visible.length;
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selectedVisible.length > 0 && !allSelected; }, [selectedVisible.length, allSelected]);
  useEffect(() => { const open = new Set(contests.filter((contest) => contest.status === "open").map(contestKey)); setSelected((current) => current.filter((key) => open.has(key))); }, [contests]);

  async function resolve(contest: Contest, resolution: "approved" | "rejected" | "reviewed") {
    if (busyRef.current) return;
    const key = contestKey(contest); const reviewNote = notes[key]?.trim() ?? "";
    if (!reviewNote) { setErrors((current) => ({ ...current, [key]: "A review reason is required before resolving this contest." })); return; }
    setErrors((current) => ({ ...current, [key]: "" })); setBusy(key); busyRef.current = true;
    try {
      await api("/discord/contests/resolve", { method: "POST", body: JSON.stringify({ meetingId: contest.meetingId, memberId: contest.memberId, createdAt: contest.createdAt, resolution, reviewNote }) });
      window.dispatchEvent(new Event(contestsChangedEvent));
      onResolved?.(resolution, contest);
    } catch (error) {
      const message = (error as Error).message || "Request failed";
      setErrors((current) => ({ ...current, [key]: `Contest resolution failed: ${message}` }));
    } finally { busyRef.current = false; setBusy(""); }
  }

  async function resolveSelected(resolution: "approved" | "rejected") {
    const action = resolution === "approved" ? "accept" : "reject";
    const past = resolution === "approved" ? "accepted" : "rejected";
    if (busyRef.current) return;
    const items = [...selectedVisible];
    if (!items.length) return;
    const reviewNote = bulkReason.trim();
    if (!reviewNote) { setBulkError(`A shared review reason is required before ${action}ing these contests.`); return; }
    busyRef.current = true; setBusy(`bulk-${action}`); setBulkNotice(""); setBulkError("");
    let accepted = 0;
    try {
      const resolved: Contest[] = [];
      for (let offset = 0; offset < items.length; offset += 100) {
        const chunk = items.slice(offset, offset + 100);
        const outcome: Record<string, string> = {};
        try {
          const response = await api<{ results: { meetingId: string; memberId: string; resolved: boolean; error?: string }[] }>(`/discord/contests/${action}`, { method: "POST", body: JSON.stringify({ contests: chunk.map(({ meetingId, memberId, createdAt }) => ({ meetingId, memberId, createdAt })), reviewNote }) });
          if (!Array.isArray(response.results) || response.results.length !== chunk.length || response.results.some((result, index) => result.meetingId !== chunk[index].meetingId || result.memberId !== chunk[index].memberId || typeof result.resolved !== "boolean")) throw new Error("The review results could not be verified. Refresh contests before retrying.");
          for (const [index, result] of response.results.entries()) {
            const contest = chunk[index], key = contestKey(contest);
            outcome[key] = result.resolved ? "" : `Contest ${resolution === "approved" ? "acceptance" : "rejection"} failed: ${result.error || "Refresh before retrying."}`;
            if (result.resolved) { accepted++; resolved.push(contest); }
          }
        } catch (error) {
          for (const contest of chunk) outcome[contestKey(contest)] = `Contest ${resolution === "approved" ? "acceptance" : "rejection"} failed: ${(error as Error).message || "Request failed"}`;
        }
        setErrors(current => ({ ...current, ...outcome }));
      }
      const resolvedKeys = new Set(resolved.map(contestKey));
      setSelected(current => current.filter(key => !resolvedKeys.has(key)));
      if (resolved.length) { if (onBulkResolved) onBulkResolved(resolved, resolution); else for (const contest of resolved) onResolved?.(resolution, contest); }
      const failed = items.length - accepted;
      setBulkNotice(`${accepted} contest${accepted === 1 ? "" : "s"} ${past}.${failed ? ` ${failed} could not be ${past}. Review the errors beside those entries before retrying.` : ""}`);
    } finally {
      if (accepted) window.dispatchEvent(new Event(contestsChangedEvent));
      busyRef.current = false; setBusy("");
    }
  }

  return <div className="contest-list contest-review-list">
    <div className="contest-bulk-controls">
      <label>Filter contests<input className="ui-control" type="search" value={filter} disabled={Boolean(busy)} placeholder="Name, member ID or meeting" onChange={(event) => { setFilter(event.target.value); setSelected([]); setBulkNotice(""); }} /></label>
      <label className="ui-checkbox"><input className="ui-checkbox" ref={selectAll} type="checkbox" checked={allSelected} disabled={Boolean(busy) || !visible.length} onChange={(event) => setSelected(event.target.checked ? visible.map(contestKey) : [])} />Select all {visible.length} filtered contests</label>
      {selectedVisible.length > 0 && <form className="contest-bulk-form ui-form" onSubmit={(event) => { event.preventDefault(); void resolveSelected("approved"); }}>
        <label>Shared review reason<textarea className="ui-control" value={bulkReason} maxLength={500} disabled={Boolean(busy)} aria-invalid={Boolean(bulkError)} aria-describedby={bulkError ? "contest-bulk-error" : undefined} onChange={(event) => { setBulkReason(event.target.value); setBulkError(""); }} /></label>
        <div className="ui-action-row"><button className="ui-button ui-button--primary" type="submit" disabled={Boolean(busy)}>{busy === "bulk-accept" ? "Accepting..." : `Accept ${selectedVisible.length} selected contest${selectedVisible.length === 1 ? "" : "s"}`}</button><button className="ui-button ui-button--danger" type="button" disabled={Boolean(busy)} onClick={() => void resolveSelected("rejected")}>{busy === "bulk-reject" ? "Rejecting..." : `Reject ${selectedVisible.length} selected contest${selectedVisible.length === 1 ? "" : "s"}`}</button><button className="ui-button" type="button" disabled={Boolean(busy)} onClick={() => setSelected([])}>Clear selection</button></div>
      </form>}
      {bulkError && <p className="ui-status" data-tone="error" id="contest-bulk-error" role="alert">{bulkError}</p>}
      {bulkNotice && <p className="ui-status" role="status">{bulkNotice}</p>}
    </div>
    {!visible.length && <p className="empty-state">No open contests match this filter.</p>}
    {visible.map((contest) => {
      const key = contestKey(contest); const error = errors[key]; const itemBusy = Boolean(busy);
      return <article key={key}>
        <div className="contest-summary">
          <div className="contest-member"><label className="ui-checkbox"><input className="ui-checkbox" type="checkbox" disabled={itemBusy} checked={selected.includes(key)} aria-label={`Select contest for ${contest.firstName} ${contest.lastName} at ${contest.meetingTitle}`} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, key])] : current.filter((selectedKey) => selectedKey !== key))} /></label><a className="contest-member-link" href={memberPageHref(contest)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${contest.firstName} ${contest.lastName}'s member page in a new tab`}><strong>{contest.firstName} {contest.lastName}<small>{contest.externalId}</small><span className="contest-member-link-cue" aria-hidden="true">↗</span></strong></a></div>
          <span>{contest.meetingTitle} · {occurrenceDate(contest)}</span>
          <dl className="contest-context"><div><dt>Submitted contests</dt><dd>{contest.lifetimeContestCount}</dd></div><div><dt>Meeting scans</dt><dd>{rawScanLabel(contest.rawScanStatus)}</dd></div></dl>
        </div>
        {Boolean(contest.priorReviews?.length) && <details><summary>Previous reviews ({contest.priorReviews!.length})</summary><ol>{contest.priorReviews!.map((review, index) => <li key={index}>{review.status} on {new Date(review.resolvedAt ?? review.createdAt).toLocaleString()}: {review.reviewNote || "No review note"}</li>)}</ol></details>}
        <label htmlFor={`contest-review-reason-${key}`}>Review reason<textarea id={`contest-review-reason-${key}`} value={notes[key] ?? ""} maxLength={500} required disabled={itemBusy} aria-invalid={Boolean(error)} aria-describedby={error ? `contest-review-error-${key}` : undefined} onChange={(event) => { const value = event.target.value; setNotes((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: "" })); }} /></label>
        {error && <p id={`contest-review-error-${key}`} className="inline-messages error" role="alert">{error}</p>}
        <div className="contest-actions"><button className="ui-button" type="button" disabled={itemBusy} onClick={() => void resolve(contest, "reviewed")}>Keep attendance</button><button className="ui-button" type="button" disabled={itemBusy} onClick={() => void resolve(contest, "rejected")}>Reject contest</button><button className="ui-button ui-button--primary" type="button" disabled={itemBusy} onClick={() => void resolve(contest, "approved")}>Approve and mark present</button></div>
      </article>;
    })}
  </div>;
}
