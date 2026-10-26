import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./dashboard-api";
import { RouteLink, usePath } from "./router";
import "./kiosk-scan-reviews.css";

type ScanReview = { kioskId: string; kioskName: string; eventId: string; memberId: string; occurredAt: string; reasonCode: string; reviewStatus: "open" | "reviewed"; receivedAt: string; reviewedAt?: string; reviewNote?: string; clock?: { verified: boolean; observedAt?: string; source?: string }; meetingId?: string; pairingId?: string };
type ReviewPage = { records: ScanReview[]; hasMore: boolean };
const reviewKey = (record: ScanReview) => `${record.kioskId}:${record.eventId}`;

export function KioskScanReviews() {
  const { path, navigate } = usePath();
  const [status, setStatus] = useState<"open" | "reviewed">("open");
  const [offsets, setOffsets] = useState([0]);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<ReviewPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const mutation = useRef(false);
  const offset = offsets.at(-1) ?? 0;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setPage(undefined);
    void api<ReviewPage>(`/admin/kiosks/scan-reviews?status=${status}&offset=${offset}`, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setPage(result);
    }).catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message || "Could not load rejected scans."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [status, offset, revision]);

  async function markReviewed(event: FormEvent, record: ScanReview) {
    event.preventDefault();
    if (mutation.current) return;
    const key = reviewKey(record), note = notes[key]?.trim() ?? "";
    if (!note || note.length > 500) { setRowErrors((current) => ({ ...current, [key]: "Enter a review note of 1 to 500 characters." })); return; }
    mutation.current = true; setBusy(key); setNotice(""); setRowErrors((current) => ({ ...current, [key]: "" }));
    try {
      const result = await api<{ reviewed: boolean }>(`/admin/kiosks/${encodeURIComponent(record.kioskId)}/scan-reviews/${encodeURIComponent(record.eventId)}/review`, { method: "POST", body: JSON.stringify({ note }) });
      if (!result.reviewed) throw new Error("The server did not confirm this review. Refresh and try again.");
      setNotice("Scan marked reviewed. Attendance was not changed.");
      setNotes((current) => { const next = { ...current }; delete next[key]; return next; });
      setRevision((value) => value + 1);
    } catch (cause) { setRowErrors((current) => ({ ...current, [key]: (cause as Error).message || "Could not mark this scan reviewed. Your note is preserved." })); }
    finally { mutation.current = false; setBusy(""); }
  }

  return <section className="task-card kiosk-scan-reviews" aria-labelledby="scan-reviews-title">
    <div className="panel-heading"><div><h2 id="scan-reviews-title">Rejected scans</h2><p>Review uploaded scan evidence from all kiosks, including retired devices. A rejected scan does not count as attendance.</p></div><button className="ui-button" type="button" disabled={loading || Boolean(busy)} onClick={() => setRevision((value) => value + 1)}>Refresh rejected scans</button></div>
    <label className="scan-review-status">Review status<select className="ui-control ui-native-select" value={status} disabled={Boolean(busy)} onChange={(event) => { setStatus(event.target.value as typeof status); setOffsets([0]); setNotice(""); }}><option value="open">Needs review</option><option value="reviewed">Reviewed</option></select></label>
    <p>Check the event and member against your records, then use <RouteLink href="/meetings" currentPath={path} navigate={navigate}>Meetings and attendance</RouteLink> to make any correction. Marking a scan reviewed only records your review note.</p>
    {notice && <p className="ui-status" data-tone="success" role="status">{notice}</p>}
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
    {loading && <p role="status">Loading rejected scans...</p>}
    {page && !page.records.length && <p>No {status === "open" ? "scans need review on this page" : "reviewed scans on this page"}.</p>}
    {page?.records.map((record, index) => {
      const key = reviewKey(record), noteId = `scan-review-note-${index}`, errorId = `scan-review-error-${index}`;
      return <details className="scan-review-record" key={key}>
        <summary>{record.kioskName || record.kioskId} · Member {record.memberId} · {record.reasonCode}</summary>
        <div className="scan-review-evidence">
          <p className="ui-status" data-tone={record.clock?.verified ? "neutral" : "warning"}>{record.clock?.verified ? "The kiosk reported a verified clock. Check the scan against the event before correcting attendance." : "The kiosk clock was unverified or clock evidence is missing. The recorded scan time may be wrong. Do not infer an arrival or departure time from it."}</p>
          <dl><div><dt>Member ID</dt><dd>{record.memberId}</dd></div><div><dt>Event ID</dt><dd>{record.eventId}</dd></div><div><dt>Kiosk ID</dt><dd>{record.kioskId}</dd></div><div><dt>Rejection reason</dt><dd>{record.reasonCode}</dd></div><div><dt>Recorded scan time</dt><dd>{record.occurredAt || "Not supplied"}</dd></div><div><dt>Received by cloud</dt><dd>{record.receivedAt || "Not supplied"}</dd></div>{record.clock?.source && <div><dt>Clock source</dt><dd>{record.clock.source}</dd></div>}{record.clock?.observedAt && <div><dt>Clock evidence time</dt><dd>{record.clock.observedAt}</dd></div>}{record.pairingId && <div><dt>Pairing ID</dt><dd>{record.pairingId}</dd></div>}{record.meetingId && <div><dt>Associated meeting ID</dt><dd>{record.meetingId}</dd></div>}</dl>
          {record.meetingId && <RouteLink href={`/meetings/${encodeURIComponent(record.meetingId)}`} currentPath={path} navigate={navigate}>Open associated meeting attendance</RouteLink>}
          {record.reviewStatus === "reviewed" ? <div><h3>Review note</h3><p className="scan-review-note">{record.reviewNote || "No note supplied"}</p><p>Review recorded by cloud: {record.reviewedAt || "Time not supplied"}</p></div> : <form className="ui-form" onSubmit={(event) => void markReviewed(event, record)}>
            <label htmlFor={noteId}>Review note</label><textarea className="ui-control" id={noteId} required maxLength={500} rows={3} value={notes[key] ?? ""} disabled={Boolean(busy)} aria-invalid={Boolean(rowErrors[key]) || undefined} aria-describedby={rowErrors[key] ? errorId : undefined} onChange={(event) => setNotes((current) => ({ ...current, [key]: event.target.value }))} />
            <p>Describe the correction made, or why no correction is needed.</p>
            {rowErrors[key] && <p className="ui-status" data-tone="error" role="alert" id={errorId}>{rowErrors[key]}</p>}
            <button className="ui-button ui-button--primary" type="submit" disabled={Boolean(busy) || !notes[key]?.trim()}>{busy === key ? "Saving review..." : "Mark reviewed"}</button>
          </form>}
        </div>
      </details>;
    })}
    <div className="scan-review-pages"><button className="ui-button" type="button" disabled={loading || Boolean(busy) || offsets.length === 1} onClick={() => setOffsets((current) => current.slice(0, -1))}>Previous rejected scans</button><button className="ui-button" type="button" disabled={loading || Boolean(busy) || !page?.hasMore || !page.records.length} onClick={() => setOffsets((current) => [...current, offset + (page?.records.length ?? 0)])}>Next rejected scans</button></div>
  </section>;
}
