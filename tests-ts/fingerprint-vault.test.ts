import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createFingerprintVault } from "../apps/kiosk/src/fingerprint-vault.mjs";
import { createFingerprintVaultClient } from "../apps/kiosk/src/fingerprint-vault-client.mjs";
import { createFingerprintReset } from "../apps/kiosk/src/fingerprint-reset.mjs";
import { createMappingStore } from "../apps/kiosk/src/mapping-store.mjs";
import { enrollFingerprint } from "../apps/kiosk/src/fingerprint-enrollment.mjs";
import { createFingerprintImporter } from "../apps/kiosk/src/fingerprint-importer.mjs";
import { createFingerprintJournal } from "../apps/kiosk/src/fingerprint-journal.mjs";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";
import { fingerprintVaultBase64, fingerprintVaultKeyId, sealFingerprintVault, openFingerprintVault } from "../apps/api/src/fingerprint-vault-crypto.ts";

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
  let writes = 0, reads = 0, dropUploadAck = false, failMapping = false;
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
  const wrappedMappings = { ...mappings, assignIfUnmapped: async (...args: Parameters<typeof mappings.assignIfUnmapped>) => {
    if (failMapping) { failMapping = false; throw new Error("Synthetic mapping interrupted"); }
    return mappings.assignIfUnmapped(...args);
  } };
  let lock = Promise.resolve();
  const withSensor = <T>(operation: () => Promise<T>) => { const current = lock.then(operation); lock = current.then(() => undefined, () => undefined); return current; };
  const factory = () => createFingerprintVault({ directory, config, client, sensor, templates, mappings: wrappedMappings, withSensor, fetchRoster: () => request("/kiosk/roster"), capacity });
  return { directory, config, client, request, models, mappings, sensor, templates, withSensor, factory, counts: () => ({ reads, writes }), loseUploadAck: () => { dropUploadAck = true; }, interruptMapping: () => { failMapping = true; } };
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
