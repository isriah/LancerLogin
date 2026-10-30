import { useEffect, useState, type FormEvent } from "react";
import { api } from "./dashboard-api";

type Recent = { days: number; scans: number; lowest: number | null; below50: number; below100: number; below150: number; below200: number };
type Match = { minimumScore: number; recent: Recent };
type Notice = { message: string; tone: "success" | "error" };

const valid = (value: unknown): value is Match => {
  const match = value as Match | undefined, recent = match?.recent;
  return Boolean(match && Number.isInteger(match.minimumScore) && recent && Number.isInteger(recent.scans) && (recent.lowest === null || Number.isInteger(recent.lowest)));
};
const share = (count: number, total: number) => total ? `${count} (${Math.round(count / total * 100)}%)` : "0";

// The reader reports a score with every fingerprint match. A minimum score makes the kiosk ask for a rescan on weak
// matches, which can be another member's finger, instead of checking that member in or out. This panel sits in Debug
// tools; kiosks enforce the saved minimum whether or not Debug mode is on.
export function KioskFingerprintMatch() {
  const [match, setMatch] = useState<Match>(), [value, setValue] = useState(""), [busy, setBusy] = useState(true), [notice, setNotice] = useState<Notice>();
  function apply(result: unknown) {
    if (!valid(result)) throw new Error("Fingerprint match settings could not be read.");
    setMatch(result); setValue(String(result.minimumScore));
  }
  useEffect(() => {
    let current = true;
    api<Match>("/admin/kiosks/fingerprint-match").then(result => { if (current) apply(result); }, error => { if (current) setNotice({ message: (error as Error).message, tone: "error" }); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(undefined);
    try {
      apply(await api<Match>("/admin/kiosks/fingerprint-match", { method: "PUT", body: JSON.stringify({ minimumScore: Number(value) }) }));
      setNotice({ message: Number(value) ? `Saved. Kiosks ask for a rescan below ${value} within a minute.` : "Saved. Kiosks accept every match the reader reports.", tone: "success" });
    } catch (error) { setNotice({ message: (error as Error).message, tone: "error" }); }
    finally { setBusy(false); }
  }
  const recent = match?.recent;
  return <section className="task-card kiosk-fingerprint-match" aria-labelledby="fingerprint-match-title">
    <div className="panel-heading"><div><h3 id="fingerprint-match-title">Fingerprint matching</h3><p>Each fingerprint match has a score; a weak match can be another member's finger. Below the minimum, the kiosk asks the member to try again instead of checking them in or out.</p></div></div>
    {recent && <dl className="kiosk-diagnostics">
      <div><dt>Scans in the last {recent.days} days</dt><dd>{recent.scans}</dd></div>
      <div><dt>Lowest score</dt><dd>{recent.lowest ?? "None yet"}</dd></div>
      <div><dt>Below 50</dt><dd>{share(recent.below50, recent.scans)}</dd></div>
      <div><dt>Below 100</dt><dd>{share(recent.below100, recent.scans)}</dd></div>
      <div><dt>Below 150</dt><dd>{share(recent.below150, recent.scans)}</dd></div>
      <div><dt>Below 200</dt><dd>{share(recent.below200, recent.scans)}</dd></div>
    </dl>}
    {recent && !recent.scans && <p>Scores appear after kiosks running 2.0.0-beta.14 or later record scans.</p>}
    <form className="ui-form kiosk-fingerprint-match-form" onSubmit={event => void save(event)}>
      <label htmlFor="fingerprint-minimum-score">Minimum match score<input className="ui-control" id="fingerprint-minimum-score" type="number" inputMode="numeric" min={0} max={1000} step={1} required value={value} disabled={busy || !match} onChange={event => setValue(event.target.value)} /></label>
      <small>0 accepts every match the reader reports. Choose a value below the scores members normally get, so only weak matches are asked to rescan.</small>
      <button className="ui-button ui-button--primary" type="submit" disabled={busy || !match || value === String(match.minimumScore)}>{busy && match ? "Saving..." : "Save minimum score"}</button>
    </form>
    {notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p>}
  </section>;
}
