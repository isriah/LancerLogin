export function latestTrendPoints<T extends { meetingId: string; startsAt: string }>(points: T[], limit: number): T[] {
  return [...points]
    .sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt) || left.meetingId.localeCompare(right.meetingId))
    .slice(0, limit)
    .reverse();
}

export function reportExportFilename(name: string, detail: boolean, date = new Date()): string {
  const label = name.normalize("NFKC").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 64) || "report";
  return `lancerlogin-${label}-${date.toISOString().slice(0, 10)}${detail ? "-detail" : ""}.csv`;
}
