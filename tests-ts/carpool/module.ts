import test from "node:test";
import { carpoolLocalInstant, carpoolLocalTime, formatCarpoolTime, validateCarpoolSchedule } from "@lancerlogin-test/carpool/src/shared/carpool-schedule.ts";
import assert from "node:assert/strict";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { D1Database, D1Result, D1Statement } from "../../apps/api/src/d1-usage.ts";
import { carpoolRoute, createCarpoolPlan } from "@lancerlogin-test/carpool/src/api/carpool-api.ts";
import { mapCarpoolCsv, carpoolCsv } from "@lancerlogin-test/carpool/src/api/carpool-csv.ts";
import { carpoolAddressNeedsLocality, carpoolLocationCacheKey, GeoapifyCarpoolGeocoder, SyntheticCarpoolGeocoder, type CarpoolGeocodeBias } from "@lancerlogin-test/carpool/src/api/carpool-geocoding.ts";
import { suggestCarpoolPlan, swapCarpoolAssignments, type CarpoolPerson } from "@lancerlogin-test/carpool/src/api/carpool-planning.ts";
import { validateCarpoolBackupTables } from "@lancerlogin-test/carpool/src/api/carpool-backup.ts";
import { HttpError } from "../../apps/api/src/http-error.ts";
import { carpoolSettingsRoute, readCarpoolGeocoder } from "@lancerlogin-test/carpool/src/api/carpool-settings.ts";
import { moduleCredentials } from "../../apps/api/src/integration-crypto.ts";
import { decryptIntegration } from "../../apps/api/src/integration-crypto.ts";
import { carpoolReadiness, type CarpoolStatePerson } from "@lancerlogin-test/carpool/src/shared/carpool-state.ts";
import { carpoolGroupColors, carpoolGroupStyle } from "@lancerlogin-test/carpool/src/shared/carpool-groups.ts";

test("Carpool defaults apply to new plans while encrypted keys stay private and stale saves cannot replace them", async () => {
  const db = new Database(); const encryptionKey = "A".repeat(43); const apiKey = "synthetic-geoapify-key";
  const credentials = moduleCredentials(encryptionKey);
  const settings = (method = "GET", value?: unknown) => carpoolSettingsRoute(db, "admin", request("/admin/carpool/settings", method), value, credentials);
  try {
    // As a plugin, Carpool has no deployment-variable key fallback: lookup is configured only by a key saved in its settings.
    assert.deepEqual(await settings(), { radiusMiles: 12, preferredRadiusMiles: 4, revision: 0, geocodingConfigured: false, canSaveApiKey: true });
    assert.equal(await readCarpoolGeocoder(db, credentials), undefined);
    const oldPlan = await createCarpoolPlan(db, "admin", { title: "Existing distances" });
    const saved = await settings("PUT", { radiusMiles: 20, preferredRadiusMiles: 6, revision: 0, apiKey });
    assert.equal(saved.revision, 1); assert.equal(saved.geocodingConfigured, true); assert.doesNotMatch(JSON.stringify(saved), /synthetic-/);
    const row = db.sqlite.prepare("SELECT ciphertext,iv FROM carpool_geocoding_credentials").get() as { ciphertext: string; iv: string };
    assert.notEqual(row.ciphertext, apiKey); assert.deepEqual(await decryptIntegration(row.ciphertext, row.iv, encryptionKey), { apiKey });
    assert.ok(await readCarpoolGeocoder(db, credentials));
    const plan = await createCarpoolPlan(db, "admin", { title: "Configured defaults" }); assert.equal(plan.plan.radiusMiles, 20); assert.equal(plan.plan.preferredRadiusMiles, 6);
    const override = await createCarpoolPlan(db, "admin", { title: "Plan override", radiusMiles: 2 }); assert.equal(override.plan.preferredRadiusMiles, 2);
    assert.equal(db.sqlite.prepare("SELECT preferred_radius_miles FROM carpool_plans WHERE id=?").get(String(oldPlan.plan.id))?.preferred_radius_miles, 4);
    await assert.rejects(settings("PUT", { radiusMiles: 12, preferredRadiusMiles: 4, revision: 0, apiKey: "synthetic-stale-key" }), /settings changed/);
    assert.deepEqual(db.sqlite.prepare("SELECT ciphertext,iv FROM carpool_geocoding_credentials").get(), row);
    await settings("PUT", { radiusMiles: 20, preferredRadiusMiles: 6, revision: 1 }); assert.deepEqual(db.sqlite.prepare("SELECT ciphertext,iv FROM carpool_geocoding_credentials").get(), row);
    await settings("PUT", { radiusMiles: 20, preferredRadiusMiles: 6, revision: 2, removeApiKey: true }); assert.equal(await readCarpoolGeocoder(db, credentials), undefined); assert.equal((await settings()).geocodingConfigured, false);
    await assert.rejects(settings("PUT", { radiusMiles: 2, preferredRadiusMiles: 4, revision: 3 }), /Preferred radius/);
    assert.doesNotMatch(JSON.stringify(db.sqlite.prepare("SELECT * FROM audit_log").all()), /synthetic-(?:geoapify|stale)-key/);
  } finally { db.close(); }
});

class Statement implements D1Statement {
  readonly owner: Database; readonly sql: string; values: unknown[] = [];
  constructor(owner: Database, sql: string) { this.owner = owner; this.sql = sql; }
  bind(...values: unknown[]) { const next = new Statement(this.owner, this.sql); next.values = values; return next; }
  native(): StatementSync { return this.owner.sqlite.prepare(this.sql); }
  async first<T>() { this.owner.reads += 1; return (this.native().get(...this.values as []) as T | undefined) ?? null; }
  async all<T>() { this.owner.reads += 1; return { results: this.native().all(...this.values as []) as T[], meta: { changes: 0 } } as D1Result<T>; }
  async run() { const result = this.native().run(...this.values as []); return { success: true, meta: { changes: Number(result.changes) } } as D1Result; }
  batchResult(): D1Result { if (/^\s*(?:SELECT|WITH)\b/i.test(this.sql)) return { success: true, results: this.native().all(...this.values as []), meta: { changes: 0 } } as D1Result; const result = this.native().run(...this.values as []); return { success: true, meta: { changes: Number(result.changes) } } as D1Result; }
}

class Database implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:"); reads = 0; beforeBatch: (() => void) | undefined;
  constructor() {
    for (const file of readdirSync("apps/api/migrations").filter((name) => name.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-09-29','local');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','America/New_York');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-09-29');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,active,created_at) VALUES
        ('member-active','primary','1001','Active','Member','active@example.test',1,'2026-09-29'),
        ('member-inactive','primary','1002','Inactive','Member',NULL,0,'2026-09-29');`);
  }
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: D1Statement[]) { const before = this.beforeBatch; this.beforeBatch = undefined; before?.(); this.sqlite.exec("BEGIN IMMEDIATE"); try { const results = statements.map((statement) => (statement as Statement).batchResult()); this.sqlite.exec("COMMIT"); return results; } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; } }
  close() { this.sqlite.close(); }
}

const request = (path: string, method = "GET") => new Request(`https://synthetic.test${path}`, { method });
const basePerson = (overrides: Record<string, unknown> = {}) => ({ memberId: null, displayName: "Participant", contact: "", outboundStatus: "needs-ride", outboundAddress: "1 Main St", outboundLatitude: 40, outboundLongitude: -74, outboundSeats: null, returnStatus: "needs-ride", returnAddress: "1 Main St", returnLatitude: 40, returnLongitude: -74, returnSeats: null, returnSameAsOutbound: true, notes: "", ...overrides });
async function createPlan(db: Database, title = "Competition rides") { return createCarpoolPlan(db, "admin", { title, destination: "Arena", radiusMiles: 12, preferredRadiusMiles: 4 }) as Promise<{ plan: { id: string; revision: number }; people: unknown[]; assignments: unknown[]; unresolved: unknown[] }>; }
async function addPerson(db: Database, planId: string, value: Record<string, unknown>) { return carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people`, "POST"), value); }
const count = (db: Database, table: string) => Number((db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);

test("automatic location batches progress across both trips and preserve manual pins and terminal misses", async () => {
  const db = new Database();
  try {
    const id = (await createPlan(db)).plan.id; const calls: string[] = [];
    for (let index = 0; index < 10; index++) await addPerson(db, id, basePerson({ displayName: `Lookup ${index}`, outboundAddress: `${index} Synthetic St, Example, PA 19000`, returnAddress: `${index} Return St, Example, PA 19000`, outboundLatitude: null, outboundLongitude: null, returnLatitude: null, returnLongitude: null, returnSameAsOutbound: false }));
    await addPerson(db, id, basePerson({ displayName: "Manual pin", outboundAddress: "Short manual address" }));
    const provider = { id: "synthetic", async resolve(address: string) { calls.push(address); return address.startsWith("9 ") ? null : { latitude: 40.1, longitude: -74.1 }; } };
    const context = async (configured = true) => (await carpoolRoute(db, "admin", request(`/admin/carpool/context?planId=${id}`), undefined, configured ? provider : undefined)).body as any;
    const unconfigured = await context(false); assert.equal(unconfigured.locationLookup.state, "unconfigured"); assert.equal(calls.length, 0);
    let state = await context(); let batches = 0;
    while (state.locationLookup.state === "queued") {
      const before = calls.length; const saved = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${id}/locations/resolve`, "POST"), { automatic: true, planRevision: state.detail.plan.revision }, provider)).body as any;
      assert.ok(calls.length - before <= 8); state = { detail: saved, locationLookup: saved.locationLookup }; assert.ok(++batches <= 3);
    }
    assert.equal(state.locationLookup.state, "complete"); assert.equal(batches, 3); assert.equal(calls.length, 20);
    const manual = state.detail.people.find((person: any) => person.displayName === "Manual pin"); assert.equal(manual.outboundLatitude, 40); assert.equal(manual.outboundLocationSource, "manual");
    const missing = state.detail.people.find((person: any) => person.displayName === "Lookup 9"); assert.equal(missing.outboundLocationSource, "no-match"); assert.equal(missing.returnLocationSource, "no-match");
    assert.equal(state.detail.readiness.directions.outbound.issues.find((issue: any) => issue.riderId === missing.id).reason, "needs-review");
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${id}/locations/resolve`, "POST"), { automatic: true }, provider); assert.equal(calls.length, 20); assert.equal((await context()).locationLookup.state, "complete");
    const backup = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${id}/export?kind=backup`))).body as any; assert.equal("locationLookup" in backup, false); assert.doesNotMatch(JSON.stringify(backup), /lease_token|input_key/);
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${id}`, "DELETE"), { planRevision: state.detail.plan.revision }); assert.equal(count(db, "carpool_location_resolution"), 0);
  } finally { db.close(); }
});

test("automatic lookup failures are durable until explicit retry or changed addresses", async () => {
  const db = new Database();
  try {
    const id = (await createPlan(db)).plan.id; await addPerson(db, id, basePerson({ outboundLatitude: null, outboundLongitude: null, returnLatitude: null, returnLongitude: null }));
    let calls = 0; let failing = true; const provider = { id: "synthetic", async resolve() { calls++; if (failing) throw new Error("synthetic provider unavailable"); return { latitude: 40, longitude: -74 }; } };
    const resolve = (retry = false) => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${id}/locations/resolve`, "POST"), { automatic: true, retry }, provider);
    const failed = (await resolve()).body as any; assert.equal(failed.locationLookup.state, "failed"); assert.equal(failed.locationLookup.errorCode, "provider");
    for (let index = 0; index < 3; index++) { await resolve(); const context = (await carpoolRoute(db, "admin", request(`/admin/carpool/context?planId=${id}`), undefined, provider)).body as any; assert.equal(context.locationLookup.state, "failed"); } assert.equal(calls, 1);
    db.sqlite.prepare("UPDATE carpool_people SET outbound_address='Changed saved address',return_address='Changed saved address',revision=revision+1").run();
    await resolve(); assert.equal(calls, 2); failing = false;
    const saved = (await resolve(true)).body as any; assert.equal(saved.locationLookup.state, "complete"); assert.equal(calls, 3); assert.equal(saved.people[0].returnLatitude, 40);
  } finally { db.close(); }
});

test("automatic return-only lookup preserves the unplanned outbound location", async () => {
  const db = new Database();
  try {
    const plan = await createCarpoolPlan(db, "admin", { title: "Return only", tripScope: "return" }); const id = String(plan.plan.id);
    await addPerson(db, id, basePerson({ outboundLatitude: 41, outboundLongitude: -73, returnSameAsOutbound: false, returnLatitude: null, returnLongitude: null, returnAddress: "2 Synthetic Return St, Example, PA 19000" }));
    const saved = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${id}/locations/resolve`, "POST"), { automatic: true }, { id: "synthetic", async resolve() { return { latitude: 40, longitude: -74 }; } })).body as any;
    assert.equal(saved.locationLookup.state, "complete"); assert.equal(saved.people[0].outboundLatitude, 41); assert.equal(saved.people[0].outboundLongitude, -73); assert.equal(saved.people[0].returnLatitude, 40);
  } finally { db.close(); }
});

test("automatic lookup has one plan lease and cannot overwrite a concurrent manual save or expired authority", async () => {
  const db = new Database();
  try {
    const id = (await createPlan(db)).plan.id; await addPerson(db, id, basePerson({ outboundLatitude: null, outboundLongitude: null, returnLatitude: null, returnLongitude: null }));
    let release!: () => void; let entered!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; }); let calls = 0;
    const provider = { id: "synthetic", async resolve() { calls++; entered(); await pending; return { latitude: 40.2, longitude: -74.2 }; } };
    const resolving = carpoolRoute(db, "admin", request(`/admin/carpool/plans/${id}/locations/resolve`, "POST"), { automatic: true }, provider); await started;
    const second = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${id}/locations/resolve`, "POST"), { automatic: true }, provider)).body as any; assert.equal(second.locationLookup.state, "running"); assert.equal(calls, 1);
    const saved = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${id}/people/${second.people[0].id}`, "PATCH"), { ...basePerson({ outboundLatitude: 41, outboundLongitude: -73, returnLatitude: 41, returnLongitude: -73 }), revision: second.people[0].revision, planRevision: second.plan.revision })).body as any;
    release(); await assert.rejects(resolving, (error: unknown) => error instanceof HttpError && error.status === 409);
    const current = (await carpoolRoute(db, "admin", request(`/admin/carpool/context?planId=${id}`), undefined, provider)).body as any; assert.equal(current.detail.people[0].outboundLatitude, 41); assert.equal(current.detail.plan.revision, saved.plan.revision);
    db.sqlite.prepare("UPDATE carpool_people SET outbound_lat=NULL,outbound_lon=NULL,return_lat=NULL,return_lon=NULL,outbound_location_source=NULL,return_location_source=NULL").run();
    db.sqlite.prepare("UPDATE carpool_location_resolution SET state='running',lease_token='expired',lease_expires_at='2000-01-01T00:00:00Z'").run();
    const expired = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${id}/locations/resolve`, "POST"), { automatic: true }, provider)).body as any; assert.equal(expired.locationLookup.state, "failed"); assert.equal(expired.locationLookup.errorCode, "interrupted"); assert.equal(calls, 1);
    db.sqlite.prepare("UPDATE carpool_people SET outbound_address='New address after interruption',return_address='New address after interruption'").run();
    const changed = (await carpoolRoute(db, "admin", request(`/admin/carpool/context?planId=${id}`), undefined, provider)).body as any; assert.equal(changed.locationLookup.state, "queued");
    const retried = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${id}/locations/resolve`, "POST"), { automatic: true }, provider)).body as any; assert.equal(retried.locationLookup.state, "complete"); assert.equal(calls, 2);
  } finally { db.close(); }
});

test("Carpool trip times retain exact instants and require a choice across clock changes", () => {
  assert.equal(carpoolLocalInstant("2026-10-14T08:00", "America/New_York"), "2026-10-14T12:00:00.000Z");
  assert.equal(carpoolLocalTime("2026-10-14T12:00:37.123Z", "America/New_York").value, "2026-10-14T08:00:37.123");
  assert.throws(() => carpoolLocalInstant("2026-03-08T02:30", "America/New_York"), /does not exist/);
  assert.throws(() => carpoolLocalInstant("2026-11-01T01:30", "America/New_York"), /earlier or later/);
  const later = carpoolLocalInstant("2026-11-01T01:30", "America/New_York", "later"); assert.equal(later, "2026-11-01T06:30:00.000Z"); assert.equal(carpoolLocalTime(later, "America/New_York").occurrence, "later"); assert.match(formatCarpoolTime(later, "America/New_York"), /GMT-5/); assert.match(formatCarpoolTime(carpoolLocalInstant("2026-11-01T01:30", "America/New_York", "earlier"), "America/New_York"), /GMT-4/);
  assert.throws(() => validateCarpoolSchedule({ timeZone: "Invalid/Zone" }), /not supported/);
  assert.throws(() => validateCarpoolSchedule({ timeZone: "UTC", outboundDepartureAt: "2026-02-30T08:00:00Z" }), /valid trip/);
  assert.throws(() => validateCarpoolSchedule({ timeZone: "UTC", outboundDepartureAt: "2026-10-14T12:00:00Z", returnDepartureAt: "2026-10-14T11:00:00Z" }), /must be after/);
});

test("reviewed sharing includes empty cars and useful stops while driver views exclude other people's data", async () => {
  const db = new Database();
  try {
    const plan = await createCarpoolPlan(db, "admin", { title: "Share test", destination: "Synthetic venue", timeZone: "America/New_York", outboundDepartureAt: "2026-10-14T12:00:00Z", returnDepartureAt: "2026-10-14T22:00:00Z", notes: "Meet at the entrance" }); const planId = String(plan.plan.id);
    await addPerson(db, planId, basePerson({ displayName: "Driver One", contact: "driver-one@example.invalid", outboundStatus: "offer", outboundSeats: 2, returnStatus: "offer", returnSeats: 2, notes: "Blue car" }));
    await addPerson(db, planId, basePerson({ displayName: "Other Driver", contact: "other-private@example.invalid", outboundStatus: "offer", outboundSeats: 2, returnStatus: "offer", returnSeats: 2 }));
    const added = (await addPerson(db, planId, basePerson({ displayName: "=Rider", contact: "rider@example.invalid", outboundAddress: "Synthetic pickup", returnAddress: "Synthetic dropoff", returnSameAsOutbound: false, notes: "Call on arrival" }))).body as any;
    const driver = added.people.find((person: any) => person.displayName === "Driver One"); const rider = added.people.find((person: any) => person.displayName === "=Rider");
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/assignments/outbound/${rider.id}`, "PATCH"), { action: "move", vehiclePersonId: driver.id, planRevision: added.plan.revision });
    const pending = (await addPerson(db, planId, basePerson({ displayName: "Private exception", contact: "exception-private@example.invalid", outboundStatus: "unknown", returnStatus: "transit" }))).body as any; const auditCount = count(db, "audit_log");
    const share = async (suffix = "") => (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/share?direction=outbound&planRevision=${pending.plan.revision}${suffix}`))).body as any;
    const coordinator = await share("&unsaved=1"); assert.equal(coordinator.preview.groups.length, 2); assert.equal(coordinator.preview.groups.find((group: any) => group.driver.name === "Other Driver").passengers.length, 0); assert.equal(coordinator.preview.exceptions[0].name, "Private exception");
    const passenger = coordinator.preview.groups[0].passengers[0]; assert.equal(passenger.pickup, "Synthetic pickup"); assert.equal(passenger.dropoff, "Synthetic venue"); assert.equal(passenger.contact, "rider@example.invalid"); assert.equal(passenger.notes, "Call on arrival");
    assert.match(coordinator.content, /'=?Rider/); assert.match(coordinator.content, /Other Driver/); assert.match(coordinator.content, /Private exception/); assert.match(coordinator.content, /Unsaved changes are not included/); assert.match(coordinator.content, new RegExp(coordinator.preview.generatedAt.replaceAll(".", "\\."))); assert.match(coordinator.filename, new RegExp("-v" + coordinator.preview.version + "\\.csv$"));
    const individual = await share("&driverId=" + driver.id); assert.equal(individual.preview.groups.length, 1); assert.equal(individual.preview.audience, "driver"); assert.equal(individual.preview.exceptions.length, 0); assert.doesNotMatch(JSON.stringify(individual), /Other Driver|other-private|Private exception|exception-private/); assert.match(individual.content, /Call on arrival/); assert.equal(count(db, "audit_log"), auditCount);
    await assert.rejects(() => share("&driverId=missing"), /Choose a driver/); await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/share?direction=outbound&planRevision=0`)), /plan changed/); await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/share?direction=outbound&planRevision=`)), /reviewed plan version/);
    const returning = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/share?direction=return&planRevision=${pending.plan.revision}`))).body as any; assert.match(returning.preview.departureLabel, /6:00 PM/); assert.match(returning.preview.departureLabel, /America\/New_York/);
    const backup = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/export?kind=backup`))).body as any; const restored = (await carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), backup)).body as any; assert.equal(restored.plan.timeZone, "America/New_York"); assert.equal(restored.plan.outboundDepartureAt, "2026-10-14T12:00:00.000Z");
    const bad = structuredClone(backup); delete bad.plan.timeZone; await assert.rejects(() => carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), bad), /missing trip timing/);
    const older = structuredClone(backup); older.schemaVersion = 3; for (const key of ["timeZone", "outboundDepartureAt", "returnDepartureAt"]) delete older.plan[key]; const compatible = (await carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), older)).body as any; assert.equal(compatible.plan.timeZone, "UTC"); assert.equal(compatible.plan.outboundDepartureAt, null);
  } finally { db.close(); }
});

test("archived events can be found and restored without changing participants or groups", async () => {
  const db = new Database(); try {
    const planId = (await createPlan(db)).plan.id; const added = (await addPerson(db, planId, basePerson())).body as any;
    const archived = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}`, "PATCH"), { archived: true, revision: added.plan.revision })).body as any;
    const catalog = async (suffix: string) => (await carpoolRoute(db, "admin", request("/admin/carpool/context" + suffix))).body as any;
    assert.equal((await catalog("")).plans.length, 0); assert.equal((await catalog("?archive=archived")).plans[0].id, planId); assert.equal((await catalog("?archive=all")).plans.length, 1); await assert.rejects(() => catalog("?archive=invalid"), /Choose active/);
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}`, "PATCH"), { archived: false, revision: added.plan.revision }), (error: unknown) => error instanceof HttpError && error.status === 409);
    const restored = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}`, "PATCH"), { archived: false, revision: archived.plan.revision })).body as any; assert.equal(restored.plan.archived, false); assert.deepEqual(restored.people, added.people); assert.deepEqual(restored.assignments, added.assignments); assert.equal((await catalog("")).plans.length, 1); assert.equal(count(db, "meetings"), 0);
    const metadata = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}`, "PATCH"), { revision: restored.plan.revision, eventReference: "Optional reference", eventTitleSnapshot: "Optional title", eventStartsAtSnapshot: "2026-10-14T12:00:00Z" })).body as any;
    const cleared = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}`, "PATCH"), { revision: metadata.plan.revision, eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null })).body as any; assert.equal(cleared.plan.eventReference, null); assert.equal(cleared.plan.eventTitleSnapshot, null); assert.equal(cleared.plan.eventStartsAtSnapshot, null); assert.deepEqual(cleared.people, added.people);
  } finally { db.close(); }
});

test("Carpool readiness derives uncovered riders after edits and ignores obsolete unresolved rows", () => {
  const driver = { id: "driver", ...basePerson({ displayName: "Driver", outboundStatus: "offer", outboundSeats: 1, returnStatus: "arranged" }) } as CarpoolStatePerson;
  const rider = { id: "rider", ...basePerson({ returnStatus: "transit" }) } as CarpoolStatePerson;
  assert.equal(carpoolReadiness([], []).state, "draft");
  const pending = carpoolReadiness([driver, rider], []); assert.equal(pending.state, "needs-attention"); assert.equal(pending.directions.outbound.issues[0].riderId, "rider");
  const assignments = [{ riderId: "rider", vehiclePersonId: "driver", direction: "outbound" as const }];
  assert.equal(carpoolReadiness([driver, rider], assignments, [{ riderId: "rider", direction: "outbound", reason: "seat-shortage", detail: "Old result" }]).state, "ready");
  assert.equal(carpoolReadiness([driver, { ...rider, outboundLatitude: null, outboundLongitude: null }], assignments).directions.outbound.assigned, 0);
  assert.equal(carpoolReadiness([{ ...driver, outboundSeats: 0 }, rider], assignments).state, "needs-attention");
});

test("Carpool address edits clear unchanged pins, couple shared return locations, and preserve unrelated assignments", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id;
    await addPerson(db, planId, basePerson({ displayName: "Driver", outboundStatus: "offer", outboundSeats: 3, returnStatus: "offer", returnSeats: 3 }));
    await addPerson(db, planId, basePerson({ displayName: "Rider" }));
    await addPerson(db, planId, basePerson({ displayName: "Other" }));
    const detail = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/both`, "POST"), {})).body as any;
    const person = detail.people.find((item: any) => item.displayName === "Rider");
    const changed = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${person.id}`, "PATCH"), { ...basePerson({ displayName: "Rider", outboundAddress: "New address" }), revision: person.revision, planRevision: detail.plan.revision })).body as any;
    const updated = changed.people.find((item: any) => item.id === person.id);
    assert.equal(updated.outboundLatitude, null); assert.equal(updated.returnLatitude, null); assert.equal(updated.returnAddress, "New address");
    assert.equal(changed.assignments.length, 2); assert.ok(changed.assignments.every((item: any) => item.riderId !== person.id));
    assert.equal(changed.readiness.state, "needs-attention");
    const verified = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${person.id}`, "PATCH"), { ...basePerson({ displayName: "Rider", outboundAddress: "New address", outboundLatitude: 41, returnLatitude: 41 }), revision: updated.revision, planRevision: changed.plan.revision })).body as any;
    assert.equal(verified.people.find((item: any) => item.id === person.id).outboundLatitude, 41);
  } finally { db.close(); }
});

test("Carpool generates with submitted distances atomically and rejects the reviewed stale revision", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id;
    await addPerson(db, planId, basePerson({ displayName: "Driver", outboundStatus: "offer", outboundSeats: 1, returnStatus: "transit" }));
    const detail = (await addPerson(db, planId, basePerson({ displayName: "Rider", outboundLatitude: 40.1, returnStatus: "transit" }))).body as any;
    const generated = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/both`, "POST"), { planRevision: detail.plan.revision, radiusMiles: 2, preferredRadiusMiles: 1 })).body as any;
    assert.equal(generated.plan.radiusMiles, 2); assert.equal(generated.assignments.length, 0);
    const before = count(db, "audit_log");
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/both`, "POST"), { planRevision: detail.plan.revision, radiusMiles: 20, preferredRadiusMiles: 4 }), /plan changed/);
    assert.equal(count(db, "audit_log"), before); assert.equal(db.sqlite.prepare("SELECT radius_miles FROM carpool_plans WHERE id=?").get(planId)?.radius_miles, 2);
    db.beforeBatch = () => { db.sqlite.prepare("UPDATE carpool_plans SET revision=revision+1 WHERE id=?").run(planId); };
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/both`, "POST"), { planRevision: generated.plan.revision, radiusMiles: 20, preferredRadiusMiles: 4 }), /Record changed/);
    assert.equal(count(db, "audit_log"), before); assert.equal(db.sqlite.prepare("SELECT radius_miles FROM carpool_plans WHERE id=?").get(planId)?.radius_miles, 2);
  } finally { db.close(); }
});

test("manual assignment removes unresolved state and rejects stale reviewed actions", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id;
    await addPerson(db, planId, basePerson({ displayName: "Driver", outboundStatus: "offer", outboundSeats: 1, outboundLatitude: 41, returnStatus: "transit" }));
    await addPerson(db, planId, basePerson({ displayName: "Rider", returnStatus: "transit" }));
    const detail = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/outbound`, "POST"), {})).body as any;
    assert.equal(detail.unresolved.length, 1);
    const rider = detail.people.find((item: any) => item.displayName === "Rider"); const driver = detail.people.find((item: any) => item.displayName === "Driver");
    const changed = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/assignments/outbound/${rider.id}`, "PATCH"), { action: "move", vehiclePersonId: driver.id, planRevision: detail.plan.revision })).body as any;
    assert.equal(changed.unresolved.length, 0); assert.equal(changed.readiness.state, "ready");
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/assignments/outbound/${rider.id}`, "PATCH"), { action: "lock", locked: true, planRevision: detail.plan.revision }), /plan changed/);
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/assignments/outbound/${driver.id}`, "PATCH"), { action: "move", vehiclePersonId: rider.id, planRevision: changed.plan.revision }), /needs a ride/);
  } finally { db.close(); }
});

test("CSV location merge preserves manual address pins and never reuses pins for a different address", async () => {
  const mapping = { name: "Name", memberId: "Member", outboundStatus: "Out", outboundAddress: "Address", outboundLatitude: "Lat", outboundLongitude: "Lon", returnStatus: "Back", returnAddress: "Return" };
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id;
    const imported = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { mapping, csv: "Name,Member,Out,Address,Lat,Lon,Back,Return\nRider,1001,needs-ride,Original,40,-74,needs-ride,Other" })).body as any;
    const person = imported.detail.people[0]; assert.equal(person.returnLatitude, null);
    const edited = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${person.id}`, "PATCH"), { ...basePerson({ displayName: "Rider", memberId: "member-active", outboundAddress: "Manual", outboundLatitude: 41, returnAddress: "Other", returnLatitude: null, returnLongitude: null, returnSameAsOutbound: false }), revision: person.revision })).body as any;
    const merged = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { mapping, planRevision: edited.plan.revision, csv: "Name,Member,Out,Address,Lat,Lon,Back,Return\nRider,1001,needs-ride,Source changed,42,-73,needs-ride,Other" })).body as any;
    assert.equal(merged.detail.people[0].outboundAddress, "Manual"); assert.equal(merged.detail.people[0].outboundLatitude, 41);
  } finally { db.close(); }
});

test("whole-car locks are atomic and derived exports include riders invalidated by edits", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id;
    await addPerson(db, planId, basePerson({ displayName: "Driver", outboundStatus: "offer", outboundSeats: 2, returnStatus: "transit" }));
    await addPerson(db, planId, basePerson({ displayName: "One", returnStatus: "transit" })); await addPerson(db, planId, basePerson({ displayName: "Two", returnStatus: "transit" }));
    const detail = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/outbound`, "POST"), {})).body as any;
    const driver = detail.people.find((item: any) => item.displayName === "Driver");
    db.beforeBatch = () => { db.sqlite.prepare("UPDATE carpool_plans SET revision=revision+1 WHERE id=?").run(planId); };
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/assignments/outbound/${driver.id}`, "PATCH"), { action: "lock-car", locked: true, planRevision: detail.plan.revision }), /Record changed/);
    assert.equal(db.sqlite.prepare("SELECT SUM(locked) AS total FROM carpool_assignments WHERE plan_id=?").get(planId)?.total, 0);
    const locked = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/assignments/outbound/${driver.id}`, "PATCH"), { action: "lock-car", locked: true, planRevision: detail.plan.revision + 1 })).body as any;
    assert.ok(locked.assignments.every((item: any) => item.locked));
    const updated = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${driver.id}`, "PATCH"), { ...basePerson({ displayName: "Driver", outboundStatus: "transit", returnStatus: "transit" }), revision: driver.revision, planRevision: locked.plan.revision })).body as any;
    assert.equal(updated.assignments.length, 0);
    const exported = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/export?kind=unresolved`))).body as any;
    assert.match(exported.content, /One/); assert.match(exported.content, /Two/);
  } finally { db.close(); }
});

test("location refresh invalidates only affected people and maintains a shared return pin", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id;
    await addPerson(db, planId, basePerson({ displayName: "Driver", outboundStatus: "offer", outboundSeats: 2, returnStatus: "offer", returnSeats: 2, outboundAddress: "1 Complete St, Philadelphia, PA 19103" }));
    await addPerson(db, planId, basePerson({ displayName: "One", outboundAddress: "Short St" }));
    db.sqlite.prepare("UPDATE carpool_people SET outbound_location_source='lookup',return_location_source='lookup' WHERE display_name='One'").run();
    await addPerson(db, planId, basePerson({ displayName: "Two", outboundAddress: "2 Complete St, Philadelphia, PA 19103" }));
    const detail = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/both`, "POST"), {})).body as any;
    const calls: string[] = []; const geocoder = { id: "synthetic", resolve: async (address: string) => { calls.push(address); return { latitude: 40.01, longitude: -74.01 }; } };
    const refreshed = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/locations/resolve`, "POST"), { refreshAmbiguous: true, planRevision: detail.plan.revision }, geocoder)).body as any;
    assert.deepEqual(calls, ["Short St"]); const one = refreshed.people.find((item: any) => item.displayName === "One");
    assert.equal(one.outboundLatitude, 40.01); assert.equal(one.returnLatitude, 40.01); assert.equal(refreshed.assignments.length, 2);
    assert.ok(refreshed.assignments.every((item: any) => item.riderId !== one.id));
  } finally { db.close(); }
});

test("explicit one-way plans import without inventing an opposite trip and retain their scope in portable backups", async () => {
  const db = new Database();
  try {
    const created = await createCarpoolPlan(db, "admin", { title: "One-way event", tripScope: "outbound" }); const planId = String(created.plan.id);
    const mapping = { name: "Name", outboundStatus: "Out", outboundAddress: "Address", outboundSeats: "Seats", outboundLatitude: "Lat", outboundLongitude: "Lon", returnStatus: "" };
    const csv = "Name,Out,Address,Seats,Lat,Lon\nDriver,offer,One,1,40,-74\nRider,needs-ride,Two,,40.001,-74";
    const result = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { mapping, csv, planRevision: created.plan.revision })).body as any;
    assert.equal(result.detail.people[0].returnStatus, "unknown");
    const generated = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/both`, "POST"), { planRevision: result.detail.plan.revision })).body as any;
    assert.equal(generated.assignments.length, 1); assert.equal(generated.assignments[0].direction, "outbound"); assert.equal(generated.readiness.state, "ready");
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/return`, "POST"), {}), /not planned/);
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/export?kind=return`)), /not planned/);
    const backup = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/export?kind=backup`))).body as any; assert.equal(backup.schemaVersion, 4);
    const restored = (await carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), backup)).body as any; assert.equal(restored.plan.tripScope, "outbound");
    const old = { ...backup, schemaVersion: 1, plan: { ...backup.plan, tripScope: undefined } }; const legacy = (await carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), old)).body as any; assert.equal(legacy.plan.tripScope, "both");
    await assert.rejects(() => carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), { ...backup, plan: { ...backup.plan, tripScope: undefined } }), /missing its trip scope/);
  } finally { db.close(); }
});

test("import preview is read-only, reports preserved staff edits and binds apply to current roster and plan", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id; const mapping = { name: "Name", memberId: "Member", contact: "Contact", outboundStatus: "Out", outboundAddress: "Address", returnStatus: "Back" };
    const first = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { mapping, csv: "Name,Member,Contact,Out,Address,Back\nRider,1001,old@example.test,needs-ride,One,transit" })).body as any;
    const person = first.detail.people[0]; const edited = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${person.id}`, "PATCH"), { ...basePerson({ displayName: "Rider", memberId: "member-active", contact: "staff@example.test", outboundAddress: "One", outboundLatitude: null, outboundLongitude: null, returnStatus: "transit", returnSameAsOutbound: false }), revision: person.revision })).body as any;
    const body = { mapping, planRevision: edited.plan.revision, csv: "Name,Member,Contact,Out,Address,Back\nRider,1001,new@example.test,needs-ride,Changed,transit\nNew,,,transit,,transit" };
    const before = count(db, "audit_log"); const preview = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import/preview`, "POST"), body)).body as any;
    assert.equal(count(db, "audit_log"), before); assert.equal(count(db, "carpool_people"), 1); assert.equal(preview.summary.added, 1); assert.equal(preview.summary.staffEditsPreserved, 1); assert.equal(preview.people[0].contact, "staff@example.test");
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { ...body, csv: body.csv.replace("Changed", "Another"), previewToken: preview.previewToken }), /preview changed/);
    db.sqlite.prepare("UPDATE members SET active=0 WHERE id='member-active'").run();
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { ...body, previewToken: preview.previewToken }), /preview changed/);
    const fresh = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import/preview`, "POST"), body)).body as any;
    const applied = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { ...body, previewToken: fresh.previewToken })).body as any;
    assert.equal(applied.detail.people.find((item: any) => item.id === person.id).memberId, "member-active"); assert.equal(applied.detail.people.find((item: any) => item.id === person.id).contact, "staff@example.test");
    assert.equal(count(db, "members"), 2);
  } finally { db.close(); }
});

test("one-way reimports preserve independent opposite-trip fields and their source baseline", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id; const mapping = { name: "Name", memberId: "Member", outboundStatus: "Out", outboundAddress: "Pickup", outboundSeats: "Seats", returnStatus: "Back", returnAddress: "Drop", returnLatitude: "Lat", returnLongitude: "Lon" };
    const initial = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { mapping, csv: "Name,Member,Out,Pickup,Seats,Back,Drop,Lat,Lon\nDriver,1001,offer,One,1,needs-ride,Two,40.1,-74.1" })).body as any;
    const outbound = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { tripScope: "outbound", planRevision: initial.detail.plan.revision, mapping: { name: "Name", memberId: "Member", outboundStatus: "Out", outboundAddress: "Pickup", outboundSeats: "Seats" }, csv: "Name,Member,Out,Pickup,Seats\nDriver,1001,offer,Changed pickup,2" })).body as any;
    assert.equal(outbound.detail.people[0].returnAddress, "Two"); assert.equal(outbound.detail.people[0].returnLatitude, 40.1); assert.equal(outbound.detail.people[0].returnLongitude, -74.1); assert.equal(outbound.detail.people[0].returnStatus, "needs-ride"); assert.equal(outbound.detail.people[0].returnSameAsOutbound, false);
    const returning = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { tripScope: "return", planRevision: outbound.detail.plan.revision, mapping: { name: "Name", memberId: "Member", returnStatus: "Back", returnAddress: "Drop" }, csv: "Name,Member,Back,Drop\nDriver,1001,arranged,Changed drop" })).body as any;
    assert.equal(returning.detail.people[0].outboundAddress, "Changed pickup"); assert.equal(returning.detail.people[0].outboundSeats, 2); assert.equal(returning.detail.people[0].outboundStatus, "offer");
    const both = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { mapping, planRevision: returning.detail.plan.revision, csv: "Name,Member,Out,Pickup,Seats,Back,Drop,Lat,Lon\nDriver,1001,offer,Final pickup,3,transit,Final drop,," })).body as any;
    assert.equal(both.detail.people[0].outboundAddress, "Final pickup"); assert.equal(both.detail.people[0].outboundSeats, 3); assert.equal(both.detail.people[0].returnStatus, "transit"); assert.equal(both.detail.people[0].returnAddress, "Final drop");
  } finally { db.close(); }
});

test("location preview caches lookup without saving participants and provenance is checked when saving", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id; const initial = (await addPerson(db, planId, basePerson({ outboundLatitude: null, outboundLongitude: null, returnLatitude: null, returnLongitude: null }))).body as any; const person = initial.people[0]; let calls = 0;
    const geocoder = { id: "synthetic", async resolve() { calls++; return { latitude: 40.01, longitude: -74.01, label: "1 Main St, Synthetic City" }; } };
    const located = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/locations/lookup`, "POST"), { address: "1 Main St", direction: "outbound", planRevision: initial.plan.revision }, geocoder)).body as any;
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/locations/lookup`, "POST"), { address: "1 Main St", direction: "outbound", planRevision: initial.plan.revision }, geocoder); assert.equal(calls, 1);
    assert.equal(db.sqlite.prepare("SELECT outbound_lat FROM carpool_people WHERE id=?").get(person.id)?.outbound_lat, null);
    const body = { ...basePerson({ outboundLatitude: located.latitude, outboundLongitude: located.longitude, returnLatitude: located.latitude, returnLongitude: located.longitude }), revision: person.revision, planRevision: initial.plan.revision, outboundLocationLookupKey: located.lookupKey };
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${person.id}`, "PATCH"), { ...body, outboundAddress: "Wrong address" }), /no longer matches/);
    const saved = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${person.id}`, "PATCH"), body)).body as any; assert.equal(saved.people[0].outboundLocationSource, "lookup"); assert.equal(saved.people[0].returnLocationLabel, "1 Main St, Synthetic City");
    const backup = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/export?kind=backup`))).body as any; const restored = (await carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), backup)).body as any; assert.equal(restored.people[0].outboundLocationSource, "lookup");
    await assert.rejects(() => carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), { ...backup, people: backup.people.map((item: any) => ({ ...item, outboundLocationSource: "no-match" })) }), /invalid location provenance/);
  } finally { db.close(); }
});

test("rebuild preview is read-only and applies selected directions and exact distances with complete undo", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id;
    await addPerson(db, planId, basePerson({ displayName: "Driver", outboundStatus: "offer", outboundSeats: 2, returnStatus: "offer", returnSeats: 2 })); await addPerson(db, planId, basePerson({ displayName: "Rider" }));
    const initial = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/both`, "POST"), {})).body as any;
    const assignment = initial.assignments.find((item: any) => item.direction === "outbound");
    const locked = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/assignments/outbound/${assignment.riderId}`, "PATCH"), { action: "lock", locked: true, planRevision: initial.plan.revision })).body as any;
    const input = { direction: "outbound", planRevision: locked.plan.revision, radiusMiles: 25, preferredRadiusMiles: 6 }; const audits = count(db, "audit_log");
    const preview = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/preview`, "POST"), input)).body as any;
    assert.equal(count(db, "audit_log"), audits); assert.equal(db.sqlite.prepare("SELECT revision FROM carpool_plans WHERE id=?").get(planId)?.revision, locked.plan.revision); assert.equal(preview.summary[0].lockedPreserved, 1); assert.deepEqual(preview.directions, ["outbound"]);
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/apply`, "POST"), { ...input, previewToken: "changed" }), /preview changed/);
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/apply`, "POST"), { ...input, radiusMiles: 30, previewToken: preview.previewToken }), /preview changed/);
    const applied = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/apply`, "POST"), { ...input, previewToken: preview.previewToken })).body as any; assert.equal(applied.plan.radiusMiles, 25); assert.equal(applied.plan.preferredRadiusMiles, 6); assert.deepEqual(applied.assignments.filter((item: any) => item.direction === "return"), locked.assignments.filter((item: any) => item.direction === "return")); assert.equal(applied.plan.rebuildUndo.revision, applied.plan.revision);
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/undo`, "POST"), { planRevision: applied.plan.revision, assignments: [] }), /reviewed rebuild revision/);
    const restored = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/undo`, "POST"), { planRevision: applied.plan.revision })).body as any; assert.deepEqual(restored.assignments, locked.assignments); assert.deepEqual(restored.unresolved, locked.unresolved); assert.equal(restored.plan.radiusMiles, 12); assert.equal(restored.plan.preferredRadiusMiles, 4); assert.equal(restored.plan.rebuildUndo, null);
    const bothInput = { direction: "both", planRevision: restored.plan.revision, radiusMiles: 18, preferredRadiusMiles: 5 }; const both = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/preview`, "POST"), bothInput)).body as any; assert.equal(both.summary.length, 2);
    const bothApplied = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/apply`, "POST"), { ...bothInput, previewToken: both.previewToken })).body as any;
    const edited = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/groups/outbound/${assignment.vehiclePersonId}`, "PATCH"), { planRevision: bothApplied.plan.revision, label: "East entrance", color: "teal" })).body as any; assert.equal(edited.plan.rebuildUndo, null);
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/undo`, "POST"), { planRevision: edited.plan.revision }), /changed after the rebuild/);
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/apply`, "POST"), { ...bothInput, previewToken: both.previewToken }), /plan changed/);
  } finally { db.close(); }
});

test("group presentation persists by direction, validates recovery, and is removed with its participant", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id; const added = (await addPerson(db, planId, basePerson({ displayName: "Driver", outboundStatus: "offer", outboundSeats: 99, returnStatus: "offer", returnSeats: 1 }))).body as any; const driver = added.people[0];
    const changed = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/groups/outbound/${driver.id}`, "PATCH"), { planRevision: added.plan.revision, label: "East group", color: "blue" })).body as any; assert.deepEqual(changed.plan.groupSettings, [{ direction: "outbound", vehiclePersonId: driver.id, label: "East group", color: "blue" }]);
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/groups/return/${driver.id}`, "PATCH"), { planRevision: added.plan.revision, label: "Stale", color: "teal" }), /plan changed/);
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/groups/return/${driver.id}`, "PATCH"), { planRevision: changed.plan.revision, label: "Invalid", color: "url(unsafe)" }), /invalid group/);
    const backup = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/export?kind=backup`))).body as any; assert.equal(backup.schemaVersion, 4); assert.equal(backup.plan.rebuildUndo, null); const restored = (await carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), backup)).body as any; assert.deepEqual(restored.plan.groupSettings, changed.plan.groupSettings);
    await assert.rejects(() => carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), { ...backup, plan: { ...backup.plan, groupSettings: [{ ...backup.plan.groupSettings[0], vehiclePersonId: "missing" }] } }), /invalid group/);
    const removed = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${driver.id}`, "DELETE"), { planRevision: changed.plan.revision })).body as any; assert.deepEqual(removed.plan.groupSettings, []); assert.equal(count(db, "members"), 2);
  } finally { db.close(); }
});

test("rebuild apply and undo roll back complete recovery state when a concurrent save wins", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id; await addPerson(db, planId, basePerson({ displayName: "Driver", outboundStatus: "offer", outboundSeats: 1, returnStatus: "offer", returnSeats: 1 })); const added = (await addPerson(db, planId, basePerson({ displayName: "Rider" }))).body as any;
    const input = { direction: "both", planRevision: added.plan.revision, radiusMiles: 25, preferredRadiusMiles: 6 }; const preview = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/preview`, "POST"), input)).body as any; const audits = count(db, "audit_log");
    db.beforeBatch = () => { db.sqlite.prepare("UPDATE carpool_plans SET revision=revision+1 WHERE id=?").run(planId); };
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/apply`, "POST"), { ...input, previewToken: preview.previewToken }), (error: unknown) => error instanceof HttpError && error.status === 409);
    assert.equal(count(db, "carpool_assignments"), 0); assert.equal(count(db, "audit_log"), audits); assert.equal(db.sqlite.prepare("SELECT last_rebuild_json FROM carpool_plans WHERE id=?").get(planId)?.last_rebuild_json, null);
    const freshInput = { ...input, planRevision: input.planRevision + 1 }; const fresh = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/preview`, "POST"), freshInput)).body as any; const applied = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/apply`, "POST"), { ...freshInput, previewToken: fresh.previewToken })).body as any; const history = db.sqlite.prepare("SELECT last_rebuild_json FROM carpool_plans WHERE id=?").get(planId)?.last_rebuild_json; const appliedAudits = count(db, "audit_log");
    db.beforeBatch = () => { db.sqlite.prepare("UPDATE carpool_plans SET revision=revision+1 WHERE id=?").run(planId); };
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/rebuild/undo`, "POST"), { planRevision: applied.plan.revision }), (error: unknown) => error instanceof HttpError && error.status === 409);
    assert.equal(count(db, "carpool_assignments"), 2); assert.equal(count(db, "audit_log"), appliedAudits); assert.equal(db.sqlite.prepare("SELECT last_rebuild_json FROM carpool_plans WHERE id=?").get(planId)?.last_rebuild_json, history); assert.equal(db.sqlite.prepare("SELECT radius_miles FROM carpool_plans WHERE id=?").get(planId)?.radius_miles, 25);
  } finally { db.close(); }
});

test("group colors stay stable across renames and provide readable marker text", () => {
  assert.equal(carpoolGroupStyle({ id: "stable-driver", displayName: "Before" }, "outbound").color, carpoolGroupStyle({ id: "stable-driver", displayName: "After" }, "outbound").color);
  for (const color of carpoolGroupColors) {
    const style = carpoolGroupStyle({ id: "driver", displayName: "Driver" }, "outbound", [{ direction: "outbound", vehiclePersonId: "driver", label: "Group", color: color.id }]); const linear = color.value.slice(1).match(/../g)!.map(channel => Number.parseInt(channel, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); const luminance = .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!; const contrast = style.colorText === "#ffffff" ? 1.05 / (luminance + .05) : (luminance + .05) / .05; assert.ok(contrast >= 4.5, color.id);
  }
});

test("Carpool grouping maximizes rider coverage before straight-line distance and swaps safely", () => {
  const car = (id: string, longitude: number): CarpoolPerson => ({ id, displayName: id, outbound: { status: "offer", address: id, latitude: 0, longitude, seats: 1 }, return: { status: "offer", address: id, latitude: 0, longitude, seats: 1 } });
  const rider = (id: string, longitude: number): CarpoolPerson => ({ id, displayName: id, outbound: { status: "needs-ride", address: id, latitude: 0, longitude, seats: null }, return: { status: "needs-ride", address: id, latitude: 0, longitude, seats: null } });
  const people = [car("car-a", 0), car("car-b", .1), rider("constrained", -.04), rider("flexible", .01)];
  const suggested = suggestCarpoolPlan({ people, direction: "outbound", radiusMiles: 7, preferredRadiusMiles: 4, existing: [], otherDirection: [] });
  assert.equal(suggested.assignments.length, 2); assert.deepEqual(new Set(suggested.assignments.map((item) => item.riderId)), new Set(["constrained", "flexible"]));
  const swapped = swapCarpoolAssignments({ people, direction: "outbound", assignments: suggested.assignments, firstRiderId: "constrained", secondRiderId: "flexible" });
  assert.equal(swapped.error, undefined); assert.equal(swapped.assignments?.length, 2);
  assert.equal(swapCarpoolAssignments({ people, direction: "outbound", assignments: suggested.assignments.map((item) => item.riderId === "constrained" ? { ...item, locked: true } : item), firstRiderId: "constrained", secondRiderId: "flexible" }).error, "Unlock both assignments before swapping them.");
});

test("Carpool generates both directions together and preserves locked assignments", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id;
    await addPerson(db, planId, basePerson({ displayName: "Driver", outboundStatus: "offer", outboundSeats: 1, returnStatus: "offer", returnSeats: 1, outboundLongitude: -74.01, returnLongitude: -74.01 }));
    await addPerson(db, planId, basePerson({ displayName: "Rider" }));
    let detail = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/both`, "POST"), {})).body as { assignments: Array<{ direction: string; riderId: string; vehiclePersonId: string; locked: boolean }> };
    assert.deepEqual(new Set(detail.assignments.map((item) => item.direction)), new Set(["outbound", "return"]));
    const outbound = detail.assignments.find((item) => item.direction === "outbound")!;
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/assignments/outbound/${outbound.riderId}`, "PATCH"), { action: "lock", locked: true });
    detail = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/both`, "POST"), {})).body as typeof detail;
    assert.equal(detail.assignments.find((item) => item.direction === "outbound")?.locked, true);
    assert.equal(detail.assignments.filter((item) => item.direction === "return").length, 1);
    const returning = detail.assignments.find((item) => item.direction === "return")!;
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/assignments/return/${returning.riderId}`, "PATCH"), { action: "lock", locked: true });
    const before = db.sqlite.prepare("SELECT direction,rider_id,vehicle_person_id,locked FROM carpool_assignments WHERE plan_id=? ORDER BY direction,rider_id").all(planId);
    db.sqlite.prepare("UPDATE carpool_people SET return_status='arranged',return_seats=NULL WHERE id=?").run(returning.vehiclePersonId);
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/both`, "POST"), {}), (error: unknown) => error instanceof HttpError && error.status === 409);
    assert.deepEqual(db.sqlite.prepare("SELECT direction,rider_id,vehicle_person_id,locked FROM carpool_assignments WHERE plan_id=? ORDER BY direction,rider_id").all(planId), before);
  } finally { db.close(); }
});

test("Carpool CSV validation is bounded, duplicate-safe, and formula-safe", () => {
  const mapping = { name: "Name", contact: "Contact", outboundStatus: "Out", outboundAddress: "Address", returnStatus: "Back" };
  const duplicate = mapCarpoolCsv("Name,Contact,Out,Address,Back\nAlex,a@example.test,needs-ride,One,needs-ride\nAlex,a@example.test,needs-ride,One,needs-ride", mapping);
  assert.deepEqual(duplicate.issues, [{ row: 3, message: "Duplicates the participant on row 2." }]);
  const longQuestion = `Transportation question ${"x".repeat(100)}`;
  const longQuestionImport = mapCarpoolCsv(`Name,${longQuestion},Address,Back\nAlex,needs-ride,One,needs-ride`, { name: "Name", outboundStatus: longQuestion, outboundAddress: "Address", returnStatus: "Back" });
  assert.equal(longQuestionImport.people.length, 1);
  assert.throws(() => mapCarpoolCsv(`Name,Contact,Out,Address,Back\n${Array.from({ length: 501 }, (_, index) => `Person ${index},,transit,,transit`).join("\n")}`, mapping), /500 participants/);
  assert.throws(() => mapCarpoolCsv(`Name,${"x".repeat(501)},Address,Back\nAlex,needs-ride,One,needs-ride`, { name: "Name", outboundStatus: "x".repeat(501), outboundAddress: "Address", returnStatus: "Back" }), /column 2 has a header longer than 500 characters/);
  assert.throws(() => mapCarpoolCsv("Name,Contact,Out,Address,Back\nAlex,,transit,,transit", { ...mapping, notes: "Missing" }), /mapped column must exist/);
  const familiarResponses = mapCarpoolCsv("Name,Contact,Out,Address,Back\nAlex,,Getting a ride but cannot bring others,,SEPTA", mapping).people[0]!;
  assert.deepEqual({ outboundStatus: familiarResponses.outboundStatus, outboundSourceStatus: familiarResponses.outboundSourceStatus, returnStatus: familiarResponses.returnStatus, returnSourceStatus: familiarResponses.returnSourceStatus }, { outboundStatus: "arranged", outboundSourceStatus: "Getting a ride but cannot bring others", returnStatus: "transit", returnSourceStatus: "SEPTA" });
  assert.match(carpoolCsv([{ Name: "=HYPERLINK(\"bad\")" }]), /\r\n"'=HYPERLINK/);
});

test("Geoapify Carpool lookup binds fetch, sends a bounded US request, and returns the provider label", async () => {
  let requestedUrl = "";
  const request = (async function(this: typeof globalThis, input: string | URL | Request) {
    assert.equal(this, globalThis);
    requestedUrl = input.toString();
    return Response.json({ results: [{ lat: 39.9526, lon: -75.1652, formatted: "Philadelphia, PA, United States" }] });
  }) as typeof fetch;
  const result = await new GeoapifyCarpoolGeocoder("synthetic-secret", request).resolve("123 Market St", { latitude: 39.9526, longitude: -75.1652 });
  const url = new URL(requestedUrl);
  assert.equal(url.origin + url.pathname, "https://api.geoapify.com/v1/geocode/search");
  assert.equal(url.searchParams.get("text"), "123 Market St");
  assert.equal(url.searchParams.get("filter"), "countrycode:us");
  assert.equal(url.searchParams.get("limit"), "1");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("bias"), "proximity:-75.1652,39.9526");
  assert.equal(url.searchParams.get("apiKey"), "synthetic-secret");
  assert.deepEqual(result, { latitude: 39.9526, longitude: -75.1652, label: "Philadelphia, PA, United States" });
});

test("Carpool import exposes an unrecognized source response for review and preserves it through backup", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id; const mapping = { name: "Name", outboundStatus: "Out", outboundAddress: "Address", returnStatus: "Back" };
    const imported = await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { csv: "Name,Out,Address,Back\nAlex,Student Driver,One,Monday Carpool", mapping });
    const person = ((imported.body as { detail: { people: Array<any> } }).detail.people[0]!);
    assert.deepEqual({ outboundStatus: person.outboundStatus, outboundSourceStatus: person.outboundSourceStatus, returnStatus: person.returnStatus, returnSourceStatus: person.returnSourceStatus }, { outboundStatus: "unknown", outboundSourceStatus: "Student Driver", returnStatus: "unknown", returnSourceStatus: "Monday Carpool" });
    const backup = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/export?kind=backup`))).body;
    const restored = (await carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), backup)).body as { people: Array<any> };
    assert.deepEqual({ outboundSourceStatus: restored.people[0]!.outboundSourceStatus, returnSourceStatus: restored.people[0]!.returnSourceStatus }, { outboundSourceStatus: "Student Driver", returnSourceStatus: "Monday Carpool" });
  } finally { db.close(); }
});

test("Carpool import row errors return actionable API details", async () => {
  const db = new Database();
  try {
    const detail = await createPlan(db);
    const result = await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${detail.plan.id}/import`, "POST"), { csv: "Name,Out,Address,Back\n,needs-ride,One,needs-ride", mapping: { name: "Name", outboundStatus: "Out", outboundAddress: "Address", returnStatus: "Back" } });
    assert.equal(result.status, 422);
    assert.equal((result.body as { error: string }).error, "Some CSV rows need attention before they can be imported.");
    assert.deepEqual((result.body as { details: string[] }).details, ["Row 2: Name is required."]);
  } finally { db.close(); }
});

test("stale Carpool revisions roll back invalidation and audit writes", async () => {
  const db = new Database();
  try {
    const detail = await createPlan(db); const planId = detail.plan.id;
    await addPerson(db, planId, basePerson({ displayName: "Driver", outboundStatus: "offer", outboundSeats: 1, returnStatus: "offer", returnSeats: 1, outboundLongitude: -74.01, returnLongitude: -74.01 }));
    await addPerson(db, planId, basePerson({ displayName: "Rider" }));
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/outbound`, "POST"), {});
    const current = (await carpoolRoute(db, "admin", request(`/admin/carpool/context?planId=${planId}`))).body as ContextShape; const rider = current.detail.people.find((person) => person.displayName === "Rider")!;
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${rider.id}`, "PATCH"), { ...basePerson({ displayName: "Rider", contact: "reviewed@example.test" }), revision: rider.revision });
    const assignmentsBefore = count(db, "carpool_assignments"); const auditsBefore = count(db, "audit_log");
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${rider.id}`, "PATCH"), { ...basePerson({ displayName: "Rider", outboundAddress: "Changed" }), revision: rider.revision }), (error: unknown) => error instanceof HttpError && error.status === 409);
    assert.equal(count(db, "carpool_assignments"), assignmentsBefore); assert.equal(count(db, "audit_log"), auditsBefore);
    const planRevision = Number((db.sqlite.prepare("SELECT revision FROM carpool_plans WHERE id=?").get(planId) as { revision: number }).revision); await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}`, "PATCH"), { title: "Reviewed plan", revision: planRevision }); const planAudits = count(db, "audit_log");
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}`, "PATCH"), { title: "Stale title", revision: planRevision }), (error: unknown) => error instanceof HttpError && error.status === 409);
    assert.equal(count(db, "audit_log"), planAudits); assert.equal((db.sqlite.prepare("SELECT title FROM carpool_plans WHERE id=?").get(planId) as { title: string }).title, "Reviewed plan");
  } finally { db.close(); }
});

type ContextShape = { detail: { people: Array<ReturnTypeForPerson> } };
type ReturnTypeForPerson = { id: string; displayName: string; contact: string; outboundAddress: string; outboundLatitude: number | null; outboundLongitude: number | null; revision: number } & Record<string, unknown>;

test("CSV re-import merges source fields, preserves staff edits, and uses bounded reads", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id; const mapping = { name: "Name", contact: "Contact", memberId: "Member", outboundStatus: "Out", outboundAddress: "Out address", outboundSeats: "Out seats", returnStatus: "Back", returnAddress: "Back address", returnSeats: "Back seats" };
    const csv = "Name,Contact,Member,Out,Out address,Out seats,Back,Back address,Back seats\nImported,old@example.test,1001,offer,One,2,needs-ride,Two,";
    const readsBefore = db.reads; const first = await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { csv, mapping }); assert.equal(first.status, 201); assert.ok(db.reads - readsBefore <= 8);
    let context = (await carpoolRoute(db, "admin", request(`/admin/carpool/context?planId=${planId}`))).body as { importProfiles: Array<{ headerKey: string; mapping: Record<string, string> }>; detail: { people: Array<any> } }; const person = context.detail.people[0]!;
    assert.equal(context.importProfiles.length, 1); assert.equal(context.importProfiles[0]?.mapping.name, "Name");
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${person.id}`, "PATCH"), { ...basePerson({ memberId: null, displayName: "Imported", contact: "manual@example.test", outboundStatus: "offer", outboundSeats: 2, outboundAddress: "Manual address", returnAddress: "Two", returnSameAsOutbound: false }), revision: person.revision });
    const changed = "Name,Contact,Member,Out,Out address,Out seats,Back,Back address,Back seats\nImported updated,new@example.test,1001,offer,Source changed,3,needs-ride,Return changed,";
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/import`, "POST"), { csv: changed, mapping });
    context = (await carpoolRoute(db, "admin", request(`/admin/carpool/context?planId=${planId}`))).body as typeof context; const merged = context.detail.people[0]!;
    assert.equal(context.detail.people.length, 1); assert.equal(merged.displayName, "Imported updated"); assert.equal(merged.contact, "manual@example.test"); assert.equal(merged.memberId, null); assert.equal(merged.outboundAddress, "Manual address"); assert.equal(merged.outboundSeats, 3); assert.equal(merged.returnAddress, "Return changed");
    const exported = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/export?kind=backup`))).body;
    const restored = (await carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), exported)).body as { plan: { id: string }; people: Array<any> }; assert.equal(restored.people.length, 1);
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${restored.plan.id}/import`, "POST"), { csv: changed, mapping });
    const restoredContext = (await carpoolRoute(db, "admin", request(`/admin/carpool/context?planId=${restored.plan.id}`))).body as { detail: { people: Array<any> } }; assert.equal(restoredContext.detail.people.length, 1); assert.equal(restoredContext.detail.people[0].contact, "manual@example.test"); assert.equal(restoredContext.detail.people[0].memberId, null);
  } finally { db.close(); }
});

test("concurrent Carpool assignment changes fail closed on the plan domain revision", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id;
    await addPerson(db, planId, basePerson({ displayName: "Driver one", outboundStatus: "offer", outboundSeats: 1, returnStatus: "offer", returnSeats: 1, outboundLongitude: -74.01, returnLongitude: -74.01 }));
    await addPerson(db, planId, basePerson({ displayName: "Driver two", outboundStatus: "offer", outboundSeats: 1, returnStatus: "offer", returnSeats: 1, outboundLongitude: -74.02, returnLongitude: -74.02 }));
    await addPerson(db, planId, basePerson({ displayName: "Rider" })); await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/outbound`, "POST"), {});
    const assignment = db.sqlite.prepare("SELECT rider_id AS riderId,vehicle_person_id AS vehicleId FROM carpool_assignments WHERE plan_id=?").get(planId) as { riderId: string; vehicleId: string }; const other = db.sqlite.prepare("SELECT id FROM carpool_people WHERE plan_id=? AND outbound_status='offer' AND id<>?").get(planId, assignment.vehicleId) as { id: string }; const audits = count(db, "audit_log");
    db.beforeBatch = () => { db.sqlite.prepare("UPDATE carpool_plans SET revision=revision+1 WHERE id=?").run(planId); };
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/assignments/outbound/${assignment.riderId}`, "PATCH"), { action: "move", vehiclePersonId: other.id }), (error: unknown) => error instanceof HttpError && error.status === 409);
    assert.equal((db.sqlite.prepare("SELECT vehicle_person_id AS vehicleId FROM carpool_assignments WHERE plan_id=? AND rider_id=?").get(planId, assignment.riderId) as { vehicleId: string }).vehicleId, assignment.vehicleId); assert.equal(count(db, "audit_log"), audits);
  } finally { db.close(); }
});

test("an archived roster link can remain during unrelated Carpool edits without Core writes", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id; await addPerson(db, planId, basePerson({ memberId: "member-active", displayName: "Linked person" })); db.sqlite.prepare("UPDATE members SET active=0 WHERE id='member-active'").run();
    const context = (await carpoolRoute(db, "admin", request(`/admin/carpool/context?planId=${planId}`))).body as { detail: { people: Array<any> } }; const person = context.detail.people[0]!; assert.equal(person.memberActive, false);
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${person.id}`, "PATCH"), { ...basePerson({ memberId: "member-active", displayName: "Linked person", contact: "updated@example.test" }), revision: person.revision });
    assert.deepEqual({ ...db.sqlite.prepare("SELECT active,first_name AS firstName FROM members WHERE id='member-active'").get() }, { active: 0, firstName: "Active" });
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${person.id}`, "PATCH"), { ...basePerson({ memberId: "member-inactive", displayName: "Linked person" }), revision: person.revision + 1 }), (error: unknown) => error instanceof HttpError && error.status === 400);
  } finally { db.close(); }
});

test("manual participant entry enforces the same 500-person backup-safe plan limit", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id; const now = "2026-09-29";
    db.sqlite.prepare(`WITH RECURSIVE rows(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM rows WHERE value<500) INSERT INTO carpool_people(installation_id,plan_id,id,display_name,contact,outbound_status,outbound_address,return_status,return_address,return_same_as_outbound,notes,revision,created_at,updated_at) SELECT 'primary',?,'person-'||value,'Person '||value,'','transit','','transit','',1,'',0,?,? FROM rows`).run(planId, now, now);
    await assert.rejects(() => addPerson(db, planId, basePerson({ displayName: "Too many" })), (error: unknown) => error instanceof HttpError && error.status === 400); assert.equal(Number((db.sqlite.prepare("SELECT COUNT(*) AS count FROM carpool_people WHERE plan_id=?").get(planId) as { count: number }).count), 500);
  } finally { db.close(); }
});

test("deleting one Carpool event cascades its owned work but retains shared location cache", async () => {
  const db = new Database();
  try {
    const deletedPlanId = (await createPlan(db, "Delete me")).plan.id;
    const retainedPlanId = (await createPlan(db, "Keep me")).plan.id;
    await addPerson(db, deletedPlanId, basePerson({ displayName: "Deleted rider" }));
    db.sqlite.prepare("INSERT INTO carpool_location_cache(installation_id,cache_key,provider,normalized_address,original_address,status,latitude,longitude,saved_at) VALUES('primary','cache-key','synthetic','1 main st','1 Main St','success',40,-74,'2026-09-29')").run();
    const response = await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${deletedPlanId}`, "DELETE"));
    assert.equal(response.status, 200);
    assert.equal(Number((db.sqlite.prepare("SELECT COUNT(*) AS count FROM carpool_plans WHERE id=?").get(deletedPlanId) as { count: number }).count), 0);
    assert.equal(Number((db.sqlite.prepare("SELECT COUNT(*) AS count FROM carpool_people WHERE plan_id=?").get(deletedPlanId) as { count: number }).count), 0);
    assert.equal(Number((db.sqlite.prepare("SELECT COUNT(*) AS count FROM carpool_plans WHERE id=?").get(retainedPlanId) as { count: number }).count), 1);
    assert.equal(count(db, "carpool_location_cache"), 1);
    assert.equal(Number((db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='carpool.plan_deleted' AND target_id=?").get(deletedPlanId) as { count: number }).count), 1);
  } finally { db.close(); }
});

test("plan restore rejects inconsistent state and no-match geocoding is cached with manual fallback", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id; await addPerson(db, planId, basePerson({ displayName: "Needs location", outboundLatitude: null, outboundLongitude: null, returnLatitude: null, returnLongitude: null }));
    const geocoder = new SyntheticCarpoolGeocoder(["1 Main St"]); await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/locations/resolve`, "POST"), {}, geocoder); await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/locations/resolve`, "POST"), {}, geocoder); assert.equal(geocoder.calls, 1);
    const context = (await carpoolRoute(db, "admin", request(`/admin/carpool/context?planId=${planId}`))).body as { detail: { people: Array<any> } }; const person = context.detail.people[0]!;
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${person.id}`, "PATCH"), { ...basePerson({ displayName: person.displayName, outboundLatitude: 40.1, outboundLongitude: -74.1, returnLatitude: 40.1, returnLongitude: -74.1 }), revision: person.revision });
    const backup = (await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/export?kind=backup`))).body as Record<string, any>; backup.assignments = [{ riderId: person.id, vehiclePersonId: "missing", direction: "outbound", distanceMiles: 1, locked: false, manual: false }]; backup.unresolved = [{ riderId: person.id, direction: "outbound", reason: "needs-review", detail: "Review" }];
    await assert.rejects(() => carpoolRoute(db, "admin", request("/admin/carpool/restore", "POST"), backup), (error: unknown) => error instanceof HttpError && error.status === 400);
  } finally { db.close(); }
});

test("short Carpool addresses use a locality-aware cache key", () => {
  assert.equal(carpoolAddressNeedsLocality("123 Main Street"), true);
  assert.equal(carpoolAddressNeedsLocality("123 Main Street, Philadelphia, PA"), false);
  assert.equal(carpoolAddressNeedsLocality("123 Main Street Philadelphia PA 19103"), false);
  assert.notEqual(carpoolLocationCacheKey("provider", "123 Main Street"), carpoolLocationCacheKey("provider", "123 Main Street", { latitude: 39.95, longitude: -75.16 }));
});

test("location lookup returns a useful provider error", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id;
    await addPerson(db, planId, basePerson({ outboundLatitude: null, outboundLongitude: null, returnLatitude: null, returnLongitude: null }));
    const unavailable = { id: "unavailable", async resolve() { throw new Error("The location provider could not be reached. Check this installation's network access and try again."); } };
    await assert.rejects(
      () => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/locations/resolve`, "POST"), {}, unavailable),
      (error: unknown) => error instanceof HttpError && error.status === 502 && error.message.includes("could not be reached"),
    );
  } finally { db.close(); }
});

test("short addresses can be re-resolved near the median of complete event addresses", async () => {
  const db = new Database();
  try {
    const planId = (await createPlan(db)).plan.id;
    await addPerson(db, planId, basePerson({ displayName: "Complete address", outboundAddress: "123 Market St, Philadelphia, PA 19103", outboundLatitude: 39.9526, outboundLongitude: -75.1652, returnAddress: "123 Market St, Philadelphia, PA 19103", returnLatitude: 39.9526, returnLongitude: -75.1652 }));
    await addPerson(db, planId, basePerson({ displayName: "Short address", outboundAddress: "456 Local Street", outboundLatitude: 34, outboundLongitude: -118, returnAddress: "456 Local Street", returnLatitude: 34, returnLongitude: -118 }));
    db.sqlite.prepare("UPDATE carpool_people SET outbound_location_source='lookup',return_location_source='lookup' WHERE display_name='Short address'").run();
    const calls: Array<{ address: string; bias?: CarpoolGeocodeBias }> = [];
    const geocoder = { id: "recording", async resolve(address: string, bias?: CarpoolGeocodeBias) { calls.push({ address, bias }); return { latitude: 39.96, longitude: -75.17, label: "Nearby result" }; } };
    const result = await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/locations/resolve`, "POST"), { refreshAmbiguous: true }, geocoder);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.address, "456 Local Street");
    assert.deepEqual(calls[0]?.bias, { latitude: 39.9526, longitude: -75.1652 });
    const people = (result.body as { people: Array<{ displayName: string; outboundLatitude: number; returnLatitude: number }> }).people;
    const corrected = people.find((person) => person.displayName === "Short address");
    assert.equal(corrected?.outboundLatitude, 39.96);
    assert.equal(corrected?.returnLatitude, 39.96);
  } finally { db.close(); }
});

test("full backup Carpool validator rejects exclusivity, eligibility, and capacity violations", () => {
  const plan = { installation_id: "primary", id: "plan" }; const driver = { installation_id: "primary", plan_id: "plan", id: "driver", outbound_status: "offer", outbound_seats: 1 }; const rider = { installation_id: "primary", plan_id: "plan", id: "rider", outbound_status: "needs-ride" };
  const valid = { carpool_plans: [plan], carpool_people: [driver, rider], carpool_assignments: [{ installation_id: "primary", plan_id: "plan", direction: "outbound", rider_id: "rider", vehicle_person_id: "driver" }], carpool_unresolved: [] };
  assert.doesNotThrow(() => validateCarpoolBackupTables(valid));
  assert.throws(() => validateCarpoolBackupTables({ ...valid, carpool_plans: [plan, plan] }), /duplicate Carpool plans/);
  assert.throws(() => validateCarpoolBackupTables({ ...valid, carpool_unresolved: [{ installation_id: "primary", plan_id: "plan", direction: "outbound", rider_id: "rider" }] }), /assigned and unresolved/);
  assert.throws(() => validateCarpoolBackupTables({ ...valid, carpool_people: [driver, { ...rider, outbound_status: "arranged" }] }), /ineligible/);
  const rider2 = { ...rider, id: "rider-2" }; assert.throws(() => validateCarpoolBackupTables({ ...valid, carpool_people: [driver, rider, rider2], carpool_assignments: [...valid.carpool_assignments, { ...valid.carpool_assignments[0], rider_id: "rider-2" }] }), /capacity/);
});
