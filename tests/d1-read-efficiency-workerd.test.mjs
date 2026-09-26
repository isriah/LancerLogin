import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("real D1 indexes, scoped reports and revision cache reduce row reads without changing results", async () => {
  const bundled = await build({ stdin: { contents: `import worker from './apps/api/src/index.ts'; import { measureD1 } from './apps/api/src/d1-usage.ts';
    export default { async fetch(request, env) { const measured = measureD1(env.DB); const result = await worker.fetch(request, {...env, DB: measured.database}); const response = new Response(result.body, result); response.headers.set('x-test-rows-read', String(measured.snapshot().measuredRowsRead)); return response; } };`, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser" });
  const secret = "A".repeat(43);
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-08-01", d1Databases: ["DB"], bindings: { APP_MODE: "configured", ALLOWED_ORIGIN: "https://example.test", SESSION_KEY: secret } }));
  try {
    const database = await runtime.getD1Database("DB");
    const migrations = (await readdir("apps/api/migrations")).filter((name) => name.endsWith(".sql")).sort();
    const apply = async (name) => database.exec((await readFile(`apps/api/migrations/${name}`, "utf8")).replace(/^\s*--.*$/gm, "").replace(/\r?\n/g, " "));
    for (const name of migrations.filter((name) => name !== "0037_report_read_efficiency.sql")) await apply(name);
    await database.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC');
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) SELECT 'm'||x,'primary','member'||x,'Synthetic','Member','2026-01-01' FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20) INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) SELECT 'meeting'||x,'primary','Synthetic meeting','2026-02-02T12:00:00Z','2026-02-02T13:00:00Z','admin','2026-01-01' FROM n;
      INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) SELECT m.id||t.id||a.action,'primary',m.id,t.id,'manual',CASE a.action WHEN 'check_in' THEN '2026-02-02T12:00:00Z' ELSE '2026-02-02T13:00:00Z' END,a.action FROM members m CROSS JOIN meetings t CROSS JOIN (SELECT 'check_in' AS action UNION ALL SELECT 'check_out') a;
      INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at) SELECT m.id||t.id,'primary',m.id,t.id,'present','Synthetic correction','admin','2026-02-03' FROM members m CROSS JOIN meetings t;`.replace(/\n/g, " "));
    const source = await readFile("apps/api/src/index.ts", "utf8");
    const attendanceSql = source.match(/db\.prepare\("(SELECT m\.id AS memberId[^"\n]+)"\)\.bind\(meetingId/)[1];
    const before = await database.prepare(attendanceSql).bind("meeting1", "meeting1", "meeting1", "meeting1", 0).all();
    await apply("0037_report_read_efficiency.sql");
    const after = await database.prepare(attendanceSql).bind("meeting1", "meeting1", "meeting1", "meeting1", 0).all();
    assert.deepEqual(after.results, before.results);
    assert.ok(after.meta.rows_read < before.meta.rows_read / 10, `before=${before.meta.rows_read}, after=${after.meta.rows_read}`);
    const payload = Buffer.from(JSON.stringify({ userId: "admin", role: "admin", expiresAt: Date.now() + 60_000 })).toString("base64url");
    const cookie = `lancerlogin_session=${payload}.${createHmac("sha256", Buffer.from(secret, "base64url")).update(payload).digest("base64url")}`;
    const fetch = (suffix = "") => runtime.dispatchFetch(`https://example.test/reports/attendance?roster=all${suffix}`, { headers: { cookie } });
    const cold = await fetch(); assert.equal(cold.status, 200); const full = await cold.json();
    const warm = await fetch(); assert.equal(warm.status, 200); assert.deepEqual(await warm.json(), full);
    const coldReads = Number(cold.headers.get("x-test-rows-read")), warmReads = Number(warm.headers.get("x-test-rows-read"));
    assert.ok(coldReads > 0); assert.equal(warmReads, 0);
    const member = await fetch("&memberId=m1"); const selected = await member.json();
    assert.deepEqual(selected.members, full.members.filter((item) => item.member.id === "m1"));
    const memberReads = Number(member.headers.get("x-test-rows-read")); assert.ok(memberReads < coldReads / 5);
    await database.prepare("UPDATE attendance_corrections SET disposition='excused' WHERE member_id='m1'").run();
    const changed = await fetch(); assert.ok(Number(changed.headers.get("x-test-rows-read")) > 0); assert.notDeepEqual(await changed.json(), full);
    console.log(JSON.stringify({ benchmark: "synthetic_d1_reads", attendanceBefore: before.meta.rows_read, attendanceAfter: after.meta.rows_read, coldReport: coldReads, warmReport: warmReads, memberReport: memberReads, note: "Report totals exclude first() queries for authorization and revision checks." }));
  } finally { await runtime.dispose(); }
});
