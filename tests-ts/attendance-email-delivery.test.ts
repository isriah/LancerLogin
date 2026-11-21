// quick-check: covers apps/api/migrations/**
// Attendance emails through the real Worker and real SQLite: a failed or interrupted send can be retried, two sends of the
// same email never run at once, and a send that never finished stops blocking anything once it is stale.
// Every person, address and credential here is synthetic; Resend is a fake.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { configureModulePlatform } from "../apps/api/src/module-platform.ts";
import { pruneStaleRows, STALE_EMAIL_DELIVERY_MINUTES } from "../apps/api/src/stale-row-pruning.ts";
import { TestD1Database } from "./fixtures/d1-database.ts";
import { Database as LifecycleDatabase } from "./fixtures/lifecycle-database.ts";

const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const origin = "https://dashboard.example.test";

class Database extends TestD1Database {
  constructor() {
    super({ seed: `INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-10-18','both');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO users(id,installation_id,email,local_username,role,created_at) VALUES('admin','primary','test.admin.a@example.test','admin','admin','2026-10-18');
      INSERT INTO platform_module_administration VALUES('primary',0,1); INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES('primary','attendance',1,1,'enabled',2,1,0);
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,active,created_at) VALUES('member-a','primary','T-A','Test Student','A','test.student.a@example.test',1,'2026-10-18');` });
  }
  rows() { return this.sqlite.prepare("SELECT id, delivery_key AS deliveryKey, status, external_id AS externalId, created_at AS createdAt, updated_at AS updatedAt FROM integration_deliveries ORDER BY delivery_key").all() as { id: string; deliveryKey: string; status: string; externalId: string | null; createdAt: string; updatedAt: string }[]; }
}

async function setup() {
  const db = new Database();
  const encrypted = await encryptIntegration({ apiKey: "re_synthetic", fromEmail: "attendance@example.test" }, secret);
  db.sqlite.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES('resend-1','primary','resend',?,?,'2026-10-18','2026-10-18')").run(encrypted.ciphertext, encrypted.iv);
  db.sqlite.exec("UPDATE installations SET resend_enabled = 1 WHERE id = 'primary'");
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: origin, SESSION_KEY: secret, INTEGRATION_KEY: secret, DB: db } as unknown as Env;
  return { db, env };
}
const cookie = async () => `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
async function sendReport(env: Env) {
  return worker.fetch(new Request("https://api.example.test/communications/email", { method: "POST", headers: { origin, "content-type": "application/json", cookie: await cookie() }, body: JSON.stringify({ kind: "individual-report", memberId: "member-a" }) }), env);
}
const quietErrors = (context: TestContext) => context.mock.method(console, "error", () => {});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

test("a send Resend rejected can be retried, and the retry records its own attempt", async (context) => {
  quietErrors(context);
  const { db, env } = await setup(); context.after(() => db.close());
  const rejected = context.mock.method(globalThis, "fetch", async () => Response.json({ message: "Synthetic outage." }, { status: 503 }));
  const first = await sendReport(env);
  assert.equal(first.status, 502, await first.clone().text());
  const [failed] = db.rows(); assert.equal(failed?.status, "failed");
  rejected.mock.restore();

  let sent = 0; context.mock.method(globalThis, "fetch", async () => { sent += 1; return Response.json({ id: "email-retry" }); });
  const retry = await sendReport(env);
  assert.equal(retry.status, 202, await retry.clone().text());
  assert.equal(sent, 1);
  const [delivered] = db.rows();
  assert.equal(db.rows().length, 1, "the retry reuses the delivery key's row");
  assert.deepEqual({ status: delivered?.status, externalId: delivered?.externalId, createdAt: delivered?.createdAt }, { status: "delivered", externalId: "email-retry", createdAt: failed?.createdAt });
  assert.notEqual(delivered?.id, failed?.id, "each attempt claims the row under its own id");

  // A delivered email is not sent twice.
  const again = await sendReport(env);
  assert.equal(again.status, 409); assert.equal(sent, 1);
  const audits = db.sqlite.prepare("SELECT metadata_json AS metadata FROM audit_log WHERE action = 'resend.email_sent' ORDER BY rowid").all().map((row) => JSON.parse(String(row.metadata)));
  assert.deepEqual(audits.map((audit) => audit.ok), [false, true]);
  assert.equal(audits[0].status, 503); assert.equal(audits[0].reason, "Resend rejected the email (503): Synthetic outage.");
});

test("a send whose request to Resend throws is marked failed with its reason and can be retried", async (context) => {
  quietErrors(context);
  const { db, env } = await setup(); context.after(() => db.close());
  const thrown = context.mock.method(globalThis, "fetch", async () => { throw new TypeError("Network connection lost."); });
  const first = await sendReport(env);
  assert.equal(first.status, 502, await first.clone().text());
  assert.match((await first.json() as { error: string }).error, /could not reach Resend/);
  assert.equal(db.rows()[0]?.status, "failed");
  const audit = JSON.parse(String(db.sqlite.prepare("SELECT metadata_json AS metadata FROM audit_log WHERE action = 'resend.email_sent'").get()?.metadata));
  assert.equal(audit.ok, false); assert.equal(audit.reason, "Network connection lost.");
  thrown.mock.restore();

  context.mock.method(globalThis, "fetch", async () => Response.json({ id: "email-after-throw" }));
  const retry = await sendReport(env);
  assert.equal(retry.status, 202, await retry.clone().text());
  assert.deepEqual(db.rows().map((row) => [row.status, row.externalId]), [["delivered", "email-after-throw"]]);
});

test("two sends of the same email never run at once; a send left pending past the stale age can be retried", async (context) => {
  quietErrors(context);
  const { db, env } = await setup(); context.after(() => db.close());
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let sent = 0; context.mock.method(globalThis, "fetch", async () => { sent += 1; await gate; return Response.json({ id: `email-${sent}` }); });
  const first = sendReport(env);
  // Let the first request claim the key and reach Resend before the second arrives.
  for (let turn = 0; turn < 50 && sent === 0; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent, 1);
  const second = await sendReport(env);
  assert.equal(second.status, 409); assert.equal((await second.json() as { error: string }).error, "This email was already sent or is currently sending");
  release();
  assert.equal((await first).status, 202);
  assert.equal(sent, 1, "only one request reached Resend");

  // A Worker stopped mid-send leaves its row pending. Within the stale age it still counts as sending...
  db.sqlite.exec("DELETE FROM integration_deliveries");
  const key = `report:member-a:${new Date().toISOString().slice(0, 10)}`;
  db.sqlite.prepare("INSERT INTO integration_deliveries(id,installation_id,provider,delivery_key,status,created_at,updated_at) VALUES('stuck','primary','resend',?,'pending',?,?)").run(key, minutesAgo(STALE_EMAIL_DELIVERY_MINUTES - 1), minutesAgo(STALE_EMAIL_DELIVERY_MINUTES - 1));
  assert.equal((await sendReport(env)).status, 409); assert.equal(sent, 1);
  // ...and past it the send is retried.
  db.sqlite.prepare("UPDATE integration_deliveries SET updated_at = ? WHERE id = 'stuck'").run(minutesAgo(STALE_EMAIL_DELIVERY_MINUTES + 1));
  const retried = await sendReport(env);
  assert.equal(retried.status, 202, await retried.clone().text()); assert.equal(sent, 2);
  assert.deepEqual(db.rows().map((row) => row.status), ["delivered"]);
});

test("an email send left pending stops blocking Attendance disablement once housekeeping marks it failed", async (context) => {
  const database = new LifecycleDatabase(true); context.after(() => database.close());
  const insert = database.sqlite.prepare("INSERT INTO integration_deliveries(id,installation_id,provider,delivery_key,status,created_at,updated_at) VALUES(?,'primary','resend',?,'pending',?,?)");
  insert.run("stuck", "report:member:2026-11-19", minutesAgo(60), minutesAgo(60));
  insert.run("sending", "report:other:2026-11-19", minutesAgo(1), minutesAgo(1));
  const disable = () => configureModulePlatform(database, "admin", { enabled: [], revision: 0, confirmDisable: [{ moduleId: "attendance", generation: 1 }] });
  await assert.rejects(disable(), /Wait for in-flight Attendance delivery work to finish/);

  const swept = await pruneStaleRows(database);
  assert.equal(swept.staleEmailDeliveries, 1, "only the send past the stale age is marked failed");
  assert.deepEqual(database.sqlite.prepare("SELECT id, status FROM integration_deliveries ORDER BY id").all().map((row) => [row.id, row.status]), [["sending", "pending"], ["stuck", "failed"]]);
  await assert.rejects(disable(), /Wait for in-flight Attendance delivery work to finish/, "a send still within the stale age keeps blocking");

  database.sqlite.prepare("UPDATE integration_deliveries SET updated_at = ? WHERE id = 'sending'").run(minutesAgo(STALE_EMAIL_DELIVERY_MINUTES + 1));
  assert.equal((await pruneStaleRows(database)).staleEmailDeliveries, 1);
  const snapshot = await disable();
  assert.equal(snapshot.modules.find((module) => module.id === "attendance")?.phase, "retained");
});
