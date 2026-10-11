import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { D1Database, D1Result, D1Statement } from "../apps/api/src/d1-usage.ts";
import { carpoolRoute, createCarpoolPlan } from "../apps/api/src/carpool-api.ts";
import { mapCarpoolCsv, carpoolCsv } from "../apps/api/src/carpool-csv.ts";
import { carpoolAddressNeedsLocality, carpoolLocationCacheKey, GeoapifyCarpoolGeocoder, SyntheticCarpoolGeocoder, type CarpoolGeocodeBias } from "../apps/api/src/carpool-geocoding.ts";
import { suggestCarpoolPlan, swapCarpoolAssignments, type CarpoolPerson } from "../apps/api/src/carpool-planning.ts";
import { validateCarpoolBackupTables } from "../apps/api/src/carpool-backup.ts";
import { HttpError } from "../apps/api/src/http-error.ts";

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
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${person.id}`, "PATCH"), { ...basePerson({ memberId: null, displayName: "Imported", contact: "manual@example.test", outboundStatus: "offer", outboundSeats: 2, outboundAddress: "Manual address", returnAddress: "Two" }), revision: person.revision });
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
