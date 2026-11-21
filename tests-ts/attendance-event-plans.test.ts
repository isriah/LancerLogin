// quick-check: covers apps/api/migrations/**
// Pins how SQLite reads attendance_events for the statements that matter, on the reference installation (150 members, 900
// meetings, 54,000 scans), both without statistics, as most D1 databases in the field are, and after ANALYZE.
//
// attendance_events is the table that grows with every scan, and each of its indexes is one more row written per scan
// against D1 Free's 100,000 a day. Migration 0106 dropped idx_attendance_member_meeting because
// idx_events_member_meeting_action_time starts with the same two columns. Before adding, dropping or changing an index
// here, compare EXPLAIN QUERY PLAN before and after for every statement that touches the table, in both states, and
// update these plans and restoreWriteCosts (packages/shared/src/restore-writes.ts) with it. The statements are read
// from the source, so a reworded query is checked as it is now written. Plans are those of the SQLite in the pinned Node.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { InstallationSeed, TestD1Database } from "./fixtures/d1-database.ts";
import { referenceInstallationSql } from "./fixtures/reference-installation.ts";

const sources = new Map<string, string>();
/** The SQL string literal in an API source file that contains `marker`, up to any `${...}` it builds on. */
function statement(file: string, marker: string): string {
  const source = sources.get(file) ?? readFileSync(new URL(`../apps/api/src/${file}`, import.meta.url), "utf8"); sources.set(file, source);
  assert.equal(source.split(marker).length, 2, `${file} should contain exactly once: ${marker}`);
  const at = source.indexOf(marker); const quote = source.lastIndexOf("`", at) > source.lastIndexOf('"', at) ? "`" : '"';
  return source.slice(source.lastIndexOf(quote, at) + 1, source.indexOf(quote, at)).replace(/\s+/g, " ");
}
const cut = (sql: string) => sql.slice(0, sql.indexOf("${"));
const policy = statement("index.ts", "SELECT e.meeting_id AS meetingId, e.member_id AS memberId, e.action");
const contests = statement("index.ts", "AS hasRawCheckIn");

const statements: Record<string, string> = {
  "scan already recorded": statement("index.ts", "SELECT action FROM attendance_events WHERE installation_id = 'primary' AND kiosk_event_id = ?\""),
  "member's scans of a meeting": statement("index.ts", "SELECT id, action, occurred_at AS occurredAt FROM attendance_events"),
  "record a scan": cut(statement("index.ts", "INSERT OR IGNORE INTO attendance_events")) + "VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?)",
  "meeting attendance": statement("index.ts", "SELECT m.id AS memberId, m.external_id AS externalId, m.first_name AS firstName, m.last_name AS lastName, m.discord_user_id"),
  "member history": statement("index.ts", "SELECT meeting.id AS meetingId, meeting.title"),
  "clear a member's attendance at a meeting": statement("index.ts", "DELETE FROM attendance_events WHERE installation_id = 'primary' AND member_id = ? AND meeting_id = ? RETURNING id"),
  "report, everyone": policy,
  "report, one member": policy.replace(" ORDER BY", " AND e.member_id = ? ORDER BY"),
  "report, one meeting": policy.replace(" ORDER BY", " AND e.meeting_id = ? ORDER BY"),
  "anomaly report": statement("index.ts", "AS checkedInAt, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.installation_id = m.installation_id"),
  "contests": contests.replace("${where}", ""),
  "contests of a meeting": contests.replace("${where}", "AND c.meeting_id = ?"),
  "member's references": cut(statement("index.ts", "SELECT (SELECT COUNT(*) FROM attendance_events WHERE member_id = ?)")),
  "members with history": cut(statement("index.ts", "SELECT COUNT(*) AS count FROM members m WHERE m.installation_id = 'primary' AND (EXISTS (SELECT 1 FROM attendance_events e")) + ")",
  "schema 1 check-outs": statement("index.ts", "SELECT 'legacy-restore-checkout:'"),
  "scan accepted for a member": statement("scan-integrity.ts", "INSERT OR IGNORE INTO kiosk_accepted_scans"),
  // The foreign key check SQLite runs on attendance_events when a member is removed.
  "delete a member": "DELETE FROM members WHERE id = ?",
};

const memberMeeting = "USING INDEX idx_events_member_meeting_action_time (member_id=? AND meeting_id=?)";
const memberMeetingAction = "USING INDEX idx_events_member_meeting_action_time (member_id=? AND meeting_id=? AND action=?)";
const member = "USING INDEX idx_events_member_meeting_action_time (member_id=?)";
const scanId = "USING INDEX sqlite_autoindex_attendance_events_2 (kiosk_event_id=?)";
const installationMember = "USING INDEX idx_events_installation_member_time (installation_id=? AND member_id=?)";
const installationMeeting = "USING INDEX idx_events_installation_meeting (installation_id=? AND meeting_id=?)";
const sort = "USE TEMP B-TREE FOR ORDER BY";
/** Statements that list events in order: their sorts are pinned too. The other statements sort members or contests. */
const ordersEvents = new Set(["member's scans of a meeting", "report, everyone", "report, one member", "report, one meeting"]);

/**
 * How each statement reads attendance_events: [without statistics, after ANALYZE], or one plan when both are the same.
 * COVERING and EXISTS are left out of the lines, and so are the other tables a statement reads.
 */
const expected: Record<string, string[] | [string[], string[]]> = {
  "scan already recorded": [`SEARCH attendance_events ${scanId}`],
  // Without statistics the member's scans are read in time order (about 360 for a three-season member); with them, the two of the meeting.
  "member's scans of a meeting": [[`SEARCH attendance_events ${installationMember}`], [`SEARCH attendance_events ${memberMeeting}`, sort]],
  "record a scan": [],
  "meeting attendance": [`SEARCH e ${memberMeetingAction}`, `SEARCH e ${memberMeetingAction}`],
  "member history": [`SEARCH e ${memberMeetingAction}`, `SEARCH e ${memberMeetingAction}`],
  "clear a member's attendance at a meeting": [[`SEARCH attendance_events ${installationMember}`], [`SEARCH attendance_events ${memberMeeting}`]],
  "report, everyone": [["SEARCH e USING INDEX idx_events_installation_member_time (installation_id=?)", sort], [`SEARCH e ${installationMeeting}`, sort]],
  "report, one member": [`SEARCH e ${installationMember}`],
  "report, one meeting": [`SEARCH e ${installationMeeting}`],
  "anomaly report": [[`SEARCH e ${installationMember}`, `SEARCH e ${installationMember}`, `SEARCH e ${memberMeetingAction}`, `SEARCH e ${memberMeetingAction}`], [`SEARCH e ${memberMeeting}`, `SEARCH e ${memberMeeting}`, `SEARCH e ${memberMeetingAction}`, `SEARCH e ${memberMeetingAction}`]],
  "contests": [`SEARCH check_in ${memberMeetingAction}`, `SEARCH check_out ${memberMeetingAction}`],
  "contests of a meeting": [`SEARCH check_in ${memberMeetingAction}`, `SEARCH check_out ${memberMeetingAction}`],
  "member's references": [`SEARCH attendance_events ${member}`],
  "members with history": [`SEARCH e ${member}`],
  // Each event looks up its member's scans of the same meeting (two rows). Once statistics say the table is all one
  // installation, the outer pass over every event is a plain scan.
  "schema 1 check-outs": [["SEARCH e USING INDEX idx_events_installation_meeting (installation_id=? AND meeting_id>?)", `SEARCH o ${memberMeeting}`], ["SCAN e", `SEARCH o ${memberMeeting}`]],
  "scan accepted for a member": [`SEARCH attendance_events ${scanId}`],
  "delete a member": [`SEARCH attendance_events ${member}`],
};

test("attendance_events keeps its five indexes and the query plans that rely on them", () => {
  const database = new TestD1Database({ seed: new InstallationSeed("2024-08-15T00:00:00.000Z").users("admin").organization() });
  try {
    const sqlite = database.sqlite; for (const sql of referenceInstallationSql()) sqlite.exec(sql);
    assert.deepEqual((sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'attendance_events' ORDER BY name").all() as { name: string }[]).map((row) => row.name),
      ["idx_events_installation_meeting", "idx_events_installation_member_time", "idx_events_member_meeting_action_time", "sqlite_autoindex_attendance_events_1", "sqlite_autoindex_attendance_events_2"]);
    const plans = () => Object.fromEntries(Object.entries(statements).map(([name, sql]) => [name, (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((row) => row.detail)
      .filter((line) => /^(SEARCH|SCAN) (attendance_events|e|o|check_in|check_out)\b|MULTI-INDEX/.test(line) || (ordersEvents.has(name) && line.includes("TEMP B-TREE"))).map((line) => line.replace(" EXISTS USING ", " USING ").replace("USING COVERING INDEX", "USING INDEX"))]));
    const actual = [plans()]; sqlite.exec("ANALYZE"); actual.push(plans());
    if (process.env.PRINT_PLANS) console.log(JSON.stringify(actual, null, 1));
    for (const [name, plan] of Object.entries(expected)) {
      const [without, analyzed] = (Array.isArray(plan[0]) ? plan : [plan, plan]) as [string[], string[]];
      assert.deepEqual(actual[0]![name], without, `${name}, without statistics`);
      assert.deepEqual(actual[1]![name], analyzed, `${name}, after ANALYZE`);
    }
    assert.deepEqual(Object.keys(expected), Object.keys(statements));
    // Every read of the table is an index search, except the schema 1 restore's one pass over every event.
    for (const [index, state] of actual.entries()) for (const [name, plan] of Object.entries(state)) for (const line of plan) assert.ok(line.startsWith("SEARCH") || line === sort || (index === 1 && name === "schema 1 check-outs" && line === "SCAN e"), `${name}: ${line}`);
  } finally { database.close(); }
});
