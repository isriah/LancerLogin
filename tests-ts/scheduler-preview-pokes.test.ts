// A write that queues scheduler work pokes the scheduler Durable Object so the work goes out within seconds. A POST that
// only previews (the meeting impact check, a dry-run meeting import, a label membership preview) queues nothing, and a
// poke for it wakes the Durable Object for alarm slices with nothing to do. On a real migrated SQLite database through
// the Worker, with a stand-in scheduler binding that records every request: previews never poke, real saves still do.
// Synthetic data only.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { BackupDatabase, sessionSecret } from "./fixtures/backup-database.ts";

const day = 86_400_000;
const iso = (offsetDays: number, hour: number) => { const date = new Date(Date.now() + offsetDays * day); date.setUTCHours(hour, 0, 0, 0); return date.toISOString(); };
const usDate = (value: string) => `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;

async function fixture(context: TestContext) {
  const db = new BackupDatabase(); context.after(() => db.raw.close());
  db.raw.exec(`INSERT INTO member_labels(id,installation_id,name,active,created_at) VALUES ('test-label-a','primary','Test Label A',1,'2026-01-01');
    INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES ('test-past','primary','Test Past Meeting','${iso(-3, 18)}','${iso(-3, 20)}',1,'admin','2026-01-01'),('test-future','primary','Test Future Meeting','${iso(4, 18)}','${iso(4, 20)}',1,'admin','2026-01-01');`);
  const pokes: string[][] = [];
  const scheduler = { fetch: async (input: Request) => { const path = new URL(input.url).pathname; if (path === "/poke") pokes.push(((await input.json()) as { jobs: string[] }).jobs); return Response.json({ alarm: 1 }); } };
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", PLATFORM_SCHEDULER: { idFromName: (name: string) => name, get: () => scheduler } };
  const pending: Promise<unknown>[] = []; const context2 = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} };
  await worker.fetch(new Request("https://api.example.test/health"), env as never, context2 as never);
  const cookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" })}`;
  /** One request; returns its status and the jobs it poked (none when it poked nothing). */
  const call = async (method: string, path: string, body?: unknown) => {
    await Promise.all(pending.splice(0)); pokes.length = 0;
    const result = await worker.fetch(new Request(`https://api.example.test${path}`, { method, headers: { cookie, origin: env.ALLOWED_ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never, context2 as never);
    const text = await result.text(); await Promise.all(pending.splice(0));
    return { status: result.status, text, poked: pokes.flat() };
  };
  return { db, call };
}

test("read-only previews on meeting and label routes do not poke the scheduler", async (context) => {
  const { call } = await fixture(context);
  // The editor's historical impact check for a completed meeting, before the Admin confirms the save.
  const impact = await call("POST", "/meetings/test-past/impact", { required: false });
  assert.equal(impact.status, 200, impact.text); assert.equal((JSON.parse(impact.text) as { changed: boolean }).changed, true);
  assert.deepEqual(impact.poked, [], "the impact preview pokes nothing");
  // A meeting CSV import is a dry run unless the request says otherwise.
  const date = iso(9, 18).slice(0, 10);
  const dryRun = await call("POST", "/meetings/import", { rows: [{ rowNumber: 2, values: { title: "Test Imported Meeting", date: usDate(date), startTime: "18:00", endTime: "19:00" } }] });
  assert.equal(dryRun.status, 200, dryRun.text); assert.equal((JSON.parse(dryRun.text) as { dryRun: boolean }).dryRun, true);
  assert.deepEqual(dryRun.poked, [], "a dry-run import pokes nothing");
  const labels = await call("POST", "/labels/membership/preview", { changes: [{ memberId: "001", label: "Test Label A", action: "add", effectiveDate: "2026-01-01" }] });
  assert.equal(labels.status, 200, labels.text); assert.deepEqual(labels.poked, [], "a label membership preview pokes nothing");
});

test("writes that queue scheduler work still poke it", async (context) => {
  const { call } = await fixture(context);
  const saved = await call("PATCH", "/meetings/test-future", { title: "Test Future Meeting Renamed", startsAt: iso(4, 18), endsAt: iso(4, 20) });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.poked, ["attendance.google-calendar", "attendance.discord-calendar", "attendance.discord-notices", "attendance.discord-anomalies"]);
  const imported = await call("POST", "/meetings/import", { dryRun: false, rows: [{ rowNumber: 2, values: { title: "Test Imported Meeting", date: usDate(iso(9, 18).slice(0, 10)), startTime: "18:00", endTime: "19:00" } }] });
  assert.equal(imported.status, 200, imported.text); assert.ok(imported.poked.includes("attendance.google-calendar"), "a committed import pokes the calendar jobs");
  const preview = await call("POST", "/labels/membership/preview", { changes: [{ memberId: "001", label: "Test Label A", action: "add", effectiveDate: "2026-01-01" }] });
  const applied = await call("POST", "/labels/membership/apply", { changes: [{ memberId: "001", label: "Test Label A", action: "add", effectiveDate: "2026-01-01" }], previewToken: (JSON.parse(preview.text) as { previewToken: string }).previewToken });
  assert.equal(applied.status, 200, applied.text); assert.deepEqual(applied.poked, ["attendance.discord-label-roles"]);
  // A failed request pokes nothing.
  assert.deepEqual((await call("POST", "/meetings/missing/impact", { required: false })).poked, []);
});
