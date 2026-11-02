// Guest Visits through the composed Worker, with Core's official Outreach plugin beside it: route admission, setup and
// backups, and Guest Visits' optional use of Outreach's `hour-tracking.team-support` interface through services.modules,
// on a migrated database with both plugins' migrations applied.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { registeredModuleSchedulerJobs } from "../../apps/api/src/index.ts";
import { createSessionCodec } from "../../apps/api/src/runtime-security.ts";
import { sessionSecret } from "../fixtures/backup-database.ts";
import { PluginDatabase } from "../fixtures/plugin-database.ts";

const origin = "https://dashboard.example.test";
const created = "2026-10-01T00:00:00.000Z";
const start = Date.parse("2030-03-04T16:00:00.000Z");
type CallOptions = { method?: string; body?: unknown; dashboard?: boolean; signedIn?: boolean; user?: "admin" | "operator" };

function installation() {
  const db = new PluginDatabase();
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: origin };
  const call = async (path: string, init: CallOptions = {}) => {
    const headers: Record<string, string> = {};
    if (init.signedIn !== false) headers.cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: init.user ?? "admin", role: init.user ?? "admin" });
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.dashboard) headers.origin = origin;
    const response = await worker.fetch(new Request(`https://api.example.test${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env as never);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const configure = async (enabled: string[], confirmDisable: { moduleId: string; generation: number }[] = []) => {
    const current = await call("/platform/modules");
    const result = await call("/admin/modules", { method: "PUT", body: { enabled, revision: current.body.revision, confirmDisable } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  const generation = async (moduleId: string) => (await call("/platform/modules")).body.modules.find((module: any) => module.id === moduleId).generation as number;
  const setUp = async (moduleId: string, stepId: string) => {
    const result = await call(`/admin/modules/${moduleId}/setup`, { method: "PUT", body: { generation: await generation(moduleId), stepId, outcome: "completed" } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  /** Enable Outreach and Guest Visits and complete their setup with the persisted proof each step checks. */
  const ready = async () => {
    await configure(["attendance", "hour-tracking", "visits"]);
    db.raw.exec(`INSERT INTO hours_teams(installation_id,id,number,name,program,created_at,updated_at) VALUES ('primary','test-team-99902','99902','Test Team 99902','FIRST Robotics Competition','${created}','${created}')`);
    await setUp("hour-tracking", "rules"); await setUp("hour-tracking", "catalog");
    db.raw.exec(`UPDATE visits_settings SET test_email_sent_at='${created}';
      INSERT INTO visits_windows(installation_id,id,start_ms,end_ms,created_at,updated_at) VALUES ('primary','window-1',${start},${start + 7_200_000},'${created}','${created}')`);
    await setUp("visits", "email"); await setUp("visits", "availability");
    db.raw.exec(`INSERT INTO visits_teams(installation_id,id,number,name,program,created_at,updated_at) VALUES ('primary','guest-99901','99901','Test Team 99901','FRC','${created}','${created}');
      INSERT INTO visits_bookings(installation_id,id,window_id,team_id,contact_name,contact_email,arrival_ms,departure_ms,headcount,created_at,updated_at)
        VALUES ('primary','visit-1','window-1','guest-99901','Test Student A','test-student-a@example.test',${start},${start + 3_600_000},4,'${created}','${created}')`);
  };
  return { db, env, call, configure, generation, setUp, ready };
}

test("the composed Worker reports Guest Visits beside Outreach and admits its routes only once it is ready", async (t) => {
  const { db, call, configure, ready } = installation(); t.after(() => db.raw.close());
  assert.deepEqual((await call("/health", { signedIn: false })).body.modules, ["attendance", "hour-tracking", "visits"]);
  const listed = (await call("/platform/modules")).body.modules.find((module: any) => module.id === "visits");
  assert.deepEqual({ phase: listed.phase, steps: listed.setup.steps.map((step: any) => step.id) }, { phase: "disabled", steps: ["email", "availability"] });
  assert.equal((await call("/admin/visits/settings")).status, 403, "a disabled plugin's routes are closed");

  await configure(["attendance", "visits"]);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM visits_settings"), 1, "first enablement creates the settings row");
  await ready();
  assert.equal((await call("/admin/visits/settings")).status, 200);
  assert.equal((await call("/admin/visits/settings", { user: "operator" })).status, 403, "settings are Admin-only");
  assert.equal((await call("/admin/visits/teams", { user: "operator" })).status, 403, "an Operator needs visits.manage");
  const teams = await call("/admin/visits/teams");
  assert.equal(teams.status, 200, JSON.stringify(teams.body));

  // An installation backup carries Guest Visits in its plugin section, never in Core's.
  const backup = await call("/admin/data/backup?scope=installation");
  assert.equal(backup.status, 200);
  assert.equal(Object.keys(backup.body.tables).some((table) => table.startsWith("visits_")), false);
  const section = backup.body.externalModules.find((entry: any) => entry.id === "visits");
  assert.ok(section, "Guest Visits has a plugin section");
  assert.deepEqual(section.tables.visits_bookings.map((row: any) => row.id), ["visit-1"]);
});

test("Guest Visits records a visit in Outreach through services.modules with a user's own access or an Admin's grant, and nothing else", async (t) => {
  const { db, env, call, configure, generation, ready } = installation(); t.after(() => db.raw.close());
  await ready();
  const grants = async () => (await call("/admin/modules/grants")).body;
  const listed = await grants();
  assert.deepEqual(listed.uses, [{
    consumer: { id: "visits", label: "Guest Visits", phase: "enabled" }, provider: { id: "hour-tracking", label: "Outreach Participation", state: "ready" },
    interface: { id: "hour-tracking.team-support", version: 1, label: "Outreach team support" }, required: false, reason: "Record guest visits as Outreach team support",
    operations: [
      { id: "find-teams", label: "Look up Outreach supported teams by number and program", grantable: true },
      { id: "ensure-team", label: "Create Outreach supported teams", grantable: true },
      { id: "ensure-team-support-activity", label: "Create Team Support activities for supported teams", grantable: true },
    ],
    grantable: ["find-teams", "ensure-team", "ensure-team-support-activity"], grant: null,
  }]);
  const record = (user: "admin" | "operator" = "admin") => call("/admin/visits/outreach", { body: { bookingIds: ["visit-1"] }, dashboard: true, user });
  const calls = () => db.rows<{ actor: string | null; operation: string; userId: string | null; grantId: string | null }>("SELECT actor_user_id AS actor, json_extract(metadata_json,'$.operation') AS operation, json_extract(metadata_json,'$.userId') AS userId, json_extract(metadata_json,'$.grantId') AS grantId FROM audit_log WHERE action='module.interface_called' ORDER BY rowid");

  // An Operator with Guest Visits but not Outreach has no access of their own, and no grant exists.
  let assignments = await call("/admin/modules/assignments/operator");
  assignments = await call("/admin/modules/assignments/operator", { method: "PUT", body: { capabilities: ["visits.manage"], revision: assignments.body.revision } });
  assert.equal(assignments.status, 200, JSON.stringify(assignments.body));
  assert.equal((await record("operator")).status, 409);
  assert.deepEqual(calls(), []);

  // A signed-in Admin's own access reaches Outreach: the guest team becomes a supported team with a Team Support activity
  // on the visit's date, and Guest Visits keeps only the returned IDs.
  const first = await record();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const [result] = first.body.results;
  assert.deepEqual({ ...result, activityId: undefined }, { bookingId: "visit-1", state: "recorded", activityId: undefined });
  const team = db.rows<{ id: string }>("SELECT id FROM hours_teams WHERE number='99901' AND name='Test Team 99901' AND archived=0");
  assert.equal(team.length, 1);
  assert.deepEqual(db.rows("SELECT id, category_id, mode, service_date, team_id FROM hours_activities"), [{ id: result.activityId, category_id: "team-support", mode: "team", service_date: "2030-03-04", team_id: team[0]!.id }]);
  assert.deepEqual(db.rows("SELECT outreach_team_id FROM visits_teams"), [{ outreach_team_id: team[0]!.id }]);
  assert.deepEqual(db.rows("SELECT outreach_activity_id FROM visits_bookings"), [{ outreach_activity_id: result.activityId }]);
  assert.deepEqual(calls(), ["find-teams", "ensure-team", "ensure-team-support-activity"].map((operation) => ({ actor: "admin", operation, userId: "admin", grantId: null })));

  // Recording again is idempotent on Outreach's side.
  const again = await record();
  assert.equal(again.body.results[0].activityId, result.activityId);
  assert.ok(calls().length > 3, "the second recording asked Outreach again");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM hours_activities"), 1);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM hours_teams WHERE number='99901'"), 1);

  // The notifications job runs without a user, so only an Admin's grant gives it access; Guest Visits keeps a copy of
  // whether it has one, which follows the grant and its revocation.
  const job = () => registeredModuleSchedulerJobs.find((item) => item.id === "visits.notifications")!.run(env as never);
  const granted = () => db.rows<{ outreach_granted: number }>("SELECT outreach_granted FROM visits_settings")[0]!.outreach_granted;
  await job(); assert.equal(granted(), 0);
  const grant = await call("/admin/modules/grants", { body: { consumer: "visits", interface: "hour-tracking.team-support", version: 1, operations: listed.uses[0].grantable }, dashboard: true });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  await job(); assert.equal(granted(), 1);
  const grantId = grant.body.uses[0].grant.id as string;
  assert.equal((await call("/admin/modules/grants/revoke", { body: { grantId }, dashboard: true })).status, 200);
  await job(); assert.equal(granted(), 0);

  // Without Outreach enabled the interface is unavailable, even to an Admin, and Guest Visits keeps working.
  const before = calls().length;
  await configure(["attendance", "visits"], [{ moduleId: "hour-tracking", generation: await generation("hour-tracking") }]);
  assert.equal((await record()).status, 409);
  assert.equal((await call("/admin/visits/teams")).status, 200);
  assert.equal(calls().length, before, "no call reached Outreach while it was disabled");
});
