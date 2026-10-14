import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { fingerprintResetGuard } from "../apps/api/src/fingerprint-reset.ts";
import { fingerprintVaultDigest, fingerprintVaultId, fingerprintVaultKeyId, sealFingerprintVault } from "../apps/api/src/fingerprint-vault-crypto.ts";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";

const sessionSecret = "A".repeat(43), vaultSecret = Buffer.alloc(32, 7).toString("base64url");
const retirement = "0060_retire_fingerprint_review.sql";
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
class Database {
  sqlite = new DatabaseSync(":memory:"); beforeRun?: (sql: string) => void;
  constructor(deferRetirement = false) {
    for (const file of readdirSync("apps/api/migrations").filter(file => file.endsWith(".sql") && (!deferRetirement || file !== retirement)).sort()) this.sqlite.exec(readFileSync(join("apps/api/migrations", file), "utf8"));
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local');
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
      INSERT INTO kiosks(id,installation_id,name,token_hash,pairing_code_id,pairing_bound,created_at) VALUES('source','primary','Source','${hash("source-token")}','pair-a',1,'2026-01-01'),('destination','primary','Destination','${hash("destination-token")}','pair-b',1,'2026-01-01');`);
    for (const step of bundledModuleRegistry.modules.find(module => module.id === "attendance")!.setup.steps.filter(step => step.required)) this.sqlite.prepare("INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) VALUES('primary','attendance',?,2,'completed','2026-01-01','admin')").run(step.id);
  }
  prepare(sql: string) {
    let params: unknown[] = []; const database = this;
    return { bind(...values: unknown[]) { params = values; return this; },
      async first<T>() { return database.sqlite.prepare(sql).get(...params as []) as T ?? null; },
      async all<T>() { return { results: database.sqlite.prepare(sql).all(...params as []) as T[] }; },
      async run() { return this.execute(); },
      execute() { database.beforeRun?.(sql); const statement = database.sqlite.prepare(sql), before = Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n); const results = statement.columns().length ? statement.all(...params as []) : (statement.run(...params as []), []); return { success: true, results, meta: { changes: Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n) - before } }; },
    };
  }
  async batch(statements: { execute(): unknown }[]) { this.sqlite.exec("BEGIN"); try { const results = statements.map(statement => statement.execute()); this.sqlite.exec("COMMIT"); return results; } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; } }
}
async function fixture(context: TestContext, deferRetirement = false) {
  context.mock.method(globalThis, "fetch", () => { throw new Error("Live providers are forbidden"); });
  const db = new Database(deferRetirement); context.after(() => db.sqlite.close());
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, FINGERPRINT_VAULT_KEY: vaultSecret, DB: db } as unknown as Env;
  const cookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" })}`;
  const operatorCookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "operator", role: "operator" })}`;
  const call = (path: string, body?: unknown, token?: string, method?: string, operator = false) => worker.fetch(new Request(`https://api.example.test${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : { cookie: operator ? operatorCookie : cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const enable = async () => { const result = await call("/admin/kiosks/fingerprint-vault", { enabled: true, confirmation: "ENABLE CLOUD FINGERPRINT STORAGE" }, undefined, "PATCH"); assert.equal(result.status, 200, await result.text()); return (await (await call("/kiosk/fingerprint-vault", undefined, "source-token")).json() as { vaultId: string }).vaultId; };
  const reset = (resetId = "reset-request") => call("/admin/kiosks/fingerprint-reset", { resetId, confirmation: "RESET ALL FINGERPRINT MAPPINGS" });
  const command = async (token = "source-token") => (await (await call("/kiosk/fingerprint-reset/commands", undefined, token)).json() as { commands: { id: string; kind: string }[] }).commands[0];
  return { db, env, call, enable, reset, command };
}

test("all retired review routes fail closed without lookup results or new authority", async context => {
  const { db, call } = await fixture(context);
  for (const [path, method] of [
    ["/admin/kiosks/fingerprint-review", "GET"], ["/admin/kiosks/fingerprint-review/members?memberId=SYN-001", "GET"],
    ["/admin/kiosks/fingerprint-review/requests", "POST"], [`/admin/kiosks/fingerprint-review/manifests/${"a".repeat(64)}`, "GET"],
    [`/admin/kiosks/fingerprint-review/manifests/${"a".repeat(64)}/slots/0`, "PATCH"], ["/admin/kiosks/fingerprint-review/reset", "POST"],
    ["/kiosk/fingerprint-review/commands", "GET"], ["/kiosk/fingerprint-review/commands/old/acknowledge", "POST"],
    ["/kiosk/fingerprint-review/manifests", "POST"], ["/kiosk/fingerprint-review/decisions?manifestId=old&revision=1", "GET"],
    ["/kiosk/fingerprint-review/acknowledgements", "POST"],
  ]) {
    const response = await call(path, method === "GET" ? undefined : {}, path.startsWith("/kiosk/") ? "source-token" : undefined, method);
    assert.equal(response.status, 410, path); const text = await response.text(); assert.match(text, /retired/); assert.doesNotMatch(text, /Synthetic|SYN-001|rosterId|slotProof/);
  }
  for (const table of ["kiosk_fingerprint_review_requests", "kiosk_fingerprint_review_manifests", "kiosk_fingerprint_review_slots", "kiosk_fingerprint_reset_batches"]) assert.equal(db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
});

test("retirement revokes reviewed ciphertext and stripped grants while preserving fresh sources and pending resets", async context => {
  const { db, call } = await fixture(context, true), vault = "1".repeat(64), keyId = await fingerprintVaultKeyId(vaultSecret), grant = "retired-grant";
  db.sqlite.prepare("INSERT INTO kiosk_fingerprint_vault_settings VALUES('primary',?,?,1,1)").run(vault, keyId);
  db.sqlite.prepare("INSERT INTO kiosk_fingerprint_review_manifests(id,installation_id,kiosk_id,pairing_id,vault_id,module_generation,revision,created_at) VALUES(?,'primary','source','pair-a',?,1,1,1)").run("a".repeat(64), vault);
  db.sqlite.prepare("INSERT INTO kiosk_fingerprint_review_slots(manifest_id,slot,original_member_id,mapping_digest,slot_proof,status,grant_id,roster_id,approved_member_id) VALUES(?,0,'SYN-001',?,?,'applied',?,'member','SYN-001')").run("a".repeat(64), "b".repeat(64), "c".repeat(64), grant);
  const ids: string[] = [];
  for (const [enrollmentId, byte] of [[grant, 11], ["fresh-enrollment", 12]] as const) {
    const template = new Uint8Array(1536).fill(byte), binding = { vaultId: vault, keyId, fingerprintId: "", memberId: "member", templateDigest: await fingerprintVaultDigest(vaultSecret, template), sourceKioskId: "source", sourcePairingId: "pair-a", enrollmentId, createdAt: 1 };
    binding.fingerprintId = await fingerprintVaultId(binding); ids.push(binding.fingerprintId); const encrypted = await sealFingerprintVault(template, binding, vaultSecret);
    db.sqlite.prepare("INSERT INTO kiosk_fingerprint_vault_templates VALUES(?,'primary',?,?,?,?,?,?,?,?,?,?)").run(binding.fingerprintId, vault, "member", binding.templateDigest, encrypted.ciphertext, encrypted.nonce, "r503-model-1536", "source", "pair-a", enrollmentId, 1); template.fill(0);
  }
  db.sqlite.exec("INSERT INTO kiosk_fingerprint_reset_batches VALUES('old-reset','primary','admin',1,1); INSERT INTO kiosk_fingerprint_reset_commands VALUES('old-command','old-reset','primary','destination','pair-b',1,NULL)");
  db.sqlite.exec(readFileSync(join("apps/api/migrations", retirement), "utf8"));
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 1);
  assert.equal(db.sqlite.prepare("SELECT enrollment_id FROM kiosk_fingerprint_vault_templates").get()?.enrollment_id, "fresh-enrollment");
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_review_manifests").get()?.n, 0);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_review_slots").get()?.n, 0);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_reset_commands WHERE acknowledged_at IS NULL").get()?.n, 1);
  assert.equal((await call(`/kiosk/fingerprint-vault/templates/${ids[0]}`, undefined, "source-token")).status, 404);
  assert.equal((await call(`/kiosk/fingerprint-vault/templates/${ids[1]}`, undefined, "source-token")).status, 200);
  const listed = await (await call("/kiosk/fingerprint-vault/templates", undefined, "source-token")).json() as { fingerprints: { fingerprintId: string }[] }; assert.deepEqual(listed.fingerprints.map(value => value.fingerprintId), [ids[1]]);
  const body = { vaultId: vault, memberId: "SYN-001", rosterId: "member", enrollmentId: grant, template: Buffer.alloc(1536, 11).toString("base64") };
  assert.equal((await call("/kiosk/fingerprint-vault/templates", { ...body, reviewGrantId: grant, sourceSlot: 0 }, "source-token")).status, 400);
  assert.equal((await call("/kiosk/fingerprint-vault/templates", body, "source-token")).status, 409);
  assert.throws(() => db.sqlite.prepare("INSERT INTO kiosk_fingerprint_review_requests VALUES('old','primary','source','pair-a',1,NULL)").run(), /retired/);
  assert.throws(() => db.sqlite.prepare("INSERT INTO kiosk_fingerprint_vault_templates VALUES(?,'primary',?,?,?,?,?,?,?,?,?,?)").run("f".repeat(64), vault, "member", "e".repeat(64), "A".repeat(2072), "A".repeat(16), "r503-model-1536", "source", "pair-a", grant, 1), /retired/);
});

test("retired-grant checks close an in-flight upload and a download after decryption", async context => {
  const { db, call, enable } = await fixture(context), vault = await enable();
  const body = { vaultId: vault, memberId: "SYN-001", rosterId: "member", enrollmentId: "later-retired", template: Buffer.alloc(1536, 13).toString("base64") };
  db.beforeRun = sql => { if (sql.startsWith("INSERT INTO kiosk_fingerprint_vault_templates")) { db.beforeRun = undefined; db.sqlite.prepare("INSERT INTO kiosk_fingerprint_retired_review_grants VALUES('primary',?)").run(body.enrollmentId); } };
  assert.equal((await call("/kiosk/fingerprint-vault/templates", body, "source-token")).status, 409);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_templates").get()?.n, 0);
  const fresh = { ...body, enrollmentId: "fresh-for-read" };
  const saved = await (await call("/kiosk/fingerprint-vault/templates", fresh, "source-token")).json() as { fingerprintId: string };
  db.beforeRun = sql => { if (sql.startsWith("SELECT 1 AS valid FROM kiosk_fingerprint_vault_templates")) { db.beforeRun = undefined; db.sqlite.prepare("INSERT INTO kiosk_fingerprint_retired_review_grants VALUES('primary',?)").run(fresh.enrollmentId); } };
  const rejected = await call(`/kiosk/fingerprint-vault/templates/${saved.fingerprintId}`, undefined, "destination-token"); assert.equal(rejected.status, 409); assert.doesNotMatch(await rejected.text(), /template|base64/);
});

test("reset capacity limits fail closed without clearing configuration or partial commands", async context => {
  for (const limit of ["kiosks", "batches"]) {
    const { db, reset, enable } = await fixture(context), vault = await enable();
    if (limit === "kiosks") for (let index = 0; index < 31; index++) {
      db.sqlite.prepare("INSERT INTO pairing_codes(id,installation_id,code_hash,purpose,expires_at,created_by,created_at) VALUES(?,'primary',?,'hardware','2099-01-01','admin','2026-01-01')").run(`extra-pair-${index}`, `extra-hash-${index}`);
      db.sqlite.prepare("INSERT INTO kiosks(id,installation_id,name,token_hash,pairing_code_id,pairing_bound,created_at) VALUES(?,'primary',?,?,?,1,'2026-01-01')").run(`extra-${index}`, `Extra ${index}`, `token-${index}`, `extra-pair-${index}`);
    } else for (let index = 0; index < 64; index++) db.sqlite.prepare("INSERT INTO kiosk_fingerprint_reset_batches VALUES(?,'primary','admin',1,1)").run(`prior-${index}`);
    assert.equal((await reset()).status, 409, limit);
    assert.equal(db.sqlite.prepare("SELECT vault_id FROM kiosk_fingerprint_vault_settings").get()?.vault_id, vault);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_reset_commands").get()?.n, 0);
  }
});

test("reset is atomic, idempotent, pairing-specific and available while sharing is off", async context => {
  const { db, call, reset, enable, command } = await fixture(context); await enable();
  await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH"); const oldSync = db.sqlite.prepare("SELECT sync_id FROM kiosk_fingerprint_sync").get()?.sync_id;
  assert.equal((await reset()).status, 200);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_vault_settings").get()?.n, 0); assert.equal(db.sqlite.prepare("SELECT enabled FROM kiosk_fingerprint_sync").get()?.enabled, 0); assert.notEqual(db.sqlite.prepare("SELECT sync_id FROM kiosk_fingerprint_sync").get()?.sync_id, oldSync);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM members").get()?.n, 2); assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosks WHERE active=1").get()?.n, 2);
  assert.equal(db.sqlite.prepare(`SELECT 1 WHERE ${fingerprintResetGuard}`).get("source", "pair-a"), undefined);
  const pending = await command(); assert.equal(pending.kind, "reset_fingerprint_mappings");
  assert.equal((await call(`/kiosk/fingerprint-reset/commands/${pending.id}/acknowledge`, { completed: true }, "destination-token")).status, 409);
  const status = await call("/admin/kiosks/fingerprint-reset"); assert.equal(status.headers.get("cache-control"), "no-store");
  const list = await status.json() as { resetCommands: { acknowledgedAt: number | null; currentPairing: number }[] }; assert.equal(list.resetCommands.length, 2); assert.ok(list.resetCommands.every(value => value.acknowledgedAt === null && value.currentPairing === 1));
  assert.equal((await call(`/kiosk/fingerprint-reset/commands/${pending.id}/acknowledge`, { completed: true }, "source-token")).status, 200); assert.equal((await call(`/kiosk/fingerprint-reset/commands/${pending.id}/acknowledge`, { completed: true }, "source-token")).status, 200);
  assert.ok(db.sqlite.prepare(`SELECT 1 WHERE ${fingerprintResetGuard}`).get("source", "pair-a"));
  const newVault = await enable(); assert.equal((await reset()).status, 200); assert.equal(db.sqlite.prepare("SELECT vault_id FROM kiosk_fingerprint_vault_settings").get()?.vault_id, newVault);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action='kiosk.fingerprint_mappings_reset_requested'").get()?.n, 1);
});

test("pending reset blocks cloud and peer sharing until the same current pairing acknowledges", async context => {
  const { call, reset, enable, command } = await fixture(context); await reset(); const pending = await command(); await enable(); await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH");
  assert.deepEqual(await (await call("/kiosk/fingerprint-vault", undefined, "source-token")).json(), { enabled: false, vaultId: null });
  const peer = await (await call("/kiosk/fingerprint-sync", undefined, "source-token")).json() as { enabled: boolean }; assert.equal(peer.enabled, false);
  assert.equal((await call("/kiosk/fingerprint-vault/templates", undefined, "source-token")).status, 409);
  assert.equal((await call("/kiosk/fingerprint-sync/keys", { unexpected: true }, "source-token", "PUT")).status, 409);
  assert.equal((await call(`/kiosk/fingerprint-reset/commands/${pending.id}/acknowledge`, { completed: true }, "source-token")).status, 200);
  assert.equal((await call("/kiosk/fingerprint-vault/templates", undefined, "source-token")).status, 200);
});

test("reset rejects unconfirmed input, role revocation, disabled modules and stale pairing credentials", async context => {
  const { db, call, reset, command } = await fixture(context);
  assert.equal((await call("/admin/kiosks/fingerprint-reset", { resetId: "bad", confirmation: "RESET ALL FINGERPRINT MAPPINGS", eraseReader: true })).status, 400);
  assert.equal((await call("/admin/kiosks/fingerprint-reset", { resetId: "bad", confirmation: "reset" })).status, 400);
  assert.equal((await call("/admin/kiosks/fingerprint-reset", undefined, undefined, undefined, true)).status, 403);
  assert.equal((await call("/admin/kiosks/fingerprint-reset?extra=1")).status, 400);
  await reset(); const pending = await command();
  db.sqlite.prepare("UPDATE kiosks SET token_hash=? WHERE id='source'").run(hash("rotated-token"));
  assert.equal((await call(`/kiosk/fingerprint-reset/commands/${pending.id}/acknowledge`, { completed: true }, "source-token")).status, 401);
  db.sqlite.exec("INSERT INTO pairing_codes(id,installation_id,code_hash,purpose,expires_at,created_by,created_at) VALUES('pair-c','primary','c','hardware','2099-01-01','admin','2026-01-01'); UPDATE kiosks SET pairing_code_id='pair-c' WHERE id='source'");
  assert.equal((await call(`/kiosk/fingerprint-reset/commands/${pending.id}/acknowledge`, { completed: true }, "rotated-token")).status, 409);
  const overview = await (await call("/admin/kiosks/fingerprint-reset")).json() as { resetCommands: { kioskId: string; currentPairing: number }[] }; assert.equal(overview.resetCommands.find(value => value.kioskId === "source")?.currentPairing, 0);
  db.sqlite.exec("UPDATE platform_modules SET phase='retained',disabled_at='2026-01-01',delete_after='2026-01-08' WHERE module_id='attendance'");
  assert.equal((await call("/kiosk/fingerprint-reset/commands", undefined, "rotated-token")).status, 409);
  assert.equal((await reset("disabled")).status, 403);
});

test("current Admin revocation is rechecked at mutation and does not queue or clear state", async context => {
  const { db, reset, enable } = await fixture(context), vault = await enable();
  db.beforeRun = sql => { if (sql.startsWith("INSERT INTO kiosk_fingerprint_reset_batches")) { db.beforeRun = undefined; db.sqlite.exec("UPDATE users SET role='operator' WHERE id='admin'"); } };
  assert.equal((await reset()).status, 403);
  assert.equal(db.sqlite.prepare("SELECT vault_id FROM kiosk_fingerprint_vault_settings").get()?.vault_id, vault);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_reset_commands").get()?.n, 0);
});

test("reset rollback preserves cloud and peer state when the audited transaction fails", async context => {
  const { db, call, reset, enable } = await fixture(context), vault = await enable(); await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH");
  db.beforeRun = sql => { if (sql.includes("kiosk.fingerprint_mappings_reset_requested")) { db.beforeRun = undefined; throw new Error("Synthetic rollback"); } };
  assert.equal((await reset()).status, 500);
  assert.equal(db.sqlite.prepare("SELECT vault_id FROM kiosk_fingerprint_vault_settings").get()?.vault_id, vault); assert.equal(db.sqlite.prepare("SELECT enabled FROM kiosk_fingerprint_sync").get()?.enabled, 1); assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_reset_commands").get()?.n, 0);
  assert.equal((await reset()).status, 200);
});

test("concurrent exact retries queue one batch and audit with bounded command delivery", async context => {
  const { db, call, reset } = await fixture(context);
  const results = await Promise.all([reset(), reset()]); assert.ok(results.every(value => value.status === 200));
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_reset_batches").get()?.n, 1);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_reset_commands").get()?.n, 2);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action='kiosk.fingerprint_mappings_reset_requested'").get()?.n, 1);
  await reset("next-reset"); const delivery = await (await call("/kiosk/fingerprint-reset/commands", undefined, "source-token")).json() as { commands: unknown[] }; assert.equal(delivery.commands.length, 1);
});

test("reset and retired-grant state are nonportable and entire-installation restore clears authority", async context => {
  const { db, call, reset } = await fixture(context);
  db.sqlite.exec("INSERT INTO kiosk_fingerprint_retired_review_grants VALUES('primary','old-grant')");
  const tables = ["kiosk_fingerprint_review_requests", "kiosk_fingerprint_review_manifests", "kiosk_fingerprint_review_slots", "kiosk_fingerprint_reset_batches", "kiosk_fingerprint_reset_commands", "kiosk_fingerprint_retired_review_grants"], module = bundledModuleRegistry.modules.find(value => value.id === "attendance")!;
  for (const table of tables) { assert.ok(module.persistence.tables.includes(table)); assert.ok(module.backup.nonPortableTables?.includes(table)); assert.ok(module.lifecycle.cleanupTargets.includes(table)); }
  const backup = await (await call("/admin/data/backup?scope=installation")).json() as { tables: Record<string, unknown> }; for (const table of tables) assert.equal(table in backup.tables, false);
  await reset(); assert.equal((await call("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup })).status, 200);
  for (const table of tables) assert.equal(db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
  assert.equal((await call("/kiosk/fingerprint-reset/commands", undefined, "source-token")).status, 401);
});
