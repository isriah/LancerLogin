import test from "node:test";
import assert from "node:assert/strict";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "../apps/api/src/d1-usage.ts";
import { carpoolRoute, createCarpoolPlan } from "../apps/api/src/carpool-api.ts";
import { HttpError } from "../apps/api/src/http-error.ts";

const request = (path: string, method = "GET") => new Request(`https://synthetic.test${path}`, { method });
const person = (name: string, status: "offer" | "needs-ride", longitude: number) => ({ memberId: null, displayName: name, contact: "", outboundStatus: status, outboundAddress: "Synthetic", outboundLatitude: 40, outboundLongitude: longitude, outboundSeats: status === "offer" ? 1 : null, returnStatus: status, returnAddress: "Synthetic", returnLatitude: 40, returnLongitude: longitude, returnSeats: status === "offer" ? 1 : null, returnSameAsOutbound: true, notes: "" });

test("Miniflare D1 rolls back stale Carpool guards before invalidation and audit writes", async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "carpool-stale-guard" } }));
  try {
    const database = await runtime.getD1Database("DB");
    const schema = [
      "CREATE TABLE installations(id TEXT PRIMARY KEY,created_at TEXT,auth_mode TEXT)",
      "CREATE TABLE users(id TEXT PRIMARY KEY,installation_id TEXT,local_username TEXT,role TEXT,created_at TEXT)",
      "CREATE TABLE members(id TEXT PRIMARY KEY,installation_id TEXT,external_id TEXT,first_name TEXT,last_name TEXT,email TEXT,active INTEGER DEFAULT 1)",
      "CREATE TABLE carpool_plans(installation_id TEXT,id TEXT,title TEXT,destination TEXT,event_reference TEXT,event_title_snapshot TEXT,event_starts_at_snapshot TEXT,radius_miles REAL,preferred_radius_miles REAL,notes TEXT,archived INTEGER,revision INTEGER,created_by TEXT,created_at TEXT,updated_at TEXT,meeting_id TEXT,PRIMARY KEY(installation_id,id))",
      "CREATE TABLE carpool_people(installation_id TEXT,plan_id TEXT,id TEXT,member_id TEXT,display_name TEXT,contact TEXT,source_row INTEGER,import_identity TEXT,import_snapshot_json TEXT,outbound_status TEXT,outbound_address TEXT,outbound_lat REAL,outbound_lon REAL,outbound_seats INTEGER,return_status TEXT,return_address TEXT,return_lat REAL,return_lon REAL,return_seats INTEGER,return_same_as_outbound INTEGER,notes TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,PRIMARY KEY(installation_id,plan_id,id))",
      "CREATE TABLE carpool_assignments(installation_id TEXT,plan_id TEXT,direction TEXT,rider_id TEXT,vehicle_person_id TEXT,distance_miles REAL,locked INTEGER,manual INTEGER,created_at TEXT,updated_at TEXT,PRIMARY KEY(installation_id,plan_id,direction,rider_id))",
      "CREATE TABLE carpool_unresolved(installation_id TEXT,plan_id TEXT,direction TEXT,rider_id TEXT,reason TEXT,detail TEXT,created_at TEXT,PRIMARY KEY(installation_id,plan_id,direction,rider_id))",
      "CREATE TABLE carpool_import_profiles(installation_id TEXT,header_key TEXT,mapping_json TEXT,updated_by TEXT,updated_at TEXT,PRIMARY KEY(installation_id,header_key))",
      "CREATE TABLE audit_log(id TEXT PRIMARY KEY,installation_id TEXT,actor_user_id TEXT,action TEXT,target_type TEXT,target_id TEXT,metadata_json TEXT,created_at TEXT)",
    ];
    for (const sql of schema) await database.prepare(sql).run();
    await database.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-09-29','local')").run(); await database.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-09-29')").run();
    const db = database as unknown as D1Database; const detail = await createCarpoolPlan(db, "admin", { title: "D1 guard", destination: "Arena", radiusMiles: 12, preferredRadiusMiles: 4 }); const planId = String(detail.plan.id);
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people`, "POST"), person("Driver", "offer", -74.01)); await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people`, "POST"), person("Rider", "needs-ride", -74)); await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/generate/outbound`, "POST"), {});
    const context = (await carpoolRoute(db, "admin", request(`/admin/carpool/context?planId=${planId}`))).body as { detail: { people: Array<Record<string, any>> } }; const rider = context.detail.people.find((item) => item.displayName === "Rider")!;
    await carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${rider.id}`, "PATCH"), { ...person("Rider", "needs-ride", -74), contact: "first@example.test", revision: rider.revision });
    const beforeAssignments = await database.prepare("SELECT COUNT(*) AS count FROM carpool_assignments").first<{ count: number }>(); const beforeAudits = await database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>();
    await assert.rejects(() => carpoolRoute(db, "admin", request(`/admin/carpool/plans/${planId}/people/${rider.id}`, "PATCH"), { ...person("Rider", "needs-ride", -73.5), revision: rider.revision }), (error: unknown) => error instanceof HttpError && error.status === 409);
    assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM carpool_assignments").first<{ count: number }>())?.count, beforeAssignments?.count); assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>())?.count, beforeAudits?.count);
  } finally { await runtime.dispose(); }
});
