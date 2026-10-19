import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createFingerprintVault } from "../apps/kiosk/src/fingerprint-vault.mjs";
import { createKioskPollClient } from "../apps/kiosk/src/kiosk-poll.mjs";
import { createFingerprintVaultClient } from "../apps/kiosk/src/fingerprint-vault-client.mjs";
import { createFingerprintReset } from "../apps/kiosk/src/fingerprint-reset.mjs";
import { createMappingStore } from "../apps/kiosk/src/mapping-store.mjs";
import { enrollFingerprint } from "../apps/kiosk/src/fingerprint-enrollment.mjs";
import { createFingerprintImporter } from "../apps/kiosk/src/fingerprint-importer.mjs";
import { createFingerprintJournal } from "../apps/kiosk/src/fingerprint-journal.mjs";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";
import { fingerprintVaultBase64, fingerprintVaultEnrollmentId, fingerprintVaultKeyId, sealFingerprintVault, openFingerprintVault } from "../apps/api/src/fingerprint-vault-crypto.ts";

const sessionSecret = "A".repeat(43), vaultSecret = Buffer.alloc(32, 7).toString("base64url");
const tokenHash = (token: string) => createHash("sha256").update(token).digest("base64url");
type Statement = { execute(): unknown };
class Database {
  sqlite = new DatabaseSync(":memory:");
  beforeRun?: (sql: string) => void;
  beforeRead?: (sql: string) => void;
  constructor() {
    for (const file of readdirSync("apps/api/migrations").filter(file => file.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(join("apps/api/migrations", file), "utf8"));
    this.sqlite.exec(`
      INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-01-01'),('operator','primary','operator','operator','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES('primary',0);
      INSERT INTO platform_module_assignment_epochs(installation_id,user_id,revision) VALUES('primary','admin',0),('primary','operator',0);
      INSERT INTO platform_module_assignment_revisions(installation_id,user_id,revision) VALUES('primary','admin',0),('primary','operator',0);
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES('primary','attendance',1),('primary','hour-tracking',1),('primary','carpool',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES('primary','attendance',1,1,'enabled',2,1),('primary','hour-tracking',1,1,'disabled',1,0),('primary','carpool',1,1,'disabled',1,0);
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member','primary','SYN-001','Synthetic','Member','2026-01-01'),('other','primary','SYN-002','Other','Member','2026-01-01');
      INSERT INTO pairing_codes(id,installation_id,code_hash,purpose,expires_at,created_by,created_at) VALUES('pair-a','primary','a','hardware','2099-01-01','admin','2026-01-01'),('pair-b','primary','b','hardware','2099-01-01','admin','2026-01-01');
      INSERT INTO kiosks(id,installation_id,name,token_hash,pairing_code_id,pairing_bound,created_at) VALUES('source','primary','Source','${tokenHash("source-token")}','pair-a',1,'2026-01-01'),('destination','primary','Destination','${tokenHash("destination-token")}','pair-b',1,'2026-01-01');
    `);
    const attendance = bundledModuleRegistry.modules.find(module => module.id === "attendance")!;
    for (const step of attendance.setup.steps.filter(step => step.required)) this.sqlite.prepare("INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) VALUES('primary','attendance',?,2,'completed','2026-01-01','admin')").run(step.id);
  }
  prepare(sql: string) {
    let params: unknown[] = []; const database = this;
    return {
      bind(...values: unknown[]) { params = values; return this; },
      async first<T>() { database.beforeRead?.(sql); return (database.sqlite.prepare(sql).get(...params as []) ?? null) as T | null; },
      async all<T>() { database.beforeRead?.(sql); return { results: database.sqlite.prepare(sql).all(...params as []) as T[] }; },
      async run() { return this.execute(); },
      execute() {
        database.beforeRun?.(sql);
        const statement = database.sqlite.prepare(sql), before = Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n);
        const results = statement.columns().length ? statement.all(...params as []) : (statement.run(...params as []), []);
        return { success: true, results, meta: { changes: Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n) - before } };
      },
    };
  }
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    try { const results = statements.map(statement => statement.execute()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
}
async function fixture(context: TestContext) {
  context.mock.method(globalThis, "fetch", () => { throw new Error("Live providers are forbidden"); });
  const db = new Database(); context.after(() => db.sqlite.close());
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, FINGERPRINT_VAULT_KEY: vaultSecret, DB: db } as unknown as Env;
  const cookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" })}`;
  const call = (path: string, body?: unknown, token?: string, method?: string) => worker.fetch(new Request(`https://api.example.test${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"), headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const enable = async () => {
    const result = await call("/admin/kiosks/fingerprint-vault", { enabled: true, confirmation: "ENABLE CLOUD FINGERPRINT STORAGE" }, undefined, "PATCH");
    assert.equal(result.status, 200, await result.text());
    return (await (await call("/kiosk/fingerprint-vault", undefined, "source-token")).json() as { vaultId: string }).vaultId;
  };
  const upload = (vaultId: string, template = new Uint8Array(1536).fill(11), memberId = "SYN-001", rosterId = memberId === "SYN-002" ? "other" : "member") => call("/kiosk/fingerprint-vault/templates", { vaultId, memberId, rosterId, enrollmentId: "synthetic-existing-enrollment", template: fingerprintVaultBase64(template) }, "source-token");
  return { db, env, call, enable, upload };
}

test("conditional kiosk rosters retain current membership and pairing or module revocation", async context => {
  const f = await fixture(context);
  let rosterReads = 0;
  f.db.beforeRun = sql => { if (sql.includes("SELECT id AS rosterId, external_id AS memberId")) rosterReads++; };
  const read = (etag?: string) => worker.fetch(new Request("https://api.example.test/kiosk/roster", { headers: { authorization: "Bearer source-token", ...(etag ? { "if-none-match": etag } : {}) } }), f.env);
  const initial = await read(); assert.equal(initial.status, 200);
  const etag = initial.headers.get("etag")!; assert.match(etag, /^"kiosk-roster-v1-\d+"$/);
  for (let i = 0; i < 25; i++) { const same = await read(etag); assert.equal(same.status, 304); assert.equal(await same.text(), ""); }
  for (let i = 0; i < 5; i++) { const olderClient = await read(); assert.equal(olderClient.status, 200); assert.equal(((await olderClient.json()) as { members: unknown[] }).members.length, 2); }
  assert.equal(rosterReads, 1);
  f.db.sqlite.exec("UPDATE members SET active=0 WHERE id='member'");
  const changed = await read(etag); assert.equal(changed.status, 200); assert.notEqual(changed.headers.get("etag"), etag);
  assert.equal(((await changed.json()) as { members: { rosterId: string }[] }).members.some(m => m.rosterId === "member"), false);
  const latest = changed.headers.get("etag")!;
  f.db.sqlite.exec("UPDATE kiosks SET token_hash='replacement' WHERE id='source'");
  assert.equal((await read(latest)).status, 401);
  f.db.sqlite.prepare("UPDATE kiosks SET token_hash=? WHERE id='source'").run(tokenHash("source-token"));
  f.db.sqlite.exec("UPDATE platform_modules SET phase='disabled' WHERE module_id='attendance'");
  assert.equal((await read(latest)).status, 409);
});

test("combined poll preserves command, configuration and roster contracts while revalidating unchanged metadata", async context => {
  const f = await fixture(context); const vaultId = await f.enable();
  await f.db.prepare("INSERT INTO kiosk_commands(id,installation_id,kiosk_id,command_type,created_by,created_at) VALUES('reload','primary','source','reload_display','admin',?)").bind(new Date().toISOString()).run();
  const poll = await f.call("/kiosk/poll?v=1&fingerprints=1&config=1", undefined, "source-token");
  assert.equal(poll.status, 200, poll.status === 200 ? "" : await poll.text());
  assert.equal(poll.headers.get("cache-control"), "no-store");
  const data = await poll.json() as any;
  assert.equal(data.protocol, 1);
  assert.deepEqual(data.command, (await (await f.call("/kiosk/commands", undefined, "source-token")).json() as any).command);
  assert.deepEqual(data.configuration, await (await f.call("/kiosk/config", undefined, "source-token")).json());
  assert.deepEqual(data.fingerprints.roster.members, (await (await f.call("/kiosk/roster", undefined, "source-token")).json() as any).members);
  assert.equal(data.fingerprints.vault.vaultId, vaultId);
  assert.equal(data.fingerprints.vault.catalogRevision, 0);
  assert.deepEqual(data.fingerprints.reset, { status: "ok", commands: [] });
  const unchanged = await (await f.call(`/kiosk/poll?v=1&fingerprints=1&rosterRevision=${data.fingerprints.roster.revision}`, undefined, "source-token")).json() as any;
  assert.deepEqual(unchanged.fingerprints.roster, { status: "ok", revision: data.fingerprints.roster.revision, notModified: true });
  assert.equal(unchanged.configuration, undefined);
  f.db.sqlite.exec("UPDATE members SET first_name='Changed' WHERE id='member'");
  const changed = await (await f.call(`/kiosk/poll?v=1&fingerprints=1&rosterRevision=${data.fingerprints.roster.revision}`, undefined, "source-token")).json() as any;
  assert.equal(changed.fingerprints.roster.notModified, false);
  assert.equal(changed.fingerprints.roster.members.find((member: any) => member.rosterId === "member").firstName, "Changed");
  const commandOnly = await (await f.call("/kiosk/poll?v=1", undefined, "source-token")).json() as any;
  assert.deepEqual(Object.keys(commandOnly).sort(), ["command", "protocol"]);
  for (const query of ["v=2", "v=1&v=1", "v=1&config=0", "v=1&fingerprints=1&rosterRevision=-1", "v=1&peerAfter=anything", "v=1&unknown=1"]) {
    assert.equal((await f.call(`/kiosk/poll?${query}`, undefined, "source-token")).status, 400);
  }
  assert.equal((await f.call("/kiosk/poll?v=1", undefined, "invalid-token")).status, 401);
});

test("poll keeps commands available during vault failure, pending reset and maintenance without exposing sharing metadata", async context => {
  const f = await fixture(context); await f.enable();
  f.env.FINGERPRINT_VAULT_KEY = undefined;
  let data = await (await f.call("/kiosk/poll?v=1&fingerprints=1", undefined, "source-token")).json() as any;
  assert.equal(data.protocol, 1); assert.equal(data.fingerprints.vault.status, "unavailable");
  assert.equal(data.fingerprints.reset.status, "ok"); assert.equal(data.fingerprints.roster.status, "ok");
  f.env.FINGERPRINT_VAULT_KEY = vaultSecret;
  f.db.sqlite.exec("INSERT INTO kiosk_fingerprint_reset_batches(id,installation_id,actor_user_id,created_at) VALUES('reset','primary','admin',1); INSERT INTO kiosk_fingerprint_reset_commands(id,batch_id,installation_id,kiosk_id,pairing_id,created_at) VALUES('reset-one','reset','primary','source','pair-a',1)");
  data = await (await f.call("/kiosk/poll?v=1&fingerprints=1", undefined, "source-token")).json() as any;
  assert.equal(data.fingerprints.reset.commands[0].id, "reset-one");
  assert.equal(data.fingerprints.peer.status, "reset_pending"); assert.deepEqual(data.fingerprints.peer.deliveries, []);
  assert.equal(data.fingerprints.peer.syncId, null); assert.equal(data.fingerprints.vault.vaultId, null);
  assert.equal(data.fingerprints.vault.status, "reset_pending");
  f.env.UPDATE_REPOSITORY = "example/installation";
  f.db.sqlite.exec(`INSERT INTO web_update_requests(id,installation_id,release_tag,release_sha,release_notes,previous_version,state,stage,maintenance,created_at,expires_at,updated_at) VALUES('update','primary','v2.0.0-beta.3','${"a".repeat(40)}','Synthetic','2.0.0-beta.2','succeeded','done',1,'2026-01-01','2026-01-02','2026-01-01')`);
  const maintenance = await f.call("/kiosk/poll?v=1&fingerprints=1&config=1", undefined, "source-token");
  assert.equal(maintenance.status, 200); data = await maintenance.json();
  assert.equal(data.configuration.kiosk.id, "source"); assert.equal(data.command, null);
  assert.deepEqual(data.fingerprints.reset, { status: "unavailable", commands: [] });
  assert.equal(data.fingerprints.vault.status, "unavailable"); assert.equal(data.fingerprints.vault.vaultId, null);
  assert.equal(data.fingerprints.peer.status, "unavailable"); assert.deepEqual(data.fingerprints.peer.deliveries, []);
  assert.equal((await f.call("/kiosk/heartbeat", { readerOnline: true, releaseVersion: "synthetic" }, "source-token")).status, 503);
  delete f.env.UPDATE_REPOSITORY;
  const withoutUpdater = await f.call("/kiosk/poll?v=1&fingerprints=1&config=1", undefined, "source-token");
  assert.equal(withoutUpdater.status, 200); assert.deepEqual(await withoutUpdater.json(), data);
  assert.equal((await f.call("/kiosk/heartbeat", { readerOnline: true, releaseVersion: "synthetic" }, "source-token")).status, 503);
  assert.equal((await f.call("/kiosk/fingerprint-vault", undefined, "source-token")).status, 503);
});

test("poll retains the existing ten-thousand-member roster limit and refuses a truncated authority snapshot", async context => {
  const f = await fixture(context);
  f.db.sqlite.exec("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<9998) INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) SELECT 'bulk-'||x,'primary','bulk-'||x,'Synthetic','Member','2026-01-01' FROM n");
  let data = await (await f.call("/kiosk/poll?v=1&fingerprints=1", undefined, "source-token")).json() as any;
  assert.equal(data.fingerprints.roster.status, "ok"); assert.equal(data.fingerprints.roster.members.length, 10000);
  f.db.sqlite.exec("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('overflow','primary','overflow','Synthetic','Member','2026-01-01')");
  data = await (await f.call("/kiosk/poll?v=1&fingerprints=1", undefined, "source-token")).json() as any;
  assert.equal(data.command, null); assert.deepEqual(data.fingerprints.roster, { status: "unavailable" });
});

test("poll denies revoked credentials, pairing or module epochs and validates authority inside its transaction", async context => {
  const f = await fixture(context);
  f.db.sqlite.exec("UPDATE kiosks SET pairing_bound=0 WHERE id='source'");
  let data = await (await f.call("/kiosk/poll?v=1&fingerprints=1&config=1", undefined, "source-token")).json() as any;
  assert.equal(data.configuration.kiosk.id, "source"); assert.equal(data.fingerprints.reset.status, "unavailable"); assert.equal(data.fingerprints.roster.status, "unavailable");
  f.db.sqlite.exec("UPDATE kiosks SET pairing_bound=1,active=0 WHERE id='source'");
  assert.equal((await f.call("/kiosk/poll?v=1", undefined, "source-token")).status, 401);
  f.db.sqlite.exec("UPDATE kiosks SET active=1 WHERE id='source'");
  let injected = false;
  f.db.beforeRun = sql => {
    if (!injected && sql.includes("WITH current_kiosk AS MATERIALIZED")) { injected = true; f.db.sqlite.exec("DELETE FROM platform_module_administration_epochs"); }
  };
  assert.equal((await f.call("/kiosk/poll?v=1&fingerprints=1", undefined, "source-token")).status, 403);
  assert.equal(injected, true);
  f.db.beforeRun = undefined;
  f.db.sqlite.exec("DELETE FROM platform_module_epochs WHERE module_id='attendance'");
  assert.equal((await f.call("/kiosk/poll?v=1", undefined, "source-token")).status, 409);
});

test("durable fingerprint catalog revision covers uploads, grants, member revocation and configuration changes", async context => {
  const f = await fixture(context); const vaultId = await f.enable();
  const revision = () => Number(f.db.sqlite.prepare("SELECT catalog_revision AS revision FROM kiosk_fingerprint_vault_settings").get()?.revision);
  const advances = async (change: () => unknown) => { const before = revision(); await change(); assert.ok(revision() > before); };
  await advances(async () => assert.equal((await f.upload(vaultId)).status, 200));
  await advances(() => f.db.sqlite.exec("INSERT INTO kiosk_fingerprint_retired_review_grants(installation_id,grant_id) VALUES('primary','synthetic-existing-enrollment')"));
  assert.deepEqual((await (await f.call("/kiosk/fingerprint-vault/templates", undefined, "destination-token")).json() as any).fingerprints, []);
  await advances(() => f.db.sqlite.exec("UPDATE kiosk_fingerprint_retired_review_grants SET grant_id='other-grant'"));
  await advances(() => f.db.sqlite.exec("DELETE FROM kiosk_fingerprint_retired_review_grants"));
  await advances(() => f.db.sqlite.exec("UPDATE members SET external_id='SYN-RENAMED' WHERE id='member'"));
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS total FROM kiosk_fingerprint_vault_templates").get()?.total, 0);
  await advances(() => f.db.sqlite.exec("UPDATE kiosk_fingerprint_vault_settings SET enabled=0"));
  const poll = await (await f.call("/kiosk/poll?v=1&fingerprints=1", undefined, "source-token")).json() as any;
  assert.deepEqual(poll.fingerprints.vault, { status: "ok", enabled: false, vaultId: null, catalogRevision: null });
});

test("fingerprint vault crypto binds installation, member, generation, content and key without plaintext persistence", async () => {
  const template = new Uint8Array(1536).fill(17), binding = { vaultId: "v".repeat(64), keyId: await fingerprintVaultKeyId(vaultSecret), fingerprintId: "f".repeat(64), memberId: "member", templateDigest: "unused", sourceKioskId: "source", sourcePairingId: "pair-a", enrollmentId: "synthetic-enrollment", createdAt: 123 };
  const { fingerprintVaultDigest } = await import("../apps/api/src/fingerprint-vault-crypto.ts");
  binding.templateDigest = await fingerprintVaultDigest(vaultSecret, template);
  const first = await sealFingerprintVault(template, binding, vaultSecret), second = await sealFingerprintVault(template, binding, vaultSecret);
  assert.notEqual(first.nonce, second.nonce); assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(await openFingerprintVault(first, binding, vaultSecret), template);
  for (const changed of ["vaultId", "keyId", "fingerprintId", "memberId", "templateDigest", "sourceKioskId", "sourcePairingId", "enrollmentId"] as const) await assert.rejects(openFingerprintVault(first, { ...binding, [changed]: "changed" }, vaultSecret), /could not be decrypted/);
  await assert.rejects(openFingerprintVault(first, { ...binding, createdAt: 456 }, vaultSecret), /could not be decrypted/);
  await assert.rejects(openFingerprintVault(first, binding, Buffer.alloc(32, 8).toString("base64url")), /could not be decrypted/);
  await assert.rejects(fingerprintVaultKeyId("B".repeat(43)), /valid separate FINGERPRINT_VAULT_KEY/);
});

test("fingerprint vault is default-off and requires explicit Admin consent and a separate recoverable key", async context => {
  const { env, call, enable, db } = await fixture(context);
  assert.deepEqual(await (await call("/admin/kiosks/fingerprint-vault")).json(), { enabled: false, keyStatus: "ready", storedFingerprints: 0, serverManagedKeys: true });
  assert.deepEqual(await (await call("/kiosk/fingerprint-vault", undefined, "source-token")).json(), { enabled: false, vaultId: null });
  assert.equal((await call("/admin/kiosks/fingerprint-vault", { enabled: true }, undefined, "PATCH")).status, 400);
  env.FINGERPRINT_VAULT_KEY = undefined;
  assert.equal((await call("/admin/kiosks/fingerprint-vault", { enabled: true, confirmation: "ENABLE CLOUD FINGERPRINT STORAGE" }, undefined, "PATCH")).status, 503);
  env.FINGERPRINT_VAULT_KEY = vaultSecret; await enable();
  env.FINGERPRINT_VAULT_KEY = Buffer.alloc(32, 8).toString("base64url");
  assert.equal((await call("/kiosk/fingerprint-vault", undefined, "source-token")).status, 503);
  assert.equal((await call("/admin/kiosks/fingerprint-vault", { enabled: true, confirmation: "ENABLE CLOUD FINGERPRINT STORAGE" }, undefined, "PATCH")).status, 503);
  assert.equal(db.sqlite.prepare("SELECT enabled FROM kiosk_fingerprint_vault_settings").get()?.enabled, 1);
  env.FINGERPRINT_VAULT_KEY = undefined;
  assert.equal((await call("/admin/kiosks/fingerprint-vault", { enabled: false, confirmation: "DISABLE CLOUD FINGERPRINT STORAGE" }, undefined, "PATCH")).status, 200);
});

test("durable vault deduplicates concurrent exact uploads and serves an authorized destination with source offline or retired", async context => {
  const { db, call, enable, upload } = await fixture(context), vaultId = await enable();
  const results = await Promise.all([upload(vaultId), upload(vaultId)]);
  assert.deepEqual(results.map(response => response.status), [200, 200]);
  const first = await results[0].json() as { fingerprintId: string };
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 1);
  const record = db.sqlite.prepare("SELECT * FROM kiosk_fingerprint_vault_templates").get()!;
  assert.notEqual(record.ciphertext, Buffer.alloc(1536, 11).toString("base64"));
  db.sqlite.exec("UPDATE kiosks SET active=0 WHERE id='source'");
  const list = await call("/kiosk/fingerprint-vault/templates", undefined, "destination-token");
  assert.deepEqual(await list.json(), { vaultId, fingerprints: [{ fingerprintId: first.fingerprintId, memberId: "SYN-001", rosterId: "member" }] });
  const restored = await call(`/kiosk/fingerprint-vault/templates/${first.fingerprintId}`, undefined, "destination-token");
  assert.equal(restored.status, 200);
  assert.equal((await restored.json() as { template: string }).template, Buffer.alloc(1536, 11).toString("base64"));
  assert.equal((await call(`/kiosk/fingerprint-vault/templates/${first.fingerprintId}`)).status, 401);
  assert.equal((await call(`/admin/kiosks/fingerprint-vault/templates/${first.fingerprintId}`)).status, 404);
  assert.equal((await upload(vaultId)).status, 401);
});

test("vault refuses member rebinding, invalid content, legacy pairing and malformed pagination", async context => {
  const { db, call, enable, upload } = await fixture(context), vaultId = await enable();
  assert.equal((await upload(vaultId)).status, 200);
  assert.equal((await upload(vaultId, undefined, "SYN-002")).status, 409);
  assert.equal((await upload(vaultId, new Uint8Array(15))).status, 400);
  for (const query of ["after=bad", "after=" + "a".repeat(64) + "&after=" + "b".repeat(64), "extra=value"]) assert.equal((await call(`/kiosk/fingerprint-vault/templates?${query}`, undefined, "destination-token")).status, 400);
  db.sqlite.exec("UPDATE kiosks SET pairing_bound=0 WHERE id='destination'");
  assert.equal((await call("/kiosk/fingerprint-vault", undefined, "destination-token")).status, 409);
});

test("vault closes in-flight source retirement and token replacement races without storing a template", async context => {
  for (const change of ["UPDATE kiosks SET active=0 WHERE id='source'", "UPDATE kiosks SET token_hash='replacement' WHERE id='source'"]) {
    const { db, enable, upload } = await fixture(context), vaultId = await enable();
    db.beforeRun = sql => { if (sql.includes("INSERT INTO kiosk_fingerprint_vault_templates")) { db.beforeRun = undefined; db.sqlite.exec(change); } };
    assert.equal((await upload(vaultId)).status, 409);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 0);
  }
});

test("vault rechecks receiving authority after decryption and never releases a revoked member template", async context => {
  const { db, call, enable, upload } = await fixture(context), vaultId = await enable();
  const id = (await (await upload(vaultId)).json() as { fingerprintId: string }).fingerprintId;
  db.beforeRun = sql => { if (sql.includes("SELECT 1 AS valid FROM kiosk_fingerprint_vault_templates")) { db.beforeRun = undefined; db.sqlite.exec("UPDATE members SET active=0 WHERE id='member'"); } };
  const result = await call(`/kiosk/fingerprint-vault/templates/${id}`, undefined, "destination-token");
  assert.equal(result.status, 409); assert.equal((await result.text()).includes(Buffer.alloc(1536, 11).toString("base64")), false);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 0);
});

test("vault cloud revocation is destructive only to cloud operational state and cannot revive old authority", async context => {
  for (const change of ["UPDATE members SET external_id='SYN-CHANGED' WHERE id='member'", "UPDATE platform_modules SET phase='retained',disabled_at='2026-01-01',delete_after='2026-01-08' WHERE module_id='attendance'", "DELETE FROM kiosk_fingerprint_vault_settings", "UPDATE kiosk_fingerprint_vault_settings SET enabled=0"]) {
    const { db, enable, upload } = await fixture(context), vaultId = await enable();
    assert.equal((await upload(vaultId)).status, 200); db.sqlite.exec(change);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 0, change);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosks").get()?.n, 2);
  }
  const { db, call, enable, upload } = await fixture(context), old = await enable();
  assert.equal((await upload(old)).status, 200);
  await call("/admin/kiosks/fingerprint-vault", { enabled: false, confirmation: "DISABLE CLOUD FINGERPRINT STORAGE" }, undefined, "PATCH");
  const fresh = await enable(); assert.notEqual(fresh, old); assert.equal((await upload(old)).status, 400);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action='kiosk.fingerprint_vault_configured'").get()?.n, 3);
});

test("vault tables are Attendance-owned, immutable and excluded from portable backups", async context => {
  const { db, enable, upload } = await fixture(context), vaultId = await enable(); await upload(vaultId);
  assert.throws(() => db.sqlite.exec("UPDATE kiosk_fingerprint_vault_templates SET member_id='other'"), /immutable/);
  const attendance = bundledModuleRegistry.modules.find(module => module.id === "attendance")!;
  for (const name of ["kiosk_fingerprint_vault_settings", "kiosk_fingerprint_vault_templates"]) {
    assert.ok(attendance.persistence.tables.includes(name)); assert.ok(attendance.backup.nonPortableTables?.includes(name));
    assert.equal(attendance.backup.tables.includes(name), false); assert.ok(attendance.lifecycle.cleanupTargets.includes(name));
  }
});

test("portable installation export excludes vault data and restore drops its authority and ciphertext", async context => {
  const { db, call, enable, upload } = await fixture(context), vaultId = await enable(); await upload(vaultId);
  const exported = await call("/admin/data/backup?scope=installation"); assert.equal(exported.status, 200);
  const backup = await exported.json() as { tables: Record<string, unknown> };
  assert.equal("kiosk_fingerprint_vault_templates" in backup.tables, false);
  assert.equal("kiosk_fingerprint_vault_settings" in backup.tables, false);
  const restored = await call("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup });
  assert.equal(restored.status, 200, await restored.text());
  for (const table of ["kiosk_fingerprint_vault_settings", "kiosk_fingerprint_vault_templates"]) assert.equal(db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
});

test("vault reads pause in update maintenance and an Operator cannot change cloud privacy", async context => {
  const { db, env, call, enable, upload } = await fixture(context), vaultId = await enable(); await upload(vaultId);
  const cookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "operator", role: "operator" })}`;
  const denied = await worker.fetch(new Request("https://api.example.test/admin/kiosks/fingerprint-vault", { headers: { cookie } }), env);
  assert.equal(denied.status, 403);
  env.UPDATE_REPOSITORY = "example/private-installation";
  db.sqlite.exec(`INSERT INTO web_update_requests(id,installation_id,release_tag,release_sha,release_notes,previous_version,state,created_at,expires_at,updated_at,maintenance)
    VALUES('maintenance','primary','v2.0.0','synthetic','', '1.2.5','recovery_required','2026-01-01','2099-01-01','2026-01-01',1)`);
  assert.equal((await call("/kiosk/fingerprint-vault/templates", undefined, "destination-token")).status, 503);
  assert.equal((await upload(vaultId)).status, 503);
});

async function runtimeFixture(context: TestContext, existing: Awaited<ReturnType<typeof fixture>>, kiosk = "source", capacity = 5) {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-synthetic-vault-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const mappings = createMappingStore(join(directory, "mappings.json")), models = new Map<number, Uint8Array>();
  let writes = 0, reads = 0, dropUploadAck = false, failMapping = false, failRemoval = false;
  const config = { kioskId: kiosk, pairingId: kiosk === "source" ? "pair-a" : "pair-b", apiUrl: "https://api.example.test", kioskToken: `${kiosk}-token` };
  const request = async (path: string, body?: unknown) => {
    const result = await existing.call(path, body, config.kioskToken);
    if (!result.ok) throw new Error("Synthetic request rejected");
    const value = await result.json();
    if (body && dropUploadAck) { dropUploadAck = false; throw new Error("Synthetic lost acknowledgement"); }
    return value;
  };
  const client = {
    configuration: () => request("/kiosk/fingerprint-vault"),
    store: (value: unknown) => request("/kiosk/fingerprint-vault/templates", value),
    list: (after?: string) => request(`/kiosk/fingerprint-vault/templates${after ? `?after=${after}` : ""}`),
    template: (id: string) => request(`/kiosk/fingerprint-vault/templates/${id}`),
  };
  const sensor = { occupiedSlots: async () => [...models.keys()] };
  const templates = {
    exportTemplate: async (slot: number) => { reads++; const bytes = models.get(slot); if (!bytes) throw new Error("Synthetic slot empty"); return new Uint8Array(bytes); },
    importTemplate: async (slot: number, bytes: Uint8Array) => { assert.equal(models.has(slot), false, "Never overwrite an occupied synthetic slot"); writes++; models.set(slot, new Uint8Array(bytes)); return { slot, verified: true }; },
  };
  const wrappedMappings = { ...mappings, replace: async (value: Parameters<typeof mappings.replace>[0]) => {
    if (failRemoval) { failRemoval = false; throw new Error("Synthetic removal interrupted"); }
    return mappings.replace(value);
  }, assignIfUnmapped: async (...args: Parameters<typeof mappings.assignIfUnmapped>) => {
    if (failMapping) { failMapping = false; throw new Error("Synthetic mapping interrupted"); }
    return mappings.assignIfUnmapped(...args);
  } };
  let lock = Promise.resolve();
  const withSensor = <T>(operation: () => Promise<T>) => { const current = lock.then(operation); lock = current.then(() => undefined, () => undefined); return current; };
  const factory = () => createFingerprintVault({ directory, config, client, sensor, templates, mappings: wrappedMappings, withSensor, fetchRoster: () => request("/kiosk/roster"), capacity });
  return { directory, config, client, request, models, mappings, sensor, templates, withSensor, factory, counts: () => ({ reads, writes }), loseUploadAck: () => { dropUploadAck = true; }, interruptMapping: () => { failMapping = true; }, interruptRemoval: () => { failRemoval = true; } };
}

const freshEnrollment = (id = "11111111-1111-4111-8111-111111111111") => ({ id, occurredAt: 1 });

test("automatic cloud runtime exports fresh immutable enrollments and provisions a new kiosk with every source offline", async context => {
  const current = await fixture(context); await current.enable();
  const source = await runtimeFixture(context, current), destination = await runtimeFixture(context, current, "destination");
  source.models.set(2, new Uint8Array(1536).fill(31)); source.models.set(4, new Uint8Array(1536).fill(99));
  await source.mappings.replace({ 2: { memberId: "SYN-001", rosterId: "member", finger: "right index", enrollment: freshEnrollment() } });
  const sourceController = source.factory(); assert.equal((await sourceController.tick()).uploaded, 1); assert.equal(source.counts().reads, 1);
  current.db.sqlite.exec("UPDATE kiosks SET active=0 WHERE id='source'");
  destination.models.set(0, new Uint8Array(1536).fill(90));
  const receiver = destination.factory(); assert.equal((await receiver.tick()).received, 1);
  assert.deepEqual(await destination.mappings.read(), { 1: { memberId: "SYN-001", rosterId: "member", finger: "synced fingerprint" } });
  assert.equal(destination.models.get(0)?.[0], 90); assert.equal(destination.models.get(1)?.[0], 31); assert.equal(destination.counts().writes, 1);
  await receiver.tick(); await destination.factory().tick(); assert.equal(destination.counts().writes, 1);
  assert.equal(destination.counts().reads, 0, "Imported copies never become new local source enrollments");
  for (const file of await readdir(destination.directory, { recursive: true })) {
    if (!file.endsWith(".json")) continue;
    const metadata = await readFile(join(destination.directory, file), "utf8");
    assert.equal(metadata.includes(Buffer.alloc(1536, 31).toString("base64")), false); assert.equal(metadata.includes("ciphertext"), false);
  }
});

test("cloud runtime blocks legacy and recycled identities without reading sensor templates", async context => {
  const current = await fixture(context); const vaultId = await current.enable(), source = await runtimeFixture(context, current);
  source.models.set(0, new Uint8Array(1536).fill(32));
  await source.mappings.replace({ 0: { memberId: "SYN-001", finger: "legacy" } });
  assert.equal((await source.factory().tick()).legacyMappings, 1); assert.equal(source.counts().reads, 0);
  await source.mappings.replace({ 0: { memberId: "SYN-001", rosterId: "old-roster-row", finger: "right index" } });
  assert.equal((await source.factory().tick()).legacyMappings, 1); assert.equal(source.counts().reads, 0);
  await source.mappings.replace({ 0: { memberId: "SYN-001", rosterId: "member", finger: "synced fingerprint" } });
  assert.equal((await source.factory().tick()).uploaded, 0); assert.equal(source.counts().reads, 0, "An imported-only identity cannot be turned into fresh enrollment authority");
  assert.equal((await current.upload(vaultId, undefined, "SYN-001", "old-roster-row")).status, 409);
  assert.equal(current.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 0);
});

test("new enrollment persists immutable roster identity and mapping edits preserve it", async context => {
  const current = await fixture(context), source = await runtimeFixture(context, current);
  const sensor = { enroll: async (slot: number) => { source.models.set(slot, new Uint8Array(1536).fill(33)); } };
  await enrollFingerprint({ sensor, mappings: source.mappings, withSensor: source.withSensor, slot: 1, memberId: "SYN-001", rosterId: "member", finger: "right index" });
  const mapping = (await source.mappings.read())["1"]; assert.equal(mapping.rosterId, "member");
  await source.mappings.replace(await source.mappings.read()); assert.equal((await source.mappings.read())["1"].rosterId, "member");
  await assert.rejects(source.mappings.assignIfUnmapped(1, "SYN-001", "other", undefined, "recycled-row"), /roster identity/);
});

test("lost upload acknowledgement and interrupted destination mapping retry without duplicate models or flash overwrites", async context => {
  const current = await fixture(context); await current.enable(); const source = await runtimeFixture(context, current), destination = await runtimeFixture(context, current, "destination");
  source.models.set(1, new Uint8Array(1536).fill(34)); await source.mappings.replace({ 1: { memberId: "SYN-001", rosterId: "member", finger: "right thumb", enrollment: freshEnrollment() } });
  source.loseUploadAck(); const sender = source.factory(); await sender.tick(); await sender.tick();
  assert.equal(current.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 1); assert.equal(source.counts().writes, 0);
  destination.interruptMapping(); await destination.factory().tick(); assert.equal(destination.counts().writes, 1); assert.deepEqual(await destination.mappings.read(), {});
  await destination.factory().tick(); assert.equal(destination.counts().writes, 1); assert.equal((await destination.mappings.read())["0"].rosterId, "member");
});

test("completed cloud copies are not silently remapped after local removal and full readers fail closed", async context => {
  const current = await fixture(context), vaultId = await current.enable(); await current.upload(vaultId);
  const destination = await runtimeFixture(context, current, "destination"); await destination.factory().tick();
  await destination.mappings.replace({}); assert.equal((await destination.factory().tick()).status, "needs_attention");
  assert.equal(destination.counts().writes, 1); assert.deepEqual(await destination.mappings.read(), {});
  const full = await runtimeFixture(context, current, "destination", 2); full.models.set(0, new Uint8Array(1536).fill(80)); full.models.set(1, new Uint8Array(1536).fill(81));
  assert.equal((await full.factory().tick()).status, "needs_attention"); assert.equal(full.counts().writes, 0); assert.deepEqual(await full.mappings.read(), {});
});

test("cloud runtime default-off, disabled Attendance and maintenance never export or import reader data", async context => {
  const current = await fixture(context), source = await runtimeFixture(context, current);
  source.models.set(0, new Uint8Array(1536).fill(35)); await source.mappings.replace({ 0: { memberId: "SYN-001", rosterId: "member", finger: "right index", enrollment: freshEnrollment() } });
  const controller = source.factory(); assert.equal((await controller.tick()).status, "disabled"); assert.deepEqual(source.counts(), { reads: 0, writes: 0 });
  await current.enable(); current.env.UPDATE_REPOSITORY = "example/private-installation";
  current.db.sqlite.exec(`INSERT INTO web_update_requests(id,installation_id,release_tag,release_sha,release_notes,previous_version,state,created_at,expires_at,updated_at,maintenance)
    VALUES('maintenance','primary','v2.0.0','synthetic','', '1.2.5','recovery_required','2026-01-01','2099-01-01','2026-01-01',1)`);
  assert.equal((await controller.tick()).status, "unavailable"); assert.deepEqual(source.counts(), { reads: 0, writes: 0 });
  current.db.sqlite.exec("DELETE FROM web_update_requests; UPDATE platform_modules SET phase='retained',disabled_at='2026-01-01',delete_after='2026-01-08' WHERE module_id='attendance'");
  await controller.tick(); assert.deepEqual(source.counts(), { reads: 0, writes: 0 });
});

test("vault client authenticates bounded HTTPS requests, refuses malformed cursors and redacts error bodies", async () => {
  const config = { apiUrl: "https://api.example.test", kioskToken: "synthetic-not-a-real-token" };
  const calls: { url: string; options: RequestInit }[] = [];
  const client = createFingerprintVaultClient(config, { fetchImpl: async (url: string, options: RequestInit) => {
    calls.push({ url, options }); return Response.json({ enabled: false });
  } });
  await client.configuration(); assert.equal(calls[0].url, "https://api.example.test/kiosk/fingerprint-vault");
  assert.equal(calls[0].options.redirect, "error"); assert.ok(calls[0].options.signal); assert.equal((calls[0].options.headers as Record<string, string>).authorization, `Bearer ${config.kioskToken}`);
  await assert.rejects(async () => client.list("../bad"), /Invalid fingerprint vault identifier/); assert.equal(calls.length, 1);
  for (const fetchImpl of [async () => new Response("synthetic-secret-error", { status: 503 }), async () => new Response("x".repeat(32769)), async () => { throw new Error(`synthetic-secret-error ${config.kioskToken}`); }]) {
    const denied = createFingerprintVaultClient(config, { fetchImpl });
    await assert.rejects(denied.configuration(), error => error instanceof Error && /synchronization will retry/.test(error.message) && !error.message.includes("synthetic-secret"));
  }
  assert.throws(() => createFingerprintVaultClient({ ...config, apiUrl: "http://unsafe.example.test" }), /HTTPS/);
});

test("unanchored peer-received copies never acquire current immutable identity or become cloud-upload eligible", async context => {
  const current = await fixture(context); await current.enable(); const destination = await runtimeFixture(context, current, "destination");
  const binding = { installationId: "peer-installation", kioskId: "destination", pairingId: "pair-b" };
  const journal = createFingerprintJournal(join(destination.directory, "peer-received.json"), binding);
  const receiver = createFingerprintImporter({ journal, sensor: destination.sensor, templates: destination.templates, mappings: destination.mappings, withSensor: destination.withSensor, isMemberActive: async () => true });
  await receiver.receive({ installationId: binding.installationId, senderId: "source", senderPairingId: "pair-a", senderKeyId: "a".repeat(64), recipientId: "destination", recipientPairingId: "pair-b", memberId: "SYN-001", enrollmentId: "old-queued-peer-enrollment", transferId: "old-queued-peer-transfer", revision: 1 }, new Uint8Array(1536).fill(36), "b".repeat(64));
  const mapping = (await destination.mappings.read())["0"]; assert.equal(mapping.rosterId, undefined);
  assert.equal((await destination.factory().tick()).legacyMappings, 1); assert.equal(destination.counts().reads, 0);
  current.db.sqlite.exec("UPDATE members SET external_id='SYN-OLD' WHERE id='member'; INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('recycled-row','primary','SYN-001','Different','Member','2026-01-02')");
  assert.equal((await destination.factory().tick()).legacyMappings, 1); assert.equal(destination.counts().reads, 0);
  assert.equal((await destination.mappings.read())["0"].rosterId, undefined);
  assert.equal(current.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 0);
});

test("explicit same-slot replacement supersedes local metadata without downloading historical models or overwriting reader bytes", async context => {
  const current = await fixture(context); await current.enable(); const source = await runtimeFixture(context, current);
  source.models.set(1, new Uint8Array(1536).fill(41));
  await source.mappings.replace({ 1: { memberId: "SYN-001", rosterId: "member", finger: "right index", enrollment: { id: "00000000-0000-0000-0000-000000000001", occurredAt: 1 } } });
  const controller = source.factory(); assert.equal((await controller.tick()).status, "ready");
  source.models.set(1, new Uint8Array(1536).fill(42));
  await source.mappings.replace({ 1: { memberId: "SYN-001", rosterId: "member", finger: "right index", enrollment: { id: "00000000-0000-0000-0000-000000000002", occurredAt: 2 } } });
  assert.equal((await controller.tick()).status, "ready"); assert.equal((await controller.tick()).status, "ready");
  assert.equal(current.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 2);
  assert.equal(source.counts().writes, 0); assert.deepEqual([...source.models.keys()], [1]);
  assert.equal((await source.factory().tick()).status, "ready"); assert.deepEqual([...source.models.keys()], [1]);
  const vaultId = (await current.call("/kiosk/fingerprint-vault", undefined, "source-token").then(response => response.json()) as { vaultId: string }).vaultId;
  const journalPath = join(source.directory, "source-pair-a", vaultId, "received.json");
  const records = JSON.parse(await readFile(journalPath, "utf8")).records;
  assert.equal(records.filter((record: { phase: string }) => record.phase === "superseded").length, 1);
  assert.equal(records.filter((record: { phase: string }) => record.phase === "complete").length, 1);
  await source.mappings.replace({}); await source.factory().tick();
  assert.deepEqual(await source.mappings.read(), {}); assert.deepEqual([...source.models.keys()], [1]); assert.equal(source.counts().writes, 0);
});

test("real Worker cloud refuses legacy association backfill, shares fresh re-enrollment, and performs only mappings reset", async context => {
  const current = await fixture(context); await current.enable(); const source = await runtimeFixture(context, current), destination = await runtimeFixture(context, current, "destination");
  source.models.set(4, new Uint8Array(1536).fill(51)); source.models.set(0, new Uint8Array(1536).fill(95));
  await source.mappings.replace({ 4: { memberId: "SYN-OLD", finger: "original thumb" } });
  let sourceVault = source.factory();
  const resetClient = {
    commands: () => source.request("/kiosk/fingerprint-reset/commands"),
    complete: (id: string) => source.request(`/kiosk/fingerprint-reset/commands/${id}/acknowledge`, { completed: true }),
  };
  const resetController = createFingerprintReset({ directory: source.directory, config: source.config, client: resetClient,
    mappings: source.mappings, withSensor: source.withSensor, stopTransfers: async () => { await sourceVault.stopForReset(); } });
  assert.equal((await resetController.tick()).status, "idle");
  assert.equal((await sourceVault.tick()).uploaded, 0); assert.equal(source.counts().reads, 0);
  const review = { manifestId: "a".repeat(64), revision: 1, vaultId: null, reviewGrantId: "retired-grant", mappingDigest: "b".repeat(64), slotProof: "c".repeat(64), originalMemberId: "SYN-OLD", approvedMemberId: "SYN-001", rosterId: "member", sourceSlot: 4 };
  await source.mappings.replace({ 4: { memberId: "SYN-001", rosterId: "member", finger: "original thumb", enrollment: freshEnrollment(), review } });
  assert.equal((await sourceVault.tick()).uploaded, 0); assert.equal(source.counts().reads, 0);
  const sensor = { enroll: async (slot: number, options: { replaceExisting: boolean }) => { assert.equal(options.replaceExisting, true); source.models.set(slot, new Uint8Array(1536).fill(52)); } };
  await enrollFingerprint({ sensor, mappings: source.mappings, withSensor: source.withSensor, slot: 4, memberId: "SYN-001", rosterId: "member", finger: "new thumb", replaceExisting: true, isEnrollmentAllowed: resetController.enrollmentAllowed });
  const mapping = (await source.mappings.read())[4]; assert.equal(mapping.review, undefined); assert.equal(mapping.rosterId, "member");
  assert.equal((await sourceVault.tick()).uploaded, 1);
  const stored = current.db.sqlite.prepare("SELECT enrollment_id AS enrollmentId FROM kiosk_fingerprint_vault_templates").get(); assert.equal(stored?.enrollmentId, mapping.enrollment.id);
  // No source calls are made while the new kiosk provisions from the server.
  destination.models.set(0, new Uint8Array(1536).fill(96)); assert.equal((await destination.factory().tick()).received, 1);
  assert.equal(destination.models.get(0)?.[0], 96); assert.equal(destination.models.get(1)?.[0], 52);
  const reset = await current.call("/admin/kiosks/fingerprint-reset", { resetId: "synthetic-reset", confirmation: "RESET ALL FINGERPRINT MAPPINGS" }); assert.equal(reset.status, 200, await reset.text());
  assert.equal(current.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 0);
  assert.equal((await sourceVault.tick()).status, "disabled"); assert.equal((await resetController.tick()).status, "reset"); assert.deepEqual(await source.mappings.read(), {});
  assert.equal((await sourceVault.tick()).status, "reset"); assert.deepEqual([...source.models.keys()], [4, 0]); assert.equal(source.models.get(4)?.[0], 52);
  assert.equal(current.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_reset_commands WHERE acknowledged_at IS NULL").get()?.n, 1, "The offline destination remains visibly pending");
});


test("stable enrollment receipts deduplicate changed bytes, concurrent retries and legacy source backfill", async context => {
  const f = await fixture(context), vaultId = await f.enable();
  const responses = await Promise.all([f.upload(vaultId, new Uint8Array(1536).fill(71)), f.upload(vaultId, new Uint8Array(1536).fill(72))]);
  for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
  const first = await responses[0].json() as any, second = await responses[1].json() as any;
  assert.equal(first.fingerprintId, second.fingerprintId);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 1);
  const original = f.db.sqlite.prepare("SELECT ciphertext,nonce FROM kiosk_fingerprint_vault_templates").get();
  f.db.sqlite.exec("DELETE FROM kiosk_fingerprint_vault_enrollments");
  const retry = await f.upload(vaultId, new Uint8Array(1536).fill(73));
  assert.equal(retry.status, 200); assert.equal((await retry.json() as any).templateMatches, false);
  assert.deepEqual(f.db.sqlite.prepare("SELECT ciphertext,nonce FROM kiosk_fingerprint_vault_templates").get(), original);
  assert.equal((await f.upload(vaultId, new Uint8Array(1536).fill(74), "SYN-002")).status, 409);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 1);
});

test("source restart preserves changed reader bytes without exporting or adding cloud enrollments", async context => {
  const f = await fixture(context); await f.enable(); const source = await runtimeFixture(context, f);
  source.models.set(1, new Uint8Array(1536).fill(75));
  await source.mappings.replace({ 1: { memberId: "SYN-001", rosterId: "member", finger: "unspecified", enrollment: freshEnrollment() } });
  assert.equal((await source.factory().tick()).uploaded, 1);
  const reads = source.counts().reads;
  source.models.get(1)!.fill(76);
  for (let i = 0; i < 3; i++) assert.equal((await source.factory().tick()).errors, 0);
  assert.equal(source.counts().reads, reads); assert.equal(source.counts().writes, 0);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 1);
  assert.equal(source.models.get(1)![0], 76);
});

test("lost upload response followed by reader evolution recovers original enrollment without overwrite", async context => {
  const f = await fixture(context); await f.enable(); const source = await runtimeFixture(context, f);
  source.models.set(1, new Uint8Array(1536).fill(77));
  await source.mappings.replace({ 1: { memberId: "SYN-001", rosterId: "member", finger: "unspecified", enrollment: freshEnrollment() } });
  source.loseUploadAck(); await source.factory().tick(); source.models.get(1)!.fill(78);
  assert.equal((await source.factory().tick()).errors, 0);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 1);
  assert.equal(source.models.get(1)![0], 78); assert.equal(source.counts().writes, 0);
  assert.ok((await source.mappings.read())[1].cloud);
});

test("completed destination keeps evolved bytes and explicit local removal survives offline restart", async context => {
  const f = await fixture(context), vaultId = await f.enable(); await f.upload(vaultId);
  const destination = await runtimeFixture(context, f, "destination"); await destination.factory().tick();
  destination.models.get(0)!.fill(79); const reads = destination.counts().reads;
  assert.equal((await destination.factory().tick()).errors, 0); assert.equal(destination.counts().reads, reads);
  const controller = destination.factory(), mapping = (await destination.mappings.read())[0];
  context.mock.method(destination.client, "configuration", async () => { throw new Error("Synthetic offline"); });
  await destination.withSensor(async () => { await controller.suppressLocal(0, mapping); await destination.mappings.replace({}); });
  context.mock.restoreAll();
  assert.equal((await destination.factory().tick()).errors, 0);
  assert.deepEqual(await destination.mappings.read(), {}); assert.equal(destination.models.get(0)![0], 79); assert.equal(destination.counts().writes, 1);
});

test("explicit retirement deletes cloud ciphertext and suppresses source replay and recipient access", async context => {
  const f = await fixture(context); const vaultId = await f.enable(); const source = await runtimeFixture(context, f), destination = await runtimeFixture(context, f, "destination");
  source.models.set(1, new Uint8Array(1536).fill(80)); const enrollment = freshEnrollment();
  await source.mappings.replace({ 1: { memberId: "SYN-001", rosterId: "member", finger: "unspecified", enrollment } });
  await source.factory().tick(); await destination.factory().tick(); destination.models.get(0)!.fill(81);
  const list = await (await f.call("/admin/kiosks/fingerprint-vault/enrollments")).json() as any;
  assert.equal(list.enrollments.length, 1); assert.equal(JSON.stringify(list).includes("template"), false);
  const id = list.enrollments[0].fingerprintId;
  const retire = () => f.call("/admin/kiosks/fingerprint-vault/enrollments/" + id, { vaultId, rosterId: "member", confirmation: "RETIRE ENROLLMENT EVERYWHERE" }, undefined, "DELETE");
  assert.equal((await retire()).status, 200); assert.equal((await retire()).status, 200);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 0);
  const replay = await f.call("/kiosk/fingerprint-vault/templates", { vaultId, memberId: "SYN-001", rosterId: "member", enrollmentId: enrollment.id, template: fingerprintVaultBase64(new Uint8Array(1536).fill(82)) }, "source-token");
  assert.equal(replay.status, 409);
  assert.equal((await source.factory().tick()).errors, 0); assert.equal((await destination.factory().tick()).errors, 0);
  assert.deepEqual(await source.mappings.read(), {}); assert.deepEqual(await destination.mappings.read(), {});
  assert.equal(source.models.get(1)![0], 80); assert.equal(destination.models.get(0)![0], 81);
  assert.equal((await f.call("/kiosk/fingerprint-vault/templates/" + id, undefined, "destination-token")).status, 404);
});

test("retirement refuses operator authority and does not remove a reused source slot", async context => {
  const f = await fixture(context), vaultId = await f.enable(), source = await runtimeFixture(context, f);
  source.models.set(1, new Uint8Array(1536).fill(83)); await source.mappings.replace({ 1: { memberId: "SYN-001", rosterId: "member", finger: "unspecified", enrollment: freshEnrollment() } });
  await source.factory().tick(); const id = (await source.mappings.read())[1].cloud!.fingerprintId;
  const path = "/admin/kiosks/fingerprint-vault/enrollments/" + id;
  const cookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "operator", role: "operator" })}`;
  const input = { vaultId, rosterId: "member", confirmation: "RETIRE ENROLLMENT EVERYWHERE" };
  assert.equal((await worker.fetch(new Request("https://api.example.test" + path, { method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(input) }), f.env)).status, 403);
  await source.mappings.replace({ 1: { memberId: "SYN-002", rosterId: "other", finger: "unspecified", enrollment: freshEnrollment() } });
  source.models.get(1)!.fill(84);
  assert.equal((await f.call(path, input, undefined, "DELETE")).status, 200);
  await source.factory().tick(); assert.equal((await source.mappings.read())[1].memberId, "SYN-002"); assert.equal(source.models.get(1)![0], 84);
});


test("retirement reaches a source with a lost acknowledgement and fresh re-enrollment stays possible", async context => {
  const f = await fixture(context); const vaultId = await f.enable(), source = await runtimeFixture(context, f);
  const enrollment = freshEnrollment(), model = new Uint8Array(1536).fill(86);
  source.models.set(1, model); await source.mappings.replace({ 1: { memberId: "SYN-001", rosterId: "member", finger: "unspecified", enrollment } });
  source.loseUploadAck(); await source.factory().tick();
  assert.equal((await source.mappings.read())[1].cloud, undefined);
  const list = await (await f.call("/admin/kiosks/fingerprint-vault/enrollments")).json() as any;
  const id = list.enrollments[0].fingerprintId;
  const retire = (rosterId: string, confirmation: string) => f.call("/admin/kiosks/fingerprint-vault/enrollments/" + id, { vaultId, rosterId, confirmation }, undefined, "DELETE");
  assert.equal((await retire("member", "wrong")).status, 400);
  assert.equal((await retire("other", "RETIRE ENROLLMENT EVERYWHERE")).status, 409);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 1);
  assert.equal((await retire("member", "RETIRE ENROLLMENT EVERYWHERE")).status, 200);
  await source.factory().tick(); assert.deepEqual(await source.mappings.read(), {}); assert.equal(source.models.get(1), model);
  const next = await f.call("/kiosk/fingerprint-vault/templates", { vaultId, memberId: "SYN-001", rosterId: "member", enrollmentId: freshEnrollment("22222222-2222-4222-8222-222222222222").id, template: fingerprintVaultBase64(model) }, "source-token");
  assert.equal(next.status, 200); assert.notEqual((await next.json() as any).fingerprintId, id);
});

test("source receipts are member-bound and generation reset removes operational receipt state", async context => {
  const f = await fixture(context), vaultId = await f.enable(); await f.upload(vaultId);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_enrollments").get()?.n, 1);
  assert.equal((await f.call("/admin/kiosks/fingerprint-vault", { enabled: false, confirmation: "DISABLE CLOUD FINGERPRINT STORAGE" }, undefined, "PATCH")).status, 200);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_enrollments").get()?.n, 0);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_retirements").get()?.n, 0);
  assert.notEqual(await f.enable(), vaultId);
});


test("retirement resumes after durable intent but interrupted mapping removal", async context => {
  const f = await fixture(context), vaultId = await f.enable(); const reply = await f.upload(vaultId), id = (await reply.json() as any).fingerprintId;
  const destination = await runtimeFixture(context, f, "destination"); await destination.factory().tick();
  await f.call("/admin/kiosks/fingerprint-vault/enrollments/" + id, { vaultId, rosterId: "member", confirmation: "RETIRE ENROLLMENT EVERYWHERE" }, undefined, "DELETE");
  destination.interruptRemoval(); assert.equal((await destination.factory().tick()).errors, 1);
  assert.equal((await destination.mappings.read())[0].memberId, "SYN-001");
  assert.equal((await destination.factory().tick()).errors, 0); assert.deepEqual(await destination.mappings.read(), {});
  assert.equal(destination.models.size, 1); assert.equal(destination.counts().writes, 1);
});

test("importer trusts completed receipts after byte changes but refuses conflicting roster identity", async context => {
  const f = await fixture(context), vaultId = await f.enable(); const id = (await (await f.upload(vaultId)).json() as any).fingerprintId;
  const destination = await runtimeFixture(context, f, "destination"); await destination.factory().tick();
  const journal = createFingerprintJournal(join(destination.directory, "destination-pair-b", vaultId, "received.json"), { installationId: vaultId, kioskId: "destination", pairingId: "pair-b" }, { allowSuperseded: true });
  const record = (await journal.list())[0];
  const binding = { installationId: vaultId, recipientId: "destination", recipientPairingId: "pair-b", ...record, rosterId: "member" };
  const importer = createFingerprintImporter({ journal, sensor: destination.sensor, templates: destination.templates, mappings: destination.mappings, withSensor: destination.withSensor, isMemberActive: async () => true });
  destination.models.get(0)!.fill(87); const reads = destination.counts().reads;
  assert.equal((await importer.receive(binding, new Uint8Array(1536).fill(11), record.envelopeDigest)).status, "complete");
  assert.equal(destination.counts().reads, reads); assert.equal(destination.models.get(0)![0], 87);
  await assert.rejects(importer.receive({ ...binding, rosterId: "another-identity" }, new Uint8Array(1536).fill(11), record.envelopeDigest), /review/);
  assert.equal(destination.models.get(0)![0], 87);
});


test("interrupted import still requires exact bytes before completing its receipt", async context => {
  const f = await fixture(context), vaultId = await f.enable(); await f.upload(vaultId);
  const destination = await runtimeFixture(context, f, "destination"); destination.interruptMapping();
  assert.equal((await destination.factory().tick()).errors, 1);
  destination.models.get(0)!.fill(88);
  assert.equal((await destination.factory().tick()).errors, 1);
  assert.deepEqual(await destination.mappings.read(), {}); assert.equal(destination.counts().writes, 1); assert.equal(destination.models.get(0)![0], 88);
});


test("removing a duplicate local source receipt preserves the other slot and survives restart", async context => {
  const f = await fixture(context); await f.enable(); const source = await runtimeFixture(context, f);
  source.models.set(1, new Uint8Array(1536).fill(81)); source.models.set(2, new Uint8Array(1536).fill(81));
  await source.mappings.replace({
    1: { memberId: "SYN-001", rosterId: "member", finger: "unspecified", enrollment: freshEnrollment() },
    2: { memberId: "SYN-001", rosterId: "member", finger: "unspecified", enrollment: { ...freshEnrollment(), id: "33333333-3333-3333-3333-333333333333" } },
  });
  assert.equal((await source.factory().tick()).uploaded, 2);
  const mappings = await source.mappings.read();
  assert.equal(mappings[1].cloud.fingerprintId, mappings[2].cloud.fingerprintId);
  await source.factory().suppressLocal(2, mappings[2]); delete mappings[2]; await source.mappings.replace(mappings);
  assert.equal((await source.factory().tick()).status, "ready");
  assert.deepEqual(Object.keys(await source.mappings.read()), ["1"]);
  assert.equal(source.models.size, 2); assert.equal(source.counts().writes, 0);
});


test("revision catalog returns the full snapshot and batches enforce authority and revision", async context => {
  const f = await fixture(context), vaultId = await f.enable();
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const response = await f.call("/kiosk/fingerprint-vault/templates", { vaultId, memberId: "SYN-001", rosterId: "member", enrollmentId: `synthetic-batch-${i}`, template: fingerprintVaultBase64(new Uint8Array(1536).fill(i + 1)) }, "source-token");
    assert.equal(response.status, 200); ids.push((await response.json() as any).fingerprintId);
  }
  const revision = Number(f.db.sqlite.prepare("SELECT catalog_revision AS n FROM kiosk_fingerprint_vault_settings").get()?.n);
  const catalog = await f.call(`/kiosk/fingerprint-vault/catalog?revision=${revision}`, undefined, "destination-token");
  assert.equal(catalog.status, 200); const snapshot = await catalog.json() as any;
  assert.equal(snapshot.catalogRevision, revision); assert.equal(snapshot.fingerprints.length, 12);
  assert.equal((await f.call(`/kiosk/fingerprint-vault/catalog?revision=${revision - 1}`, undefined, "destination-token")).status, 409);
  const batch = (fingerprintIds = ids.slice(0, 8), catalogRevision = revision, token = "destination-token") => f.call("/kiosk/fingerprint-vault/batch", { vaultId, catalogRevision, fingerprintIds }, token);
  const result = await batch(); assert.equal(result.status, 200); assert.equal((await result.json() as any).templates.length, 8);
  for (const bad of [[], ids, [ids[0], ids[0]], ["invalid"], ["f".repeat(64)]]) assert.notEqual((await batch(bad)).status, 200);
  assert.equal((await batch(ids.slice(0, 1), revision - 1)).status, 409);
  // Revocation after decryption must prevent the entire response.
  let reads = 0;
  f.db.beforeRun = sql => {
    if (sql.includes("SELECT 1 AS valid") && ++reads === 2) f.db.sqlite.exec("UPDATE kiosks SET active=0 WHERE id='destination'");
  };
  assert.notEqual((await batch()).status, 200);
  assert.equal((await batch()).status, 401);
});

test("catalog refresh discovers early sorted enrollments immediately and batches only missing copies across restart", async context => {
  const f = await fixture(context), vaultId = await f.enable();
  const destination = await runtimeFixture(context, f, "destination", 30);
  let catalogReads = 0, batchReads = 0, templateReads = 0;
  const fetchImpl = async (url: string, options?: RequestInit) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (path.includes("/catalog")) catalogReads++;
    if (path.endsWith("/batch")) batchReads++;
    if (/templates\/[a-f0-9]/.test(path)) templateReads++;
    return f.call(path, options?.body ? JSON.parse(String(options.body)) : undefined, "destination-token", options?.method);
  };
  const client = createFingerprintVaultClient(destination.config, { fetchImpl });
  const poll = createKioskPollClient(destination.config, { fetchImpl });
  const make = () => createFingerprintVault({ directory: destination.directory, config: destination.config, client, sensor: destination.sensor, templates: destination.templates, mappings: destination.mappings, withSensor: destination.withSensor, fetchRoster: () => destination.request("/kiosk/roster"), capacity: 30 });
  const tick = async (controller: ReturnType<typeof make>) => {
    const metadata = (await poll.poll({ fingerprints: true })).fingerprints!;
    return controller.tick({ ...metadata.vault, roster: metadata.roster });
  };
  for (let i = 0; i < 12; i++) {
    assert.equal((await f.call("/kiosk/fingerprint-vault/templates", { vaultId, memberId: "SYN-001", rosterId: "member", enrollmentId: `synthetic-refresh-${i}`, template: fingerprintVaultBase64(new Uint8Array(1536).fill(i + 20)) }, "source-token")).status, 200);
  }
  destination.models.set(29, new Uint8Array(1536).fill(250));
  const controller = make();
  const first = await tick(controller); assert.equal(first.received, 8); assert.equal(first.pendingDownloads, 4); assert.equal(first.status, "waiting");
  const second = await tick(controller); assert.equal(second.received, 4); assert.equal(second.pendingDownloads, 0);
  assert.equal(catalogReads, 1); assert.equal(batchReads, 2); assert.equal(templateReads, 0);
  const existing = new Map([...destination.models].map(([slot, model]) => [slot, new Uint8Array(model)]));
  for (let i = 0; i < 3; i++) await tick(controller);
  await tick(make()); assert.equal(batchReads, 2); assert.equal(catalogReads, 1);
  // Add a new enrollment whose ID sorts before the old final page.
  const firstId = String(f.db.sqlite.prepare("SELECT min(fingerprint_id) AS id FROM kiosk_fingerprint_vault_templates").get()?.id);
  let enrollmentId = "";
  for (let i = 0; i < 10000; i++) {
    const candidate = `synthetic-before-cursor-${i}`;
    const id = await fingerprintVaultEnrollmentId({ vaultId, keyId: await fingerprintVaultKeyId(vaultSecret), memberId: "member", sourceKioskId: "source", sourcePairingId: "pair-a", enrollmentId: candidate, templateDigest: "", createdAt: 0 });
    if (id < firstId) { enrollmentId = candidate; break; }
  }
  assert.ok(enrollmentId, "construct a new enrollment before every existing catalog entry");
  const uploaded = await f.call("/kiosk/fingerprint-vault/templates", { vaultId, memberId: "SYN-001", rosterId: "member", enrollmentId, template: fingerprintVaultBase64(new Uint8Array(1536).fill(99)) }, "source-token");
  assert.equal(uploaded.status, 200); assert.ok((await uploaded.json() as any).fingerprintId < firstId);
  const result = await tick(controller); assert.equal(result.received, 1); assert.equal(result.pendingDownloads, 0); assert.equal(catalogReads, 2); assert.equal(batchReads, 3);
  for (const [slot, model] of existing) assert.deepEqual(destination.models.get(slot), model);
  assert.equal(templateReads, 0);
});


test("batch loss, interrupted sensor commit and local removal remain resumable without overwrite", async context => {
  const f = await fixture(context), vaultId = await f.enable(); await f.upload(vaultId);
  const destination = await runtimeFixture(context, f, "destination");
  let batches = 0, drop = true;
  Object.assign(destination.client, {
    catalog: (revision: number) => destination.request(`/kiosk/fingerprint-vault/catalog?revision=${revision}`),
    batch: async (vaultId: string, catalogRevision: number, fingerprintIds: string[]) => {
      batches++;
      const result = await destination.request("/kiosk/fingerprint-vault/batch", { vaultId, catalogRevision, fingerprintIds });
      if (drop) { drop = false; throw new Error("Synthetic response lost"); }
      return result;
    },
  });
  const poll = createKioskPollClient(destination.config, { fetchImpl: async (url: string) => f.call(new URL(url).pathname + new URL(url).search, undefined, "destination-token") });
  const tick = async (controller: ReturnType<typeof destination.factory>) => {
    const metadata = (await poll.poll({ fingerprints: true })).fingerprints!;
    return controller.tick({ ...metadata.vault, roster: metadata.roster });
  };
  const controller = destination.factory();
  assert.equal((await tick(controller)).pendingDownloads, 1); assert.equal(destination.counts().writes, 0);
  destination.interruptMapping(); assert.equal((await tick(controller)).pendingDownloads, 1); assert.equal(destination.counts().writes, 1);
  assert.equal((await tick(destination.factory())).pendingDownloads, 0); assert.equal(destination.counts().writes, 1);
  const mapping = (await destination.mappings.read())["0"];
  await controller.suppressLocal(0, mapping); await destination.mappings.replace({});
  const before = batches;
  await tick(destination.factory()); assert.equal(batches, before); assert.equal(destination.counts().writes, 1); assert.deepEqual(await destination.mappings.read(), {});
});

test("full catalog and batch reject revision races and current membership, pairing and generation revocation", async context => {
  for (const change of [
    "UPDATE members SET active=0 WHERE id='member'",
    "UPDATE kiosks SET token_hash='replacement' WHERE id='destination'",
    "UPDATE kiosk_fingerprint_vault_settings SET enabled=0",
    "UPDATE platform_modules SET phase='retained',disabled_at='2026-01-01',delete_after='2026-01-08' WHERE module_id='attendance'",
  ]) {
    const f = await fixture(context), vaultId = await f.enable();
    const uploaded = await f.upload(vaultId); const fingerprintId = (await uploaded.json() as any).fingerprintId;
    const revision = Number(f.db.sqlite.prepare("SELECT catalog_revision AS n FROM kiosk_fingerprint_vault_settings").get()?.n);
    f.db.beforeRun = sql => {
      if (sql.includes("SELECT catalog_revision AS revision")) { f.db.beforeRun = undefined; f.db.sqlite.exec(change); }
    };
    const response = await f.call("/kiosk/fingerprint-vault/batch", { vaultId, catalogRevision: revision, fingerprintIds: [fingerprintId] }, "destination-token");
    assert.equal(response.status, change.includes("platform_modules") ? 403 : 409); assert.equal((await response.text()).includes("template"), false);
  }
  const f = await fixture(context), vaultId = await f.enable(); await f.upload(vaultId);
  const revision = Number(f.db.sqlite.prepare("SELECT catalog_revision AS n FROM kiosk_fingerprint_vault_settings").get()?.n);
  f.db.beforeRun = sql => {
    if (sql.includes("SELECT catalog_revision AS revision")) { f.db.beforeRun = undefined; f.db.sqlite.exec("DELETE FROM kiosk_fingerprint_vault_templates"); }
  };
  assert.equal((await f.call(`/kiosk/fingerprint-vault/catalog?revision=${revision}`, undefined, "destination-token")).status, 409);
});
