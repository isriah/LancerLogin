// Module registry, assignments and table ownership that need no plugin, run without composing one. The Outreach-dependent cases are in outreach/module-platform.ts (outreach-module-platform.test.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";
import { configureModulePlatform, validateModuleConfiguration } from "../apps/api/src/module-platform.ts";
import { Database } from "./fixtures/lifecycle-database.ts";

test("bundled registration keeps Core routes outside Attendance ownership", () => {
  assert.equal(bundledModuleRegistry.routeOwner("/admin/members"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/labels"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/admin/integrations"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/admin/data/backup"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/admin/update-info"), undefined);
});

test("bundled registration assigns Attendance entry points to the module", () => {
  assert.equal(bundledModuleRegistry.routeOwner("/meetings")?.module.id, "attendance");
  assert.equal(bundledModuleRegistry.routeOwner("/admin/members/member-1/history")?.module.id, "attendance");
  assert.equal(bundledModuleRegistry.routeOwner("/module-setup/attendance/rules")?.route.access, "setup");
  assert.equal(bundledModuleRegistry.routeOwner("/admin/attendance/members")?.route.access, "workspace");
  assert.equal(bundledModuleRegistry.routeOwner("/kiosk/attendance")?.route.access, "service");
  assert.equal(bundledModuleRegistry.routeOwner("/reports/query"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/reports/catalog"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/exports/report.csv"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/reports/leaderboard")?.route.access, "workspace");
});

test("Attendance setup declares required work and skippable integrations", () => {
  const attendance = bundledModuleRegistry.modules.find((module) => module.id === "attendance");
  assert.equal(attendance?.setup.version, 2);
  assert.deepEqual(attendance?.setup.steps.filter((step) => step.required).map((step) => step.id), ["rules", "meeting", "input"]);
  assert.deepEqual(attendance?.setup.steps.filter((step) => !step.required).map((step) => step.id), ["calendar", "discord"]);
});

test("module configuration requires explicit current disable authority", () => {
  assert.deepEqual(validateModuleConfiguration({ enabled: [], revision: 2, confirmDisable: [{ moduleId: "attendance", generation: 3 }] }), {
    enabled: [], revision: 2, confirmDisable: [{ moduleId: "attendance", generation: 3 }],
  });
  assert.throws(() => validateModuleConfiguration({ enabled: ["attendance", "attendance"], revision: 2 }));
  assert.throws(() => validateModuleConfiguration({ enabled: [], revision: 2, confirmDisable: [{ moduleId: "attendance", generation: 0 }] }));
});

test("a configuration conflict that lands between the read and the write stores nothing", async (context) => {
  const races: [string, string, RegExp][] = [
    ["an Attendance delivery queued after the blocker check", "INSERT INTO integration_deliveries(id,installation_id,provider,delivery_key,status,created_at,updated_at) VALUES('late-delivery','primary','discord','late-key','pending','2026-09-28','2026-09-28')", /in-flight Attendance delivery work/],
    ["another Admin saved the configuration first", "UPDATE platform_module_administration SET revision=1; UPDATE platform_module_administration_epochs SET revision=1", /changed; reload before saving/],
    ["Attendance moved to a new generation concurrently", "UPDATE platform_modules SET generation=2 WHERE module_id='attendance'; UPDATE platform_module_epochs SET generation=2 WHERE module_id='attendance'", /changed; reload before saving/],
  ];
  const installation = () => {
    const database = new Database(true); context.after(() => database.close());
    database.sqlite.exec(`INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,redeemed_at,created_by,created_at,purpose) VALUES('pair','primary','pair-hash','2026-09-29','2026-09-28','admin','2026-09-28','hardware');
      INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,created_at) VALUES('kiosk','primary','pair','Test kiosk A','token-hash','2026-09-28');`);
    return database;
  };
  const stored = (database: Database) => ({
    revision: database.sqlite.prepare("SELECT revision FROM platform_module_administration").get()?.revision,
    epoch: database.sqlite.prepare("SELECT revision FROM platform_module_administration_epochs").get()?.revision,
    modules: database.sqlite.prepare("SELECT module_id,phase,generation FROM platform_modules ORDER BY module_id").all().map((row) => ({ ...row })),
    moduleEpochs: database.sqlite.prepare("SELECT module_id,generation FROM platform_module_epochs ORDER BY module_id").all().map((row) => ({ ...row })),
    kiosks: database.sqlite.prepare("SELECT active,token_hash FROM kiosks").all().map((row) => ({ ...row })),
    audits: database.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action='modules.configured'").get()?.n,
  });
  for (const [race, change, message] of races) {
    const database = installation();
    // The concurrent change commits after configureModulePlatform read the snapshot and checked for blockers, just before its batch.
    const batch = database.batch.bind(database);
    database.batch = async (statements) => { database.batch = batch; database.sqlite.exec(change); return batch(statements); };
    await assert.rejects(configureModulePlatform(database, "admin", { enabled: [], revision: 0, confirmDisable: [{ moduleId: "attendance", generation: 1 }] }), (error: { status?: number; message?: string }) => error.status === 409 && message.test(error.message ?? ""), race);
    // The refused request must have stored nothing on top of the concurrent change.
    const expected = installation(); expected.sqlite.exec(change);
    assert.deepEqual(stored(database), stored(expected), race);
  }
});
