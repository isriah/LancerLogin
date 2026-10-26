import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { D1Database, D1Statement } from "../apps/api/src/d1-usage.ts";
import { acceptContestBatch, rejectContestBatch, submitContest } from "../apps/api/src/contest-review.ts";

function fixture(count = 66) {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`apps/api/migrations/${name}`, "utf8"));
  sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-10-15','local');
    INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('operator','primary','reviewer','operator','2026-10-15');
    INSERT INTO meetings(id,installation_id,title,starts_at,created_by,created_at) VALUES('meeting','primary','Synthetic meeting','2026-10-15T10:00:00Z','operator','2026-10-15');`);
  const contests = Array.from({ length: count }, (_, index) => ({ meetingId: "meeting", memberId: `member-${index}`, createdAt: "2026-10-15" }));
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
    const result = await acceptContestBatch(f.db, "operator", { contests: [...f.contests, { meetingId: "absent", memberId: "member-0", createdAt: "2026-10-15" }], reviewNote: "Checked" });
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

test("bulk rejection audits every open selection without changing attendance and retries are harmless", async () => {
  const f = fixture();
  try {
    f.sqlite.exec("UPDATE discord_attendance_contests SET status='reviewed' WHERE member_id='member-1'");
    const result = await rejectContestBatch(f.db, "operator", { contests: [...f.contests, { meetingId: "absent", memberId: "member-0", createdAt: "2026-10-15" }], reviewNote: "Attendance checked" });
    assert.equal(result.results.filter(row => row.resolved).length, 65);
    assert.equal(f.batches(), 1); assert.equal(f.rows("attendance_corrections"), 0); assert.equal(f.rows("audit_log"), 65);
    assert.ok(f.sqlite.prepare("SELECT metadata_json FROM audit_log").all().every(row => JSON.parse(String(row.metadata_json)).resolution === "rejected"));
    assert.ok((await rejectContestBatch(f.db, "operator", { contests: f.contests, reviewNote: "Retry" })).results.every(row => !row.resolved));
    assert.equal(f.rows("audit_log"), 65);
  } finally { f.sqlite.close(); }
});

test("rejection rolls back if any audit fails", async () => {
  const f = fixture(2);
  try {
    f.sqlite.exec("CREATE TRIGGER reject_synthetic_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    await assert.rejects(rejectContestBatch(f.db, "operator", { contests: f.contests, reviewNote: "Checked" }), /synthetic failure/);
    assert.equal(f.rows("audit_log"), 0);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS total FROM discord_attendance_contests WHERE status='open'").get()!.total, 2);
  } finally { f.sqlite.close(); }
});

test("re-contests retain each rejection, count one open request and reject stale staff selections", async () => {
  const f = fixture(1);
  try {
    const submission = { ...f.contests[0], messageId: "new-message", discordUserId: "synthetic-discord", now: "2026-10-15T11:00:00.000Z" };
    await rejectContestBatch(f.db, "operator", { contests: f.contests, reviewNote: "First review" });
    await Promise.all([submitContest(f.db, submission), submitContest(f.db, submission)]);
    let row = f.sqlite.prepare("SELECT * FROM discord_attendance_contests").get()!;
    assert.equal(row.status, "open"); assert.equal(row.created_at, submission.now); assert.equal(row.resolved_by, null); assert.equal(row.review_note, null);
    assert.equal(f.rows("discord_attendance_contests"), 1);
    let history = JSON.parse(String(row.prior_reviews_json));
    assert.equal(history.length, 1); assert.equal(history[0].reviewNote, "First review"); assert.equal(history[0].resolvedBy, "operator"); assert.equal(history[0].createdAt, "2026-10-15");
    for (const resolve of [acceptContestBatch, rejectContestBatch]) assert.equal((await resolve(f.db, "operator", { contests: [{ ...f.contests[0], createdAt: "2026-10-15" }], reviewNote: "Stale review" })).results[0].resolved, false);
    assert.equal(f.rows("audit_log"), 1); assert.equal(f.rows("attendance_corrections"), 0);
    await rejectContestBatch(f.db, "operator", { contests: [{ ...f.contests[0], createdAt: submission.now }], reviewNote: "Second review" });
    await submitContest(f.db, { ...submission, now: "2026-10-15T12:00:00.000Z" });
    row = f.sqlite.prepare("SELECT * FROM discord_attendance_contests").get()!;
    history = JSON.parse(String(row.prior_reviews_json));
    assert.deepEqual(history.map((review: { reviewNote: string }) => review.reviewNote), ["First review", "Second review"]);
    assert.equal(f.sqlite.prepare("SELECT sum(1 + json_array_length(prior_reviews_json)) AS count FROM discord_attendance_contests").get()!.count, 3);
  } finally { f.sqlite.close(); }
});

test("blocking re-contests preserves rejected history and approved or reviewed requests never reopen", async () => {
  const f = fixture(3);
  try {
    f.sqlite.exec("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic','UTC'); UPDATE organization_settings SET discord_block_recontests_after_rejection=1; UPDATE discord_attendance_contests SET status='rejected' WHERE member_id='member-0'; UPDATE discord_attendance_contests SET status='approved' WHERE member_id='member-1'; UPDATE discord_attendance_contests SET status='reviewed' WHERE member_id='member-2'");
    for (const item of f.contests) await submitContest(f.db, { ...item, messageId: "new", discordUserId: "synthetic", now: "2026-10-15T11:00:00Z" });
    assert.deepEqual(f.sqlite.prepare("SELECT status FROM discord_attendance_contests ORDER BY member_id").all().map(row => row.status), ["rejected", "approved", "reviewed"]);
    assert.ok(f.sqlite.prepare("SELECT prior_reviews_json FROM discord_attendance_contests").all().every(row => row.prior_reviews_json === "[]"));
  } finally { f.sqlite.close(); }
});

test("same-tick re-contests receive a distinct submission time and missing staff timestamps fail closed", async () => {
  const f = fixture(1);
  try {
    const first = "2026-10-15T10:00:00.000Z";
    f.sqlite.prepare("UPDATE discord_attendance_contests SET created_at=?").run(first);
    await rejectContestBatch(f.db, "operator", { contests: [{ ...f.contests[0], createdAt: first }], reviewNote: "Reviewed" });
    await submitContest(f.db, { ...f.contests[0], now: first, messageId: "same", discordUserId: "synthetic" });
    assert.equal(f.sqlite.prepare("SELECT created_at FROM discord_attendance_contests").get()!.created_at, "2026-10-15T10:00:00.001Z");
    const before = f.batches();
    await assert.rejects(rejectContestBatch(f.db, "operator", { contests: [{ meetingId: "meeting", memberId: "member-0" }], reviewNote: "Old client" }), /Refresh contests/);
    assert.equal(f.batches(), before);
  } finally { f.sqlite.close(); }
});
