import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./dashboard-api";
import { RouteLink, usePath } from "./router";
import "./kiosk-scan-reviews.css";

type ScanReview = { kioskId: string; kioskName: string; eventId: string; memberId: string; occurredAt: string; reasonCode: string; reviewStatus: "open" | "reviewed"; receivedAt: string; reviewedAt?: string; reviewNote?: string; clock?: { verified: boolean; observedAt?: string; source?: string }; meetingId?: string; pairingId?: string };
type SelectedScan = Pick<ScanReview, "kioskId" | "eventId">;
type FilterOption = { kioskId: string; kioskName: string; reasonCode: string };
type ReviewPage = { records: ScanReview[]; hasMore: boolean; matchingCount?: number; selection?: SelectedScan[] | null; filters?: FilterOption[] };
const reviewKey = (record: SelectedScan) => JSON.stringify([record.kioskId, record.eventId]);

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
  const [kioskId, setKioskId] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [filters, setFilters] = useState<FilterOption[]>([]);
  const [selected, setSelected] = useState<SelectedScan[]>([]);
  const [bulkNote, setBulkNote] = useState("");
  const [bulkError, setBulkError] = useState("");
  const mutation = useRef(false);
  const offset = offsets.at(-1) ?? 0;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setPage(undefined);
    void api<ReviewPage>(`/admin/kiosks/scan-reviews?${new URLSearchParams({ status, offset: String(offset), kioskId, reasonCode })}`, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) { setPage(result); setFilters(result.filters ?? []); }
    }).catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message || "Could not load rejected scans."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [status, offset, revision, kioskId, reasonCode]);
  function clearSelection() { setSelected([]); setBulkError(""); }
  function changeFilter() { setOffsets([0]); clearSelection(); setNotice(""); }

  async function dismissSelected(event: FormEvent) {
    event.preventDefault();
    if (mutation.current || !selected.length) return;
    const note = bulkNote.trim();
    if (!note || note.length > 500) { setBulkError("Enter a shared review note of 1 to 500 characters."); return; }
    mutation.current = true; setBusy("bulk"); setBulkError(""); setNotice("");
    try {
      const result = await api<{ reviewedCount: number; alreadyReviewedCount: number }>("/admin/kiosks/scan-reviews/review", { method: "POST", body: JSON.stringify({ records: selected, note }) });
      if (!Number.isSafeInteger(result.reviewedCount) || !Number.isSafeInteger(result.alreadyReviewedCount) || result.reviewedCount < 0 || result.alreadyReviewedCount < 0 || result.reviewedCount + result.alreadyReviewedCount !== selected.length) throw new Error("The server did not confirm every selected scan. Refresh before trying again.");
      setNotice(`${result.reviewedCount} ${result.reviewedCount === 1 ? "scan" : "scans"} dismissed.${result.alreadyReviewedCount ? ` ${result.alreadyReviewedCount} ${result.alreadyReviewedCount === 1 ? "was" : "were"} already reviewed; existing notes were preserved.` : ""} Attendance was not changed.`);
      clearSelection(); setBulkNote(""); setOffsets([0]); setRevision(value => value + 1);
    } catch (cause) { setBulkError((cause as Error).message || "Could not dismiss scans. Your selection and note are preserved for retry."); }
    finally { mutation.current = false; setBusy(""); }
  }

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
      clearSelection(); setOffsets([0]);
      setRevision((value) => value + 1);
    } catch (cause) { setRowErrors((current) => ({ ...current, [key]: (cause as Error).message || "Could not mark this scan reviewed. Your note is preserved." })); }
    finally { mutation.current = false; setBusy(""); }
  }

  return <section className="task-card kiosk-scan-reviews" aria-labelledby="scan-reviews-title">
    <div className="panel-heading"><div><h2 id="scan-reviews-title">Rejected scans</h2><p>Review uploaded scan evidence from all kiosks, including retired devices. A rejected scan does not count as attendance.</p></div><button className="ui-button" type="button" disabled={loading || Boolean(busy)} onClick={() => { clearSelection(); setRevision((value) => value + 1); }}>Refresh rejected scans</button></div>
    <div className="scan-review-filters">
      <label className="scan-review-status">Review status<select className="ui-control ui-native-select" value={status} disabled={Boolean(busy)} onChange={(event) => { setStatus(event.target.value as typeof status); changeFilter(); }}><option value="open">Needs review</option><option value="reviewed">Reviewed</option></select></label>
      <label className="scan-review-status">Kiosk<select className="ui-control ui-native-select" value={kioskId} disabled={Boolean(busy)} onChange={event => { setKioskId(event.target.value); changeFilter(); }}><option value="">All kiosks</option>{[...new Map(filters.map(option => [option.kioskId, option])).values()].map(option => <option key={option.kioskId} value={option.kioskId}>{option.kioskName || option.kioskId}</option>)}</select></label>
      <label className="scan-review-status">Rejection reason<select className="ui-control ui-native-select" value={reasonCode} disabled={Boolean(busy)} onChange={event => { setReasonCode(event.target.value); changeFilter(); }}><option value="">All reasons</option>{[...new Set(filters.map(option => option.reasonCode))].sort().map(reason => <option key={reason} value={reason}>{reason}</option>)}</select></label>
    </div>
    <p>Check the event and member against your records, then use <RouteLink href="/meetings" currentPath={path} navigate={navigate}>Meetings and attendance</RouteLink> to make any correction. Marking a scan reviewed only records your review note.</p>
    {notice && <p className="ui-status" data-tone="success" role="status">{notice}</p>}
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
    {loading && <p role="status">Loading rejected scans...</p>}
    {page && <p>{page.matchingCount ?? page.records.length} matching scans.</p>}
    {status === "open" && page && page.records.length > 0 && <div className="scan-review-bulk">
      <div className="scan-review-pages">
        <button className="ui-button" type="button" disabled={Boolean(busy)} onClick={() => { setSelected(page.records.map(({ kioskId, eventId }) => ({ kioskId, eventId }))); setBulkError(""); }}>Select this page</button>
        <button className="ui-button" type="button" disabled={Boolean(busy) || !page.selection?.length} onClick={() => { setSelected(page.selection ?? []); setBulkError(""); }}>Select all matching ({page.matchingCount ?? page.records.length})</button>
        <button className="ui-button" type="button" disabled={Boolean(busy) || !selected.length} onClick={clearSelection}>Clear selection</button>
      </div>
      <p>Dismiss up to 500 scans at once. {page.selection === null ? "More than 500 scans match. Narrow the kiosk or rejection reason, or select a page." : "All matching selects the scans in this loaded view. New uploads are not included."}</p>
    </div>}
    {status === "open" && selected.length > 0 && <form className="ui-form scan-review-bulk" onSubmit={event => void dismissSelected(event)} aria-label="Dismiss selected rejected scans">
      <h3>Dismiss {selected.length} selected {selected.length === 1 ? "scan" : "scans"}?</h3>
      <p>Each selected scan will be marked reviewed with the shared note below. Evidence is retained and attendance is unchanged. Already reviewed scans keep their existing notes.</p>
      <label htmlFor="scan-bulk-note">Shared review note</label><textarea className="ui-control" id="scan-bulk-note" rows={3} maxLength={500} required value={bulkNote} disabled={Boolean(busy)} aria-invalid={Boolean(bulkError) || undefined} aria-describedby={bulkError ? "scan-bulk-error" : undefined} onChange={event => setBulkNote(event.target.value)} />
      {bulkError && <p id="scan-bulk-error" className="ui-status" data-tone="error" role="alert">{bulkError}</p>}
      <button className="ui-button ui-button--primary" type="submit" disabled={loading || Boolean(busy) || !bulkNote.trim()}>{busy === "bulk" ? "Dismissing scans..." : `Dismiss ${selected.length} ${selected.length === 1 ? "scan" : "scans"}`}</button>
    </form>}
    {page && !page.records.length && <p>No {status === "open" ? "scans need review on this page" : "reviewed scans on this page"}.</p>}
    {page?.records.map((record, index) => {
      const key = reviewKey(record), noteId = `scan-review-note-${index}`, errorId = `scan-review-error-${index}`;
      return <div className="scan-review-item" key={key}>
        {record.reviewStatus === "open" && <label className="scan-review-select"><input className="ui-checkbox" type="checkbox" checked={selected.some(value => reviewKey(value) === key)} disabled={Boolean(busy)} onChange={event => { setSelected(current => event.target.checked ? [...current, { kioskId: record.kioskId, eventId: record.eventId }] : current.filter(value => reviewKey(value) !== key)); setBulkError(""); }} />Select scan {record.eventId} from {record.kioskName || record.kioskId}</label>}
        <details className="scan-review-record">
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
      </details></div>;
    })}
    <div className="scan-review-pages"><button className="ui-button" type="button" disabled={loading || Boolean(busy) || offsets.length === 1} onClick={() => { clearSelection(); setOffsets((current) => current.slice(0, -1)); }}>Previous rejected scans</button><button className="ui-button" type="button" disabled={loading || Boolean(busy) || !page?.hasMore || !page.records.length} onClick={() => { clearSelection(); setOffsets((current) => [...current, offset + (page?.records.length ?? 0)]); }}>Next rejected scans</button></div>
  </section>;
}
