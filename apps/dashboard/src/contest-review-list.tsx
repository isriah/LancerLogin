import { useState } from "react";
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
};

export const contestsChangedEvent = "lancerlogin:contests-changed";

const contestKey = (contest: Contest) => `${contest.meetingId}:${contest.memberId}`;
const occurrenceDate = (contest: Contest) => new Date(contest.meetingStartsAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function ContestReviewList({ contests, onResolved }: { contests: Contest[]; onResolved?: (resolution: Contest["status"], contest: Contest) => void }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");

  async function resolve(contest: Contest, resolution: "approved" | "rejected" | "reviewed") {
    const key = contestKey(contest); const reviewNote = notes[key]?.trim() ?? "";
    if (!reviewNote) { setErrors((current) => ({ ...current, [key]: "A review reason is required before resolving this contest." })); return; }
    setErrors((current) => ({ ...current, [key]: "" })); setBusy(key);
    try {
      await api("/discord/contests/resolve", { method: "POST", body: JSON.stringify({ meetingId: contest.meetingId, memberId: contest.memberId, resolution, reviewNote }) });
      window.dispatchEvent(new Event(contestsChangedEvent));
      onResolved?.(resolution, contest);
    } catch (error) {
      const message = (error as Error).message || "Request failed";
      setErrors((current) => ({ ...current, [key]: `Contest resolution failed: ${message}` }));
    } finally { setBusy(""); }
  }

  return <div className="contest-list contest-review-list">{contests.map((contest) => { const key = contestKey(contest); const error = errors[key]; const itemBusy = busy === key; return <article key={key}><div className="contest-summary"><strong>{contest.firstName} {contest.lastName}<small>{contest.externalId}</small></strong><span>{contest.meetingTitle} · {occurrenceDate(contest)}</span></div><label htmlFor={`contest-review-reason-${key}`}>Review reason<textarea id={`contest-review-reason-${key}`} value={notes[key] ?? ""} maxLength={500} required disabled={itemBusy} aria-invalid={Boolean(error)} aria-describedby={error ? `contest-review-error-${key}` : undefined} onChange={(event) => { const value = event.target.value; setNotes((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: "" })); }} /></label>{error && <p id={`contest-review-error-${key}`} className="inline-messages error" role="alert">{error}</p>}<div className="contest-actions"><button type="button" disabled={itemBusy} onClick={() => void resolve(contest, "reviewed")}>Keep attendance</button><button type="button" disabled={itemBusy} onClick={() => void resolve(contest, "rejected")}>Reject contest</button><button className="primary-button" type="button" disabled={itemBusy} onClick={() => void resolve(contest, "approved")}>Approve and mark present</button></div></article>; })}</div>;
}
