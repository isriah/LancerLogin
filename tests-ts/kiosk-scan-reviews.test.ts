import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "../apps/api/src/d1-usage.ts";
import { validateScanReviewUpload, syncKioskScanReviews, listKioskScanReviews, markKioskScanReviewed } from "../apps/api/src/kiosk-scan-reviews.ts";

const record = (eventId = "synthetic-scan") => ({ eventId, memberId: "synthetic-member", occurredAt: "2020-01-01T07:00:00.000Z", reasonCode: "clock_unverified", httpStatus: null, reviewStatus: "open", pairingId: "old-pairing", clock: { version: 1, verified: false, bootId: "synthetic-boot", elapsedMs: 1000, observedAt: "2020-01-01T07:00:00.000Z" } });

test("review upload validates bounded metadata and rejects raw or unexpected fields", () => {
  assert.equal(validateScanReviewUpload({ records: [record()] }).length, 1);
  for (const records of [[], Array.from({ length: 51 }, (_, index) => record(String(index))), [record(), record()], [{ ...record(), fingerprint: "not-allowed" }], [{ ...record(), clock: { ...record().clock, secret: "not-allowed" } }], [{ ...record(), occurredAt: "invalid" }]]) {
    assert.throws(() => validateScanReviewUpload({ records }), /scan|clock/i);
  }
});

test("scan review mirror preserves evidence, audited monotonic review, isolation and recovery retries", async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "synthetic-scan-reviews" } }));
  try {
    const database = await runtime.getD1Database("DB");
    for (const sql of [
      "CREATE TABLE installations(id TEXT PRIMARY KEY)",
      "CREATE TABLE kiosks(id TEXT PRIMARY KEY,installation_id TEXT,name TEXT,active INTEGER,pairing_code_id TEXT,token_hash TEXT)",
      "CREATE TABLE users(id TEXT PRIMARY KEY,installation_id TEXT,active INTEGER,role TEXT)",
      "CREATE TABLE audit_log(id TEXT PRIMARY KEY,installation_id TEXT,actor_user_id TEXT,action TEXT,target_type TEXT,target_id TEXT,metadata_json TEXT,created_at TEXT)",
      ...readFileSync("apps/api/migrations/0077_kiosk_scan_reviews.sql", "utf8").split(";").filter(sql => sql.trim()),
      "INSERT INTO installations VALUES('primary'),('other')",
      "INSERT INTO kiosks VALUES('kiosk-a','primary','Synthetic kiosk',1,'pair-a','token-a'),('kiosk-b','primary','Second kiosk',1,'pair-b','token-b'),('other-kiosk','other','Other',1,'other-pair','other-token')",
      "INSERT INTO users VALUES('admin','primary',1,'admin'),('operator','primary',1,'operator'),('other-admin','other',1,'admin')",
    ]) await database.prepare(sql).run();
    const db = database as unknown as D1Database, kiosk = { id: "kiosk-a", pairingId: "pair-a", tokenHash: "token-a" };
    assert.deepEqual(await syncKioskScanReviews(db, kiosk, { records: [record()] }), { reviews: [{ eventId: "synthetic-scan", reviewStatus: "open" }] });
    await syncKioskScanReviews(db, kiosk, { records: [record()] });
    let page = await listKioskScanReviews(db, "open", 0);
    assert.equal(page.records.length, 1); assert.equal(page.records[0].pairingId, "old-pairing"); assert.equal(page.records[0].occurredAt, record().occurredAt);
    await assert.rejects(syncKioskScanReviews(db, kiosk, { records: [record("new-before-conflict"), { ...record(), memberId: "different" }] }), /conflicts/);
    assert.equal((await listKioskScanReviews(db, "open", 0)).records.length, 1, "conflicting batch rolls back earlier inserts");
    await assert.rejects(markKioskScanReviewed(db, "operator", kiosk.id, record().eventId, { note: "No authority" }), /authorization/);
    await assert.rejects(markKioskScanReviewed(db, "other-admin", kiosk.id, record().eventId, { note: "Wrong installation" }), /authorization/);
    await markKioskScanReviewed(db, "admin", kiosk.id, record().eventId, { note: "Attendance corrected separately.\nReviewed the meeting and retained evidence." });
    await markKioskScanReviewed(db, "admin", kiosk.id, record().eventId, { note: "Retry must not replace the original note" });
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())!.n, 1);
    assert.deepEqual(await syncKioskScanReviews(db, kiosk, { records: [record()] }), { reviews: [{ eventId: "synthetic-scan", reviewStatus: "reviewed" }] });
    page = await listKioskScanReviews(db, "reviewed", 0);
    assert.equal(page.records[0].reviewNote, "Attendance corrected separately.\nReviewed the meeting and retained evidence.");
    await syncKioskScanReviews(db, { id: "kiosk-b", pairingId: "pair-b", tokenHash: "token-b" }, { records: [record()] });
    assert.equal((await listKioskScanReviews(db, "open", 0)).records[0].kioskId, "kiosk-b", "same event ID never acknowledges another kiosk");
    await syncKioskScanReviews(db, kiosk, { records: [{ ...record("locally-reviewed"), reviewStatus: "reviewed" }] });
    await syncKioskScanReviews(db, kiosk, { records: [{ ...record("locally-reviewed"), reviewStatus: "reviewed" }] });
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())!.n, 2);
    await database.prepare("DELETE FROM kiosk_scan_reviews WHERE kiosk_id='kiosk-a'").run();
    await syncKioskScanReviews(db, kiosk, { records: [{ ...record(), reviewStatus: "reviewed" }] });
    assert.equal((await listKioskScanReviews(db, "reviewed", 0)).records.length, 1, "retained local review can rebuild cloud mirror");
    await syncKioskScanReviews(db, kiosk, { records: Array.from({ length: 50 }, (_, index) => record(`page-${index}`)) });
    const first = await listKioskScanReviews(db, "open", 0), next = await listKioskScanReviews(db, "open", 50);
    assert.equal(first.records.length, 50); assert.equal(first.hasMore, true); assert.equal(next.records.length, 1);
    await database.prepare("UPDATE kiosks SET token_hash='rotated-token' WHERE id='kiosk-a'").run();
    await assert.rejects(syncKioskScanReviews(db, kiosk, { records: [record("revoked-token")] }), /pairing changed/);
    await database.prepare("UPDATE kiosks SET token_hash='token-a' WHERE id='kiosk-a'").run();
    await database.prepare("UPDATE kiosks SET active=0 WHERE id='kiosk-a'").run();
    await assert.rejects(syncKioskScanReviews(db, kiosk, { records: [record("retired")] }), /pairing changed/);
    await assert.rejects(syncKioskScanReviews(db, { id: "other-kiosk", pairingId: "other-pair", tokenHash: "other-token" }, { records: [record()] }), /pairing changed/);
  } finally { await runtime.dispose(); }
});
