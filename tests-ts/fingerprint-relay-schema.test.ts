import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { attendanceModule, bundledModuleRegistry, createModuleRegistry } from "../packages/shared/src/module-platform.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync("apps/api/migrations").filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(join("apps/api/migrations", name), "utf8"));
  db.exec(`
    INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local');
    INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-01-01');
    INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member','primary','SYN-1','Synthetic','Member','2026-01-01');
    INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES('primary','attendance',1,1,'enabled',2,1);
    INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at) VALUES('pair-a','primary','hash-a','2027-01-01','admin','2026-01-01'),('pair-b','primary','hash-b','2027-01-01','admin','2026-01-01');
    INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,created_at) VALUES('a','primary','pair-a','A','token-a','2026-01-01'),('b','primary','pair-b','B','token-b','2026-01-01');
    INSERT INTO kiosk_fingerprint_sync(installation_id,sync_id,enabled) VALUES('primary','${"s".repeat(64)}',1);
    INSERT INTO kiosk_fingerprint_keys(kiosk_id,installation_id,pairing_id,key_id,public_json,registered_at) VALUES('a','primary','pair-a','${"a".repeat(64)}','{}',0),('b','primary','pair-b','${"b".repeat(64)}','{}',0);
  `);
  const insert = (overrides: Record<string, unknown> = {}) => {
    const values = { transfer_id: "transfer", installation_id: "primary", sync_id: "s".repeat(64), sender_id: "a", recipient_id: "b", sender_pairing_id: "pair-a", recipient_pairing_id: "pair-b", sender_key_id: "a".repeat(64), recipient_key_id: "b".repeat(64), member_id: "member", envelope_digest: "d".repeat(64), envelope_json: '{"synthetic":"ciphertext"}', created_at: 1000, expires_at: 2000, ...overrides };
    return db.prepare(`INSERT INTO kiosk_fingerprint_deliveries(${Object.keys(values).join(",")}) VALUES(${Object.keys(values).map(() => "?").join(",")})`).run(...Object.values(values) as []);
  };
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  return { db, insert, count };
}

test("fingerprint relay schema bounds deliveries and makes identity immutable", () => {
  const { db, insert, count } = fixture();
  try {
    for (const patch of [{ recipient_pairing_id: "stale" }, { sender_key_id: "x".repeat(64) }, { sync_id: "x".repeat(64) }, { expires_at: 1000 }, { expires_at: 604801001 }, { envelope_json: JSON.stringify("x".repeat(8192)) }]) assert.throws(() => insert(patch));
    insert(); assert.equal(count("kiosk_fingerprint_deliveries"), 1);
    assert.throws(() => db.exec("UPDATE kiosk_fingerprint_deliveries SET member_id='another'"), /immutable/);
    assert.throws(() => db.exec("UPDATE kiosk_fingerprint_deliveries SET status='complete'"));
    db.exec("UPDATE kiosk_fingerprint_deliveries SET status='complete',envelope_json=NULL");
    assert.equal(db.prepare("SELECT envelope_json FROM kiosk_fingerprint_deliveries").get()?.envelope_json, null);
    assert.throws(() => db.exec("UPDATE kiosk_fingerprint_deliveries SET status='pending',envelope_json='{}'"), /immutable/);
  } finally { db.close(); }
});

test("fingerprint relay revocation clears ciphertext and prevents authority revival", () => {
  for (const change of [
    "UPDATE kiosks SET active=0 WHERE id='a'",
    "UPDATE kiosks SET token_hash='changed' WHERE id='b'",
    "DELETE FROM kiosk_fingerprint_keys WHERE kiosk_id='a'",
    "UPDATE kiosk_fingerprint_sync SET enabled=0",
    "UPDATE kiosk_fingerprint_sync SET sync_id=lower(hex(randomblob(32)))",
    "UPDATE platform_modules SET phase='retained',generation=2,disabled_at='2026-01-01',delete_after='2026-01-08' WHERE module_id='attendance'",
    "DELETE FROM platform_modules WHERE module_id='attendance'",
    "UPDATE members SET active=0 WHERE id='member'",
    "UPDATE members SET external_id='changed' WHERE id='member'",
    "DELETE FROM members WHERE id='member'",
    "DELETE FROM installations WHERE id='primary'",
  ]) {
    const { db, insert, count } = fixture();
    try {
      insert(); db.exec(change);
      assert.equal(count("kiosk_fingerprint_deliveries"), 0, change);
      if (change !== "UPDATE members SET external_id='changed' WHERE id='member'") assert.throws(() => insert(), undefined, change);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
  }
});

test("fingerprint relay registration cannot silently substitute keys and config defaults off", () => {
  const { db } = fixture();
  try {
    assert.throws(() => db.exec("UPDATE kiosk_fingerprint_keys SET key_id=lower(hex(randomblob(32))) WHERE kiosk_id='a'"), /revoked/);
    db.exec("DELETE FROM kiosk_fingerprint_sync");
    db.exec(`INSERT INTO kiosk_fingerprint_sync(installation_id,sync_id) VALUES('primary','${"s".repeat(64)}')`);
    assert.equal(db.prepare("SELECT enabled FROM kiosk_fingerprint_sync").get()?.enabled, 0);
    assert.throws(() => db.exec(`INSERT INTO kiosk_fingerprint_keys(kiosk_id,installation_id,pairing_id,key_id,public_json,registered_at) VALUES('a','primary','pair-a','${"a".repeat(64)}','{}',0)`), /authority/);
  } finally { db.close(); }
});

test("fingerprint relay operational tables belong to Attendance but are not portable backups", () => {
  const source = readFileSync("packages/shared/src/module-platform.ts", "utf8");
  const backupSource = readFileSync("apps/api/src/index.ts", "utf8");
  for (const table of ["kiosk_fingerprint_sync", "kiosk_fingerprint_keys", "kiosk_fingerprint_deliveries"]) {
    assert.ok(source.includes(`"${table}"`));
    assert.equal(backupSource.includes(`${table}:`), false);
    assert.ok(attendanceModule.persistence.tables.includes(table));
    assert.ok(attendanceModule.backup.nonPortableTables?.includes(table));
    assert.equal(attendanceModule.backup.tables.includes(table), false);
  }
  assert.equal(bundledModuleRegistry.routeOwner("/kiosk/fingerprint-sync/deliveries")?.module.id, "attendance");
  assert.throws(() => createModuleRegistry([{ ...attendanceModule, backup: { ...attendanceModule.backup, nonPortableTables: [] } }]), /backup ownership/);
  assert.throws(() => createModuleRegistry([{ ...attendanceModule, backup: { ...attendanceModule.backup, tables: [...attendanceModule.backup.tables, "kiosk_fingerprint_sync"] } }]), /backup ownership/);
  assert.throws(() => createModuleRegistry([{ ...attendanceModule, lifecycle: { cleanupTargets: attendanceModule.lifecycle.cleanupTargets.filter((table) => table !== "kiosk_fingerprint_sync") } }]), /backup ownership/);
});
