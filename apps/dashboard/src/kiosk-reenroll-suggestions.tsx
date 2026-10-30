import { useEffect, useState } from "react";
import { api } from "./dashboard-api";
import { RouteLink, usePath } from "./router";

export type ReenrollSuggestion = { rosterId: string; memberId: string; firstName: string; lastName: string; medianScore: number; lowestScore: number; lastScanAt: string };
export type ReenrollSuggestions = { threshold: number; scans: number; members: ReenrollSuggestion[] };

const valid = (value: unknown): value is ReenrollSuggestions => {
  const result = value as ReenrollSuggestions | undefined;
  return Boolean(result && Number.isInteger(result.threshold) && Number.isInteger(result.scans) && Array.isArray(result.members));
};

/** Members whose recent fingerprint matches read weakly. Older APIs without the endpoint report none. */
export async function loadReenrollSuggestions(): Promise<ReenrollSuggestions> {
  const result = await api<unknown>("/admin/kiosks/reenroll-suggestions");
  if (!valid(result)) throw new Error("Re-enrollment suggestions could not be read.");
  return result;
}

/** Admin only. Hides the suggestion until five new scans after now read weakly again. */
export async function dismissReenrollSuggestion(rosterId: string): Promise<ReenrollSuggestions> {
  const result = await api<unknown>(`/admin/kiosks/reenroll-suggestions/${encodeURIComponent(rosterId)}/dismissal`, { method: "POST", body: "{}" });
  if (!valid(result)) throw new Error("Re-enrollment suggestions could not be read.");
  return result;
}

export const reenrollExplanation = (result: Pick<ReenrollSuggestions, "threshold" | "scans">) =>
  `The middle score of their last ${result.scans} accepted fingerprint scans is below ${result.threshold}. Re-enroll their fingerprint so matches stay reliable.`;

/** Kiosks page panel listing every member whose fingerprint should be enrolled again. Admins can dismiss a suggestion. */
export function KioskReenrollSuggestions({ role }: { role: "admin" | "operator" }) {
  const { path, navigate } = usePath();
  const [suggestions, setSuggestions] = useState<ReenrollSuggestions>(), [busy, setBusy] = useState<string>(), [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    loadReenrollSuggestions().then(result => { if (current) setSuggestions(result); }, caught => { if (current) setError((caught as Error).message); });
    return () => { current = false; };
  }, []);
  async function dismiss(member: ReenrollSuggestion) {
    setBusy(member.rosterId); setError("");
    try { setSuggestions(await dismissReenrollSuggestion(member.rosterId)); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(undefined); }
  }
  return <section className="task-card kiosk-reenroll-suggestions" aria-labelledby="kiosk-reenroll-suggestions-title">
    <div className="panel-heading"><div><h3 id="kiosk-reenroll-suggestions-title">Re-enroll suggested</h3><p>{suggestions ? reenrollExplanation(suggestions) : "Members whose fingerprints are reading weakly."}</p></div>{suggestions && <span className="progress-count">{suggestions.members.length} {suggestions.members.length === 1 ? "member" : "members"}</span>}</div>
    {!suggestions && !error && <p role="status">Loading suggestions…</p>}
    {suggestions && (suggestions.members.length ? <ul className="compact-list">{suggestions.members.map(member => <li key={member.rosterId}>
      <RouteLink href={`/roster/${encodeURIComponent(member.memberId)}`} currentPath={path} navigate={navigate} className="member-link"><strong>{member.firstName} {member.lastName}</strong></RouteLink>{" "}
      <span>Middle score {member.medianScore}, lowest {member.lowestScore} · last scan {new Date(member.lastScanAt).toLocaleString()}</span>{" "}
      {role === "admin" && <button className="ui-button" type="button" disabled={Boolean(busy)} aria-label={`Dismiss the re-enrollment suggestion for ${member.firstName} ${member.lastName}`} onClick={() => void dismiss(member)}>{busy === member.rosterId ? "Dismissing…" : "Dismiss"}</button>}
    </li>)}</ul> : <p className="empty-state">No members need their fingerprint re-enrolled.</p>)}
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
  </section>;
}
