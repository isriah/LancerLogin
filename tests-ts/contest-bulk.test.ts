import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { D1Database, D1Statement } from "../apps/api/src/d1-usage.ts";
import { acceptContestBatch } from "../apps/api/src/contest-review.ts";

function fixture(count = 66) {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`apps/api/migrations/${name}`, "utf8"));
  sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-10-15','local');
    INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('operator','primary','reviewer','operator','2026-10-15');
    INSERT INTO meetings(id,installation_id,title,starts_at,created_by,created_at) VALUES('meeting','primary','Synthetic meeting','2026-10-15T10:00:00Z','operator','2026-10-15');`);
  const contests = Array.from({ length: count }, (_, index) => ({ meetingId: "meeting", memberId: `member-${index}` }));
  for (const { memberId } of contests) {
    sqlite.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES(?,'primary',?,'Synthetic','Member','2026-10-15')").run(memberId, memberId);
    sqlite.prepare("INSERT INTO discord_attendance_contests(installation_id,meeting_id,member_id,message_id,status,created_at) VALUES('primary','meeting',?,'synthetic-message','open','2026-10-15')").run(memberId);
  }
  let batches = 0;
  type Statement = D1Statement & { execute: () => unknown };
  const db: D1Database = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement: Statement = {
        bind(...input) { values = input; return statement; },
        async first<T>() { return (sqlite.prepare(sql).get(...values as []) ?? null) as T | null; },
        async all<T>() { return { success: true, results: sqlite.prepare(sql).all(...values as []) as T[] }; },
        async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values as []).changes) } }; },
        execute() { return /^\s*SELECT/.test(sql) ? statement.all() : statement.run(); },
      };
      return statement;
    },
    async batch(statements) {
      batches++; sqlite.exec("BEGIN IMMEDIATE");
      try { const results = []; for (const s of statements) results.push(await (s as Statement).execute()); sqlite.exec("COMMIT"); return results as Awaited<ReturnType<D1Database["batch"]>>; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const rows = (table: string) => Number(sqlite.prepare(`SELECT count(*) AS total FROM ${table}`).get()!.total);
  return { sqlite, db, contests, rows, batches: () => batches };
}

test("66 contest approvals commit together, each with its own correction and audit, without duplicate retry writes", async () => {
  const f = fixture();
  try {
    const result = await acceptContestBatch(f.db, "operator", { contests: f.contests, reviewNote: "Verified synthetic attendance" });
    assert.equal(result.results.length, 66); assert.ok(result.results.every(row => row.resolved));
    assert.equal(f.batches(), 1); assert.equal(f.rows("attendance_corrections"), 66); assert.equal(f.rows("audit_log"), 66);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS total FROM discord_attendance_contests WHERE status='approved'").get()!.total, 66);
    const retry = await acceptContestBatch(f.db, "operator", { contests: f.contests, reviewNote: "Retry" });
    assert.ok(retry.results.every(row => !row.resolved)); assert.equal(f.rows("attendance_corrections"), 66); assert.equal(f.rows("audit_log"), 66);
  } finally { f.sqlite.close(); }
});

test("closed and missing contests remain unchanged while open selections succeed", async () => {
  const f = fixture(3);
  try {
    f.sqlite.exec("UPDATE discord_attendance_contests SET status='reviewed' WHERE member_id='member-1'");
    const result = await acceptContestBatch(f.db, "operator", { contests: [...f.contests, { meetingId: "absent", memberId: "member-0" }], reviewNote: "Checked" });
    assert.deepEqual(result.results.map(row => row.resolved), [true, false, true, false]);
    assert.equal(f.rows("attendance_corrections"), 2); assert.equal(f.rows("audit_log"), 2);
    assert.equal(f.sqlite.prepare("SELECT status FROM discord_attendance_contests WHERE member_id='member-1'").get()!.status, "reviewed");
  } finally { f.sqlite.close(); }
});

test("audit failure rolls back corrections and contest state; malformed and duplicate input writes nothing", async () => {
  const f = fixture(2);
  try {
    for (const input of [{ contests: f.contests, reviewNote: " " }, { contests: [f.contests[0], f.contests[0]], reviewNote: "Checked" }, { contests: Array(101).fill(f.contests[0]), reviewNote: "Checked" }]) await assert.rejects(acceptContestBatch(f.db, "operator", input));
    assert.equal(f.batches(), 0);
    f.sqlite.exec("CREATE TRIGGER reject_synthetic_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    await assert.rejects(acceptContestBatch(f.db, "operator", { contests: f.contests, reviewNote: "Checked" }), /synthetic failure/);
    assert.equal(f.rows("attendance_corrections"), 0); assert.equal(f.rows("audit_log"), 0);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS total FROM discord_attendance_contests WHERE status='open'").get()!.total, 2);
  } finally { f.sqlite.close(); }
});
