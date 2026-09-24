export type MemberLabel = { id: string; name: string; active: boolean | number; formulaEnabled: boolean | number };
export type LabelHistory = { id: string; memberId: string; externalMemberId: string; labelId: string; action: "add" | "remove"; effectiveDate: string; createdAt: string };
export type WeeklyPeriod = { id: string; labelId: string; startsOn: string; endsOn: string; meetingsPerWeek: number };
export type LabelData = { labels: MemberLabel[]; history: LabelHistory[]; periods: WeeklyPeriod[]; today: string };
type Change = { memberId: string; label: string; action: "add" | "remove"; effectiveDate: string };
type Preview = { changes: Change[]; impact: { memberId: string; beforeRate: number | null; afterRate: number | null; beforePolicy: string; afterPolicy: string; affectedCompletedMeetings: number }[]; previewToken: string };

export function labelsForMember(data: LabelData, memberId: string, date = data.today): MemberLabel[] {
  const active = new Set<string>();
  for (const change of data.history.filter((item) => item.memberId === memberId && item.effectiveDate <= date).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.createdAt.localeCompare(b.createdAt))) {
    if (change.action === "add") active.add(change.labelId); else active.delete(change.labelId);
  }
  return data.labels.filter((label) => active.has(label.id));
}
function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index++) { const char = text[index]; if (char === '"' && quoted && text[index + 1] === '"') { cell += '"'; index++; } else if (char === '"') quoted = !quoted; else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; } else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && text[index + 1] === "\n") index++; row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; } else cell += char; }
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); if (quoted) throw new Error("CSV has an unclosed quoted value."); return rows;
}
export function parseLabelChangesCsv(text: string): Change[] {
  const rows = csvRows(text.replace(/^\uFEFF/, "")); const header = rows.shift(); const required = ["memberId", "label", "action", "effectiveDate"];
  if (!header || required.slice(0, 2).some((name) => !header.includes(name))) throw new Error("CSV header must include memberId,label. action and effectiveDate are optional.");
  if (rows.length < 1 || rows.length > 500) throw new Error("CSV must contain 1 to 500 changes.");
  return rows.map((row, index) => { const value = Object.fromEntries(header.map((name, column) => [name, row[column] ?? ""])); const action = value.action || "add"; const effectiveDate = value.effectiveDate || ""; if (!value.memberId || !value.label || !["add", "remove"].includes(action) || (effectiveDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate))) throw new Error(`CSV row ${index + 2} needs a member ID, label, optional add/remove action, and optional YYYY-MM-DD date.`); return { memberId: value.memberId, label: value.label, action: action as Change["action"], effectiveDate }; });
}
