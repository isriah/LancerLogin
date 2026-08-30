import { useState } from "react";

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
type Scope = "attendance" | "roster" | "installation";
const details: Record<Scope, { label: string; confirmation: string; detail: string }> = {
  attendance: { label: "Delete meetings & attendance", confirmation: "DELETE ATTENDANCE", detail: "Deletes meetings, scans, corrections, excuses, and Discord contests. Keeps roster, users, settings, and audit history." },
  roster: { label: "Delete roster & attendance", confirmation: "DELETE ROSTER", detail: "Deletes the roster plus all meeting and attendance data that references it. Keeps users, settings, and audit history." },
  installation: { label: "Delete entire installation", confirmation: "DELETE INSTALLATION", detail: "Deletes the installation and all D1 records through cascade. The dashboard returns to first-Admin setup; the kiosk must be paired again." },
};

export function DataSettings() {
  const [notice, setNotice] = useState("Export a D1 backup before deleting retained data.");
  async function remove(scope: Scope) { if (!window.confirm("This deletion is permanent. Have you exported the data you need and are you ready to continue?")) return; const confirmation = window.prompt(`Type ${details[scope].confirmation} exactly to continue.`); if (confirmation === null) return; const result = await fetch(`${apiBaseUrl}/admin/data`, { method: "DELETE", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, confirmation }) }); const body = await result.json() as { error?: string }; if (!result.ok) { setNotice(body.error ?? "Deletion failed"); return; } if (scope === "installation") window.location.reload(); else setNotice(`${details[scope].label} completed.`); }
  return <section className="data-section" aria-labelledby="data-title"><div className="section-intro"><p className="kicker">Retention & deletion</p><h2 id="data-title">Export or delete your data</h2><p>Data remains in your adopter-owned D1 database until an Admin deletes it. Exporting creates a copy and does not remove the stored data. CSV covers attendance; Wrangler D1 export covers full backup and restore.</p><span role="status">{notice}</span></div><div className="destructive-grid">{(["attendance", "roster", "installation"] as const).map((scope) => <article key={scope}><h3>{details[scope].label}</h3><p>{details[scope].detail}</p><button type="button" onClick={() => remove(scope)}>{details[scope].label}</button></article>)}</div></section>;
}
