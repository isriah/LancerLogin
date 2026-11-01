// Attendance setup's Verified attendance input step completes once an active paired kiosk, Pi or web, has checked in.
// An Admin can pair and the kiosk can check in before setup is finished; everything else a kiosk does waits for it.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { readModuleSetup, updateModuleSetup } from "../apps/api/src/module-platform.ts";
import { Database } from "./fixtures/lifecycle-database.ts";
import { BackupDatabase, backupClient } from "./fixtures/backup-database.ts";

const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function client(database: Database) {
  const env = { DB: database, SESSION_KEY: secret, INTEGRATION_KEY: secret, APP_MODE: "configured" };
  return async (path: string, { body, method = body === undefined ? "GET" : "POST", role, token }: { body?: unknown; method?: string; role?: "admin" | "operator"; token?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (role) headers.cookie = "lancerlogin_session=" + await createSessionCodec(secret).issue({ userId: role, role });
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    return worker.fetch(new Request(`https://fixture.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env as never);
  };
}

const inputValid = async (database: Database) => (await readModuleSetup(database, "admin", "attendance")).steps.find((step) => step.id === "input")?.valid;

test("Verified attendance input completes once a kiosk paired during setup has checked in", async () => {
  const database = new Database();
  try {
    const call = client(database);
    assert.equal(await inputValid(database), false);
    assert.equal((await (await call("/module-setup/attendance/input", { role: "admin" })).json() as { kiosks: unknown[] }).kiosks.length, 0);
    // The simulator's setup actions are gone.
    assert.equal((await call("/module-setup/attendance/input", { role: "admin", body: { action: "start", name: "Test simulator" } })).status, 405);

    // Add kiosk works before Attendance is ready, for Admins only.
    assert.equal((await call("/admin/pairing-codes", { role: "operator", body: { kioskName: "Test web kiosk A", kind: "web" } })).status, 403);
    assert.equal((await call("/admin/pairing-codes", { role: "admin", body: { kioskName: "Test web kiosk A", purpose: "simulator" } })).status, 400);
    const created = await call("/admin/pairing-codes", { role: "admin", body: { kioskName: "Test web kiosk A", kind: "web" } });
    assert.equal(created.status, 201, await created.clone().text());
    const paired = await call("/kiosk/pair", { body: { code: (await created.json() as { code: string }).code } });
    assert.equal(paired.status, 201, await paired.clone().text());
    const { kioskId, kioskToken } = await paired.json() as { kioskId: string; kioskToken: string };

    // Paired but not yet checked in: the step is not complete, and the kiosk cannot take attendance until setup is finished.
    assert.deepEqual((await (await call("/module-setup/attendance/input", { role: "admin" })).json() as { kiosks: unknown[] }).kiosks, [{ id: kioskId, name: "Test web kiosk A", kind: "web", lastSeenAt: null }]);
    assert.equal(await inputValid(database), false);
    await assert.rejects(updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "input", outcome: "completed" }), /Complete the current setup step/);
    assert.equal((await call("/kiosk/config", { token: kioskToken })).status, 409);

    const heartbeat = await call("/kiosk/heartbeat", { token: kioskToken, body: { readerOnline: false, releaseVersion: "test" } });
    assert.equal(heartbeat.status, 200, await heartbeat.clone().text());
    const [listed] = (await (await call("/module-setup/attendance/input", { role: "admin" })).json() as { kiosks: { lastSeenAt: string | null }[] }).kiosks;
    assert.ok(listed?.lastSeenAt);
    assert.equal(await inputValid(database), true);
    await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "rules", outcome: "completed" });
    const meetingStart = new Date(); meetingStart.setUTCHours(0, 0, 0, 0);
    database.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES('test-meeting-a','primary','Test meeting A',?,?,'admin',?)")
      .run(meetingStart.toISOString(), new Date(meetingStart.getTime() + 3_600_000).toISOString(), meetingStart.toISOString());
    await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "meeting", outcome: "completed" });
    const state = await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "input", outcome: "completed" });
    assert.equal(state.ready, true);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM attendance_events").get()?.count, 0, "setup records no attendance");
    assert.equal((await call("/kiosk/config", { token: kioskToken })).status, 200, "the kiosk works once setup is finished");
  } finally { database.sqlite.close(); }
});

test("walkthrough progress from the Simulator page is ignored and a Kiosks tour saved at its simulator step still reads", async (t) => {
  const db = new BackupDatabase(); t.after(() => db.raw.close()); const backups = backupClient(worker, db);
  const env = { DB: db, SESSION_KEY: secret, APP_MODE: "configured" };
  const read = async (pageId: string) => worker.fetch(new Request(`https://fixture.test/auth/walkthroughs/${pageId}`, { headers: { cookie: "lancerlogin_session=" + await createSessionCodec(secret).issue({ userId: "admin", role: "admin" }) } }), env as never);
  db.raw.exec(`INSERT INTO user_walkthroughs(installation_id,user_id,page_id,content_version,status,step_id,updated_at) VALUES
    ('primary','admin','kiosks',1,'in_progress','simulator','2026-01-01T00:00:00.000Z'),('primary','admin','simulator',1,'in_progress','preview','2026-01-01T00:00:00.000Z')`);
  assert.deepEqual((await (await read("kiosks")).json() as { progress: unknown }).progress, { pageId: "kiosks", version: 1, status: "in_progress", stepId: "simulator" });
  assert.equal((await read("simulator")).status, 404);
  const restored = await backups.restore(await backups.backup("installation"));
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(db.rows("SELECT page_id AS pageId FROM user_walkthroughs ORDER BY page_id"), [{ pageId: "kiosks" }]);
});

test("the browser simulator's routes are gone", async () => {
  const database = new Database(true);
  try {
    const call = client(database);
    assert.equal((await call("/admin/simulator", { role: "admin" })).status, 404);
    assert.equal((await call("/admin/simulator", { role: "admin", body: { action: "scan", memberId: "TEST-A", meetingId: "test-meeting-a" } })).status, 404);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='simulated_kiosk_sessions'").get()?.count, 0);
  } finally { database.sqlite.close(); }
});
