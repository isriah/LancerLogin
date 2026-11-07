// quick-check: covers apps/api/src/report-builder.ts
import test from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { TestD1Database } from "./fixtures/d1-database.ts";
import { labelSetDefinition, labelSetSeedSql } from "./fixtures/attendance-label-sets.ts";

const secret = "A".repeat(43);
async function installation() {
  const database = new TestD1Database({ seed: labelSetSeedSql() });
  const env: Env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: secret, DB: database };
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  const fetch = (path: string, body?: object) => worker.fetch(new Request(`https://example.test${path}`, { method: body ? "POST" : "GET", headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  return { database, fetch };
}
type Cell = { text: string; sortValue: string | number | null; exportText?: string; status?: string; empty?: boolean };
type Query = { columns: { id: string; label: string }[]; rows: { label: string; cells: Record<string, Cell> }[] };
const twoSets = labelSetDefinition([{ labelId: "robotics" }, { labelId: "build" }]);
const set = (labelId: string, weekly = false) => ["rate", "target", "status", "attended", weekly ? "weeks-met" : "counted", "excused"].map((field) => `attendance.label.${field}:${labelId}`);

test("label column sets show each policy's rate, target, status and plain meeting counts for the report period", async () => {
  const { database, fetch } = await installation();
  try {
    const response = await fetch("/reports/query", { definition: twoSets, pageSize: "all" });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as Query;
    assert.deepEqual(result.columns.map((column) => column.label), ["Member", "Overall rate",
      ...["Attendance rate", "Target", "Status", "Meetings attended", "Meetings counted", "Excused"].map((name) => `Test Robotics Class - ${name}`),
      ...["Attendance rate", "Target", "Status", "Meetings attended", "Meetings counted", "Excused"].map((name) => `Test Build Team - ${name}`)]);
    const texts = (row: Query["rows"][number]) => [row.cells["attendance.member.regular-rate"]!.text, ...set("robotics").map((id) => row.cells[id]!.text), ...set("build").map((id) => row.cells[id]!.text)];
    // Ranked by Overall rate; Test Student D has no required meetings yet, so sorts last.
    assert.deepEqual(result.rows.map((row) => [row.label, ...texts(row)]), [
      // Every meeting attended.
      ["Test Student B", "100%", "100%", "80%", "Met", "5", "5", "0", "100%", "75%", "Met", "5", "5", "0"],
      // 4 of 6 weighted meetings (the build day counts double). Robotics leaves the excused meeting out: 4 of 5 = 80%;
      // Build counts it as missed: 4 of 6. Counts stay plain meetings: 3 attended, 4 or 5 counted, 1 excused.
      ["Test Student A", "66.7%", "80%", "80%", "Met", "3", "4", "1", "66.7%", "75%", "Below target", "3", "5", "1"],
      // Doesn't hold Test Build Team, so that set is No policy with empty cells.
      ["Test Student C", "33.3%", "33.3%", "80%", "Below target", "2", "5", "0", "", "", "No policy", "", "", ""],
      ["Test Student D", "", "", "80%", "Not enough meetings yet", "0", "0", "0", "", "75%", "Not enough meetings yet", "0", "0", "0"],
    ]);
    const a = result.rows[1]!.cells;
    assert.deepEqual(a["attendance.label.status:build"], { text: "Below target", sortValue: "below", status: "below", empty: false });
    assert.deepEqual(a["attendance.label.rate:build"], { text: "66.7%", sortValue: 66.7, exportText: "66.7" });
    // Report filters work on the set columns, shown or not.
    const filtered = await (await fetch("/reports/query", { definition: { ...twoSets, columnFilters: [{ column: { key: "attendance.label.status", labelId: "build" }, operator: "equals", value: "Below target" }] } })).json() as Query;
    assert.deepEqual(filtered.rows.map((row) => row.label), ["Test Student A"]);
    const hidden = labelSetDefinition([{ labelId: "robotics" }], { columnFilters: [{ column: { key: "attendance.label.rate", labelId: "build" }, operator: "minimum", value: "75" }] });
    const hiddenResult = await (await fetch("/reports/query", { definition: hidden })).json() as Query;
    assert.deepEqual(hiddenResult.rows.map((row) => row.label), ["Test Student B"]);
    assert.equal(hiddenResult.rows[0]!.cells["attendance.label.rate:build"], undefined);
    // A meetings-per-week label: weeks met ÷ weeks due, a "2 per week" target and Weeks met in place of Meetings counted.
    const weekly = await (await fetch("/reports/query", { definition: labelSetDefinition([{ labelId: "outreach", weekly: true }]) })).json() as Query;
    assert.deepEqual(weekly.rows.map((row) => [row.label, ...set("outreach", true).map((id) => row.cells[id]!.text)]), [["Test Student E", "66.7%", "2 per week", "Below target", "4", "2", "0"]]);
    assert.equal(weekly.columns.at(-2)!.label, "Test Outreach Crew - Weeks met");
  } finally { database.close(); }
});

test("label column sets add no D1 queries per label or per member", async () => {
  const reads = async (definition: object) => {
    const { database, fetch } = await installation();
    try {
      const response = await fetch("/reports/query", { definition, pageSize: "all" });
      assert.equal(response.status, 200, await response.clone().text());
      return database.reads;
    } finally { database.close(); }
  };
  const plain = await reads({ ...twoSets, columns: twoSets.columns.slice(0, 2) });
  const one = await reads(labelSetDefinition([{ labelId: "robotics" }]));
  const three = await reads(labelSetDefinition([{ labelId: "robotics" }, { labelId: "build" }, { labelId: "outreach", weekly: true }], { labelIds: [] }));
  assert.equal(one, plain, "one label set reads what the report reads without it");
  assert.equal(three, plain, "three label sets over every member read the same");
  assert.ok(three <= 50, `a report run stays within the Free plan's 50 D1 queries (read ${three})`);
  // Export adds one query for every label's policy type, whatever the number of sets.
  const exportReads = async (definition: object) => {
    const { database, fetch } = await installation();
    try { assert.equal((await fetch("/exports/report.csv", { definition })).status, 200); return database.reads; } finally { database.close(); }
  };
  assert.equal(await exportReads(labelSetDefinition([{ labelId: "robotics" }, { labelId: "build" }, { labelId: "outreach", weekly: true }], { labelIds: [] })), await exportReads(labelSetDefinition([{ labelId: "robotics" }])));
});

test("the report CSV has plain numbers, labelled units, a Member ID column and empty cells for no value", async () => {
  const { database, fetch } = await installation();
  try {
    const response = await fetch("/exports/report.csv", { definition: twoSets });
    assert.equal(response.status, 200);
    const names = ["Attendance rate (%)", "Target (%)", "Status", "Meetings attended", "Meetings counted", "Excused meetings"];
    assert.equal(await response.text(), [
      ["Member", "Member ID", "Overall rate (%)", ...names.map((name) => `Test Robotics Class - ${name}`), ...names.map((name) => `Test Build Team - ${name}`)].join(","),
      "Test Student B,TEST-002,100.0,100.0,80,Met,5,5,0,100.0,75,Met,5,5,0",
      "Test Student A,TEST-001,66.7,80.0,80,Met,3,4,1,66.7,75,Below target,3,5,1",
      "Test Student C,TEST-003,33.3,33.3,80,Below target,2,5,0,,,No policy,,,",
      "Test Student D,TEST-004,,,80,Not enough meetings yet,0,0,0,,75,Not enough meetings yet,0,0,0",
      "",
    ].join("\r\n"));
    const weekly = await (await fetch("/exports/report.csv", { definition: labelSetDefinition([{ labelId: "outreach", weekly: true }]) })).text();
    assert.match(weekly, /^Member,Member ID,Overall rate \(%\),Test Outreach Crew - Attendance rate \(%\),Test Outreach Crew - Target \(meetings per week\),Test Outreach Crew - Status,Test Outreach Crew - Meetings attended,Test Outreach Crew - Weeks met,Test Outreach Crew - Excused meetings\r\nTest Student E,TEST-005,66.7,66.7,2,Below target,4,2,0\r\n$/);
    // A report without label sets keeps its columns; only Overall rate becomes a plain number.
    const plain = await (await fetch("/exports/report.csv", { definition: { ...twoSets, columns: twoSets.columns.slice(0, 2) } })).text();
    assert.match(plain, /^Member,Overall rate \(%\)\r\nTest Student B,100\.0\r\n/);
  } finally { database.close(); }
});

test("the catalog lists each label's policy today and the Leaderboard ranks one label by its Attendance rate", async () => {
  const { database, fetch } = await installation();
  try {
    const catalog = await (await fetch("/reports/catalog")).json() as { labelPolicies: unknown[]; columns: { key: string; label: string; group: string; requiresLabel?: boolean }[] };
    assert.deepEqual(catalog.labelPolicies, [
      { labelId: "build", ruleType: "weighted_percentage", target: 75, excusedHandling: "count_missed", weighted: true },
      { labelId: "outreach", ruleType: "weekly_count", target: 2, excusedHandling: null, weighted: false },
      { labelId: "robotics", ruleType: "weighted_percentage", target: 80, excusedHandling: "exclude", weighted: true },
    ]);
    assert.deepEqual(catalog.columns.filter((column) => column.key.startsWith("attendance.label.")).map((column) => [column.key, column.label, column.group, column.requiresLabel]), [
      ["attendance.label.rate", "Attendance rate"], ["attendance.label.target", "Target"], ["attendance.label.status", "Status"], ["attendance.label.attended", "Meetings attended"], ["attendance.label.counted", "Meetings counted"], ["attendance.label.weeks-met", "Weeks met"], ["attendance.label.excused", "Excused"],
    ].map(([key, label]) => [key, label, "Attendance policies (per label)", true]));
    type Board = { members: { member: { lastName: string }; regularAttendance: { preciseRate: number | null }; labelResult?: { rate: number | null; status: string } }[] };
    const overall = await (await fetch("/reports/leaderboard?from=2026-09-01&to=2026-09-30&roster=all")).json() as Board;
    assert.deepEqual(overall.members.map((item) => [item.member.lastName, item.regularAttendance.preciseRate]), [["B", 100], ["A", 66.7], ["E", 66.7], ["C", 33.3], ["D", null]]);
    assert.equal(overall.members[0]!.labelResult, undefined);
    const robotics = await (await fetch("/reports/leaderboard?from=2026-09-01&to=2026-09-30&labelId=robotics&sort=label-rate")).json() as Board;
    assert.deepEqual(robotics.members.map((item) => [item.member.lastName, item.labelResult?.rate, item.labelResult?.status]), [["B", 100, "met"], ["A", 80, "met"], ["C", 33.3, "below"], ["D", null, "not_applicable"]]);
    assert.equal((await fetch("/reports/leaderboard?sort=label-rate")).status, 400);
  } finally { database.close(); }
});
