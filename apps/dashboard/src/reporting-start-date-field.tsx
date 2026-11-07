import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "./dashboard-api";
import { futureReportingStartWarning, reportingStartHelp, reportingStartLabel } from "./reporting-baseline";

type ReportBaseline = { moduleId: string; label: string; startsOn: string | null; revision: number; timeZone: string; today: string };

/**
 * A module's reporting start date (operational baseline), for an Admin-only module settings page. The module's report
 * datasets use it for the Operational baseline period. Core stores the date; the plugin only places this card.
 */
export function ReportingStartDateField({ moduleId }: { moduleId: string }) {
  const id = useId();
  const [stored, setStored] = useState<ReportBaseline>(); const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false); const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string }>();
  const path = `/admin/modules/${encodeURIComponent(moduleId)}/report-baseline`;
  useEffect(() => {
    let current = true;
    void api<ReportBaseline>(path).then((result) => { if (current) { setStored(result); setValue(result.startsOn ?? ""); } }).catch((error: Error) => { if (current) setNotice({ tone: "error", text: error.message }); });
    return () => { current = false; };
  }, [path]);
  const moduleLabel = stored?.label ?? "";
  const warning = stored ? futureReportingStartWarning(value, stored.timeZone, moduleLabel) : undefined;
  async function save(event: FormEvent) {
    event.preventDefault(); if (!stored || saving) return; setSaving(true); setNotice(undefined);
    try { const result = await api<ReportBaseline>(path, { method: "PUT", body: JSON.stringify({ startsOn: value || null, revision: stored.revision }) }); setStored(result); setValue(result.startsOn ?? ""); setNotice({ tone: "success", text: "Reporting start date saved." }); }
    catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setSaving(false); }
  }
  return <article className="ui-card reporting-start-date-card" aria-labelledby={`${id}-title`}>
    <div><h2 id={`${id}-title`}>Reporting start date</h2>{stored && <p id={`${id}-help`}>{reportingStartHelp(moduleLabel)}</p>}</div>
    {!stored ? !notice && <p className="ui-status" role="status">Loading reporting start date…</p> : <form className="ui-form" onSubmit={(event) => void save(event)}>
      <label>{reportingStartLabel(moduleLabel)} <span>(optional)</span><input className="ui-control" type="date" value={value} disabled={saving || !stored} aria-describedby={warning ? `${id}-help ${id}-warning` : `${id}-help`} onChange={(event) => setValue(event.target.value)} /></label>
      {warning && <p id={`${id}-warning`} className="ui-status" data-tone="warning" role="status">{warning}</p>}
      <div><button className="ui-button ui-button--primary" type="submit" disabled={saving || !stored || value === (stored.startsOn ?? "")}>{saving ? "Saving…" : "Save reporting start date"}</button></div>
    </form>}
    {notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
  </article>;
}
