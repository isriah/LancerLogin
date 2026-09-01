const requiredHeaders = ["memberId", "firstName", "lastName"];

export function parseRosterCsv(input) {
  const lines = String(input).trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { rows: [], errors: [{ row: 0, message: "CSV is empty" }] };
  const headers = lines[0].split(",").map((value) => value.trim());
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (missing.length) return { rows: [], errors: [{ row: 1, message: `Missing required columns: ${missing.join(", ")}` }] };
  const seen = new Set(); const rows = []; const errors = []; const warnings = [];
  for (let index = 1; index < lines.length; index += 1) {
    const values = lines[index].split(",").map((value) => value.trim());
    const row = Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""]));
    const number = index + 1;
    if (!row.memberId || !row.firstName || !row.lastName) { errors.push({ row: number, message: "memberId, firstName, and lastName are required" }); continue; }
    if (seen.has(row.memberId)) { errors.push({ row: number, message: `Duplicate memberId: ${row.memberId}` }); continue; }
    seen.add(row.memberId);
    if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) { errors.push({ row: number, message: "Invalid email" }); continue; }
    const discordUserId = row.discordUserId && /^\d{10,24}$/.test(row.discordUserId) ? row.discordUserId : undefined;
    if (row.discordUserId && !discordUserId) warnings.push({ row: number, message: "Optional Discord user ID was ignored; link Discord later" });
    rows.push({ memberId: row.memberId, firstName: row.firstName, lastName: row.lastName, email: row.email || undefined, discordUserId });
  }
  return { rows: errors.length ? [] : rows, errors, warnings };
}
