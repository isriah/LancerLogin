import { useEffect, useState } from "react";
import { api } from "./dashboard-api";

type Scan = { kioskId: string; kioskName: string | null; occurredAt: string; matchScore: number | null };
export type PossibleWrongMatch = { eventId: string; recordedAt: string; member: { id: string; memberId: string | null; displayName: string | null }; scan: Scan; acceptedScan: Scan & { eventId: string } };
export type PossibleWrongMatches = { windowSeconds: number; matches: PossibleWrongMatch[] };

const valid = (value: unknown): value is PossibleWrongMatches => {
  const result = value as PossibleWrongMatches | undefined;
  return Boolean(result && Number.isInteger(result.windowSeconds) && Array.isArray(result.matches));
};
const kiosk = (scan: Scan) => scan.kioskName ?? "Removed kiosk";
const score = (scan: Scan) => scan.matchScore === null ? "no score" : `score ${scan.matchScore}`;
const apart = (match: PossibleWrongMatch) => Math.round(Math.abs(Date.parse(match.scan.occurredAt) - Date.parse(match.acceptedScan.occurredAt)) / 1000);

/**
 * Admin diagnostics panel. Lists recent kiosk scans that were refused because the matched member had an accepted scan
 * on a different kiosk seconds apart: the reader probably matched someone else's finger, and the kiosk asked for a rescan.
 */
export function KioskPossibleWrongMatches() {
  const [result, setResult] = useState<PossibleWrongMatches>(), [busy, setBusy] = useState(true), [error, setError] = useState("");
  async function load() {
    setBusy(true); setError("");
    try {
      const value = await api<unknown>("/admin/kiosks/possible-wrong-matches");
      if (!valid(value)) throw new Error("Possible wrong matches could not be read.");
      setResult(value);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  return <section className="task-card kiosk-possible-wrong-matches" aria-labelledby="kiosk-possible-wrong-matches-title">
    <div className="panel-heading"><div><h3 id="kiosk-possible-wrong-matches-title">Possible wrong matches</h3><p>Scans refused because the same member had just scanned on a different kiosk{result ? `, less than ${result.windowSeconds} seconds apart` : ""}. The reader probably matched someone else's finger, so the kiosk asked them to scan again and nothing was recorded.</p></div>
      <button className="ui-button" type="button" disabled={busy} onClick={() => void load()}>{busy && result ? "Refreshing…" : "Refresh"}</button></div>
    {!result && busy && <p role="status">Loading possible wrong matches…</p>}
    {result && (result.matches.length ? <ul className="compact-list">{result.matches.map(match => <li key={match.eventId}>
      <strong>{match.member.displayName ?? "Removed member"}</strong>{match.member.memberId ? <> (<code>{match.member.memberId}</code>)</> : null}:{" "}
      matched on {kiosk(match.scan)} at {new Date(match.scan.occurredAt).toLocaleString()} ({score(match.scan)}),{" "}
      {apart(match)} seconds from their accepted scan on {kiosk(match.acceptedScan)} at {new Date(match.acceptedScan.occurredAt).toLocaleString()} ({score(match.acceptedScan)}).
    </li>)}</ul> : <p className="empty-state">No possible wrong matches in the last 90 days.</p>)}
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
  </section>;
}
