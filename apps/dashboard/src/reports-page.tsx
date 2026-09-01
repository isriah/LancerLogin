import { useState } from "react";
import { apiBaseUrl } from "./dashboard-api";

export function ReportsPage() {
  const [notice, setNotice] = useState("Exports are generated from the current D1 data when requested.");
  async function downloadCsv() { const result = await fetch(`${apiBaseUrl}/exports/attendance.csv`, { credentials: "include" }); if (!result.ok) { setNotice("Attendance CSV export failed."); return; } const blob = await result.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `lancerlogin-attendance-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url); setNotice("Attendance CSV downloaded."); }
  return <section className="page-stack" aria-labelledby="reports-title"><div className="page-intro"><p className="kicker">Operations</p><h2 id="reports-title">Reports</h2><p>Download spreadsheet-safe attendance data. Backups and destructive data controls remain in Admin Settings.</p></div><p className="setup-status" role="status">{notice}</p><article className="task-card report-card"><h3>Attendance CSV</h3><p>Includes each meeting/member disposition and labels setup-generated test meetings. Values that could be interpreted as spreadsheet formulas are escaped.</p><button className="primary-button" type="button" onClick={downloadCsv}>Download attendance CSV</button></article></section>;
}
