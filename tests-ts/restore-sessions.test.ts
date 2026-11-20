// quick-check: covers apps/api/migrations/**
// Entire-installation restore through the Worker on a real migrated SQLite database: session epochs never go down, so no
// revoked session works again; the restoring Admin stays signed in; scan check records of the replaced state are cleared;
// and rows travel in multi-row INSERT statements within D1's bound-parameter limit. All data is synthetic.
import test from "node:test";
import assert from "node:assert/strict";

const { default: worker } = await import("../apps/api/src/index.ts");
const { BackupDatabase, sessionSecret } = await import("./fixtures/backup-database.ts");
const { createSessionCodec } = await import("../apps/api/src/runtime-security.ts");

const codec = createSessionCodec(sessionSecret);
const cookieFor = async (userId: string, role: "admin" | "operator", epoch?: number) => "lancerlogin_session=" + await codec.issue({ userId, role, ...(epoch === undefined ? {} : { epoch }) });

async function fixture() {
  const db = new BackupDatabase(); const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured" };
  await worker.fetch(new Request("https://fixture.test/health"), env as never);
  const fetch = (path: string, cookie: string, body?: unknown) => worker.fetch(new Request("https://fixture.test" + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env as never);
  const status = async (cookie: string) => (await fetch("/auth/session", cookie)).status;
  const backup = async (cookie: string, scope = "installation") => { const result = await fetch(`/admin/data/backup?scope=${scope}`, cookie); assert.equal(result.status, 200, await result.clone().text()); return await result.json() as { tables: Record<string, Record<string, unknown>[]> }; };
  const restore = (cookie: string, file: unknown, scope = "installation") => fetch("/admin/data/restore", cookie, { scope, confirmation: `RESTORE ${scope.toUpperCase()}`, backup: file });
  const epochs = () => Object.fromEntries(db.rows<{ id: string; session_epoch: number }>("SELECT id, session_epoch FROM users ORDER BY id").map((row) => [row.id, row.session_epoch]));
  return { db, fetch, status, backup, restore, epochs };
}
/** The session cookie a response sets, as the browser would send it back, with its Max-Age. */
function setCookie(response: Response) {
  const header = response.headers.get("set-cookie");
  if (!header) return undefined;
  return { cookie: header.split(";")[0]!, maxAge: Number(/Max-Age=(\d+)/.exec(header)![1]), attributes: header };
}

test("an installation restore never lowers a session epoch: revoked sessions stay revoked and the restoring Admin stays signed in", async (t) => {
  const f = await fixture(); t.after(() => f.db.raw.close());
  // The Admin has signed out three times; the Operator once.
  f.db.raw.exec("UPDATE users SET session_epoch = 3 WHERE id = 'admin'; UPDATE users SET session_epoch = 1 WHERE id = 'operator';");
  const current = await cookieFor("admin", "admin", 3); const revoked = await cookieFor("admin", "admin", 0); const earlier = await cookieFor("admin", "admin", 2);
  const operator = await cookieFor("operator", "operator", 1); const operatorRevoked = await cookieFor("operator", "operator");
  assert.deepEqual([await f.status(current), await f.status(revoked), await f.status(earlier), await f.status(operator), await f.status(operatorRevoked)], [200, 401, 401, 200, 401]);
  const file = await f.backup(current);
  assert.ok(file.tables.users!.every((row) => !("session_epoch" in row)), "the backup format carries no session epoch");

  const before = Date.now();
  const restored = await f.restore(current, file);
  assert.equal(restored.status, 200, await restored.clone().text());
  const epochs = f.epochs();
  assert.ok(epochs.admin! >= before * 1000 && Number.isSafeInteger(epochs.admin) && epochs.admin === epochs.operator, `every account moves to the restore's epoch: ${JSON.stringify(epochs)}`);
  // No cookie issued before the restore works, whichever epoch it holds: not the revoked ones, and not the current ones.
  assert.deepEqual([await f.status(revoked), await f.status(earlier), await f.status(operatorRevoked), await f.status(operator), await f.status(current)], [401, 401, 401, 401, 401]);

  // The response replaces the restoring Admin's cookie: the same session under the new epoch, not a longer one.
  const session = setCookie(restored)!;
  assert.ok(session, "the restore response sets the Admin's session cookie");
  assert.match(session.attributes, /HttpOnly; Secure; SameSite=Strict; Path=\//);
  assert.equal(await f.status(session.cookie), 200);
  const was = (await codec.verify(current.split("=")[1]!))!; const now = (await codec.verify(session.cookie.split("=")[1]!))!;
  assert.deepEqual({ ...now, epoch: undefined }, { ...was, epoch: undefined }, "user, role, expiry and sign-in time are unchanged");
  assert.equal(now.epoch, epochs.admin);
  assert.ok(session.maxAge > 0 && session.maxAge <= 28_800);
  // The Admin can carry on: the dashboard reloads after a restore and takes a new backup with the new cookie.
  await f.backup(session.cookie);

  // Signing out afterwards still revokes, and a second restore still only moves epochs up.
  assert.equal((await f.fetch("/auth/logout", session.cookie, {})).status, 200);
  assert.equal(await f.status(session.cookie), 401);
  assert.equal(f.epochs().admin, epochs.admin! + 1);
  const again = await cookieFor("admin", "admin", epochs.admin! + 1);
  const second = await f.restore(again, file);
  assert.equal(second.status, 200, await second.clone().text());
  assert.ok(f.epochs().admin! > epochs.admin!, "a later restore never lowers an epoch");
  assert.deepEqual([await f.status(session.cookie), await f.status(again), await f.status(revoked), await f.status(setCookie(second)!.cookie)], [401, 401, 401, 200]);
});

test("an Admin whose account the backup does not hold as active is signed out by the restore, with no cookie", async (t) => {
  const f = await fixture(); t.after(() => f.db.raw.close());
  const admin = await cookieFor("admin", "admin");
  const file = await f.backup(admin);
  // A second Admin created after the backup makes the restore; the backup has no such account.
  f.db.raw.exec(`INSERT INTO users(id,installation_id,local_username,role,active,created_at) VALUES ('later-admin','primary','test-later-admin','admin',1,'2026-01-02');`);
  const later = await cookieFor("later-admin", "admin");
  assert.equal(await f.status(later), 200);
  const restored = await f.restore(later, file);
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.equal(setCookie(restored), undefined);
  assert.deepEqual([await f.status(later), await f.status(admin)], [401, 401]);
  assert.deepEqual(Object.keys(f.epochs()), ["admin", "operator"]);
  // An account the backup holds as inactive gets no cookie either.
  const signedIn = await cookieFor("admin", "admin", f.epochs().admin);
  assert.equal(await f.status(signedIn), 200);
  const inactive = { ...file, tables: { ...file.tables, users: file.tables.users!.map((row) => row.id === "admin" ? { ...row, active: 0 } : row) } };
  const deactivated = await f.restore(signedIn, inactive);
  assert.equal(deactivated.status, 200, await deactivated.clone().text());
  assert.equal(setCookie(deactivated), undefined);
  assert.equal(await f.status(signedIn), 401);
});

test("roster and meetings restores leave sessions and scan check records alone", async (t) => {
  const f = await fixture(); t.after(() => f.db.raw.close());
  f.db.raw.exec(`UPDATE users SET session_epoch = 2 WHERE id = 'admin';
    INSERT INTO kiosk_possible_wrong_matches(installation_id,kiosk_event_id,kiosk_id,member_id,occurred_at,other_kiosk_event_id,other_kiosk_id,other_occurred_at,recorded_at) VALUES('primary','test-event-1','test-kiosk-1','member','2026-01-01T00:00:00Z','test-event-2','test-kiosk-2','2026-01-01T00:00:05Z','2026-11-01T00:00:00Z');`);
  const admin = await cookieFor("admin", "admin", 2);
  for (const scope of ["roster", "meetings"]) {
    const restored = await f.restore(admin, await f.backup(admin, scope), scope);
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.equal(setCookie(restored), undefined, `${scope} restore sets no cookie`);
  }
  assert.deepEqual(f.epochs(), { admin: 2, operator: 0 });
  assert.equal(await f.status(admin), 200);
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM kiosk_possible_wrong_matches"), 1);
});

test("an installation restore clears the scan check records of the state it replaces and keeps the minimum match score", async (t) => {
  const f = await fixture(); t.after(() => f.db.raw.close());
  const admin = await cookieFor("admin", "admin");
  const file = await f.backup(admin);
  f.db.raw.exec(`INSERT INTO kiosk_scan_matches(installation_id,kiosk_event_id,kiosk_id,match_score,recorded_at) VALUES('primary','test-event-1','test-kiosk-1',120,'2026-11-01T00:00:00Z');
    INSERT INTO kiosk_accepted_scans(installation_id,kiosk_event_id,kiosk_id,member_id,occurred_at,recorded_at) VALUES('primary','test-event-2','test-kiosk-2','member','2026-01-01T00:00:05Z','2026-11-01T00:00:00Z');
    INSERT INTO kiosk_possible_wrong_matches(installation_id,kiosk_event_id,kiosk_id,member_id,occurred_at,other_kiosk_event_id,other_kiosk_id,other_occurred_at,recorded_at) VALUES('primary','test-event-1','test-kiosk-1','member','2026-01-01T00:00:00Z','test-event-2','test-kiosk-2','2026-01-01T00:00:05Z','2026-11-01T00:00:00Z');
    INSERT INTO kiosk_fingerprint_match_settings(installation_id,minimum_score,updated_at) VALUES('primary',60,'2026-11-01T00:00:00Z');
    INSERT INTO kiosk_scan_matches(installation_id,kiosk_event_id,kiosk_id,match_score,recorded_at) VALUES('other','test-event-9','test-kiosk-9',120,'2026-11-01T00:00:00Z');`);
  for (const table of ["kiosk_scan_matches", "kiosk_accepted_scans", "kiosk_possible_wrong_matches"]) assert.ok(!(table in file.tables), `${table} is not part of a backup`);
  const restored = await f.restore(admin, file);
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(["kiosk_scan_matches", "kiosk_accepted_scans", "kiosk_possible_wrong_matches"].map((table) => f.db.count(`SELECT COUNT(*) AS n FROM ${table} WHERE installation_id = 'primary'`)), [0, 0, 0]);
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM kiosk_scan_matches WHERE installation_id = 'other'"), 1, "only this installation's records are cleared");
  assert.deepEqual(f.db.rows("SELECT minimum_score FROM kiosk_fingerprint_match_settings WHERE installation_id = 'primary'"), [{ minimum_score: 60 }]);
});

test("a restore writes rows in multi-row statements within D1's 100 bound parameters, and every row arrives", async (t) => {
  const f = await fixture(); t.after(() => f.db.raw.close());
  const admin = await cookieFor("admin", "admin");
  f.db.raw.exec(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES ('test-meeting','primary','Test Meeting','2026-03-02T18:00:00.000Z','2026-03-02T20:00:00.000Z',1,'admin','2026-01-01');
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<60) INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) SELECT 'test-member-'||x,'primary','T-'||x,'Test Student',CAST(x AS TEXT),'2026-01-01' FROM n;
    INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) SELECT 'test-in-'||m.id,'primary',m.id,'test-meeting','manual','2026-03-02T18:00:00.000Z','check_in' FROM members m WHERE m.id LIKE 'test-member-%';
    INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) SELECT 'test-out-'||m.id,'primary',m.id,'test-meeting','manual','2026-03-02T20:00:00.000Z','check_out' FROM members m WHERE m.id LIKE 'test-member-%';`);
  const tables = ["members", "meetings", "attendance_events", "users", "organization_settings"];
  const snapshot = () => Object.fromEntries(tables.map((table) => [table, f.db.rows(`SELECT * FROM ${table} ORDER BY ${table === "organization_settings" ? "installation_id" : "id"}`).map((row) => ({ ...row, session_epoch: undefined }))]));
  const before = snapshot();
  const batches: { sql: string; values: unknown[] }[][] = []; const batch = f.db.batch.bind(f.db);
  (f.db as { batch: typeof f.db.batch }).batch = async (statements) => { batches.push((statements as unknown as { sql: string; values: unknown[] }[]).map(({ sql, values }) => ({ sql, values }))); return batch(statements); };
  for (const scope of ["installation", "meetings"]) {
    const file = await f.backup(scope === "installation" ? admin : await cookieFor("admin", "admin", f.epochs().admin), scope);
    batches.length = 0;
    const restored = await f.restore(scope === "installation" ? admin : await cookieFor("admin", "admin", f.epochs().admin), file, scope);
    assert.equal(restored.status, 200, await restored.clone().text());
    const statements = batches.find((entry) => entry.some(({ sql }) => /^INSERT INTO attendance_events /.test(sql)))!;
    assert.ok(statements.every(({ values }) => values.length <= 100), "no statement binds more than 100 parameters");
    const events = statements.filter(({ sql }) => /^INSERT INTO attendance_events /.test(sql));
    // 120 events of 9 columns: 11 rows fill a statement (99 parameters), so 10 full statements and one of 10 rows.
    assert.deepEqual(events.map(({ values }) => values.length / 9), [...Array.from({ length: 10 }, () => 11), 10], scope);
    assert.deepEqual(snapshot(), before, `${scope} restore reproduces every row`);
  }
});
