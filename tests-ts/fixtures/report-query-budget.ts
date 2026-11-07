// Count the D1 queries one uncached report run makes, per dataset, as the Cloudflare Workers Free plan counts them: every
// first(), all() and run() is one query and a db.batch() is one more, whatever its size. Each run gets a fresh database, so
// the per-isolate report data cache (keyed by database identity) starts empty.
import assert from "node:assert/strict";
import type { D1Database, D1Statement } from "../../apps/api/src/d1-usage.ts";
import { createSessionCodec } from "../../apps/api/src/runtime-security.ts";
import { defaultReportDefinition, reportColumnCatalog, reportDatasetCatalog } from "../../apps/api/src/report-builder.ts";
import { sessionSecret } from "./backup-database.ts";
import { PluginDatabase } from "./plugin-database.ts";

/** The Free plan allows 50 D1 queries per invocation; a report run must leave room for the rest of the request. */
export const reportQueryBudget = 30;

type Fetcher = { fetch(request: Request, env: unknown): Promise<Response> };
const created = "2026-10-01T00:00:00.000Z";

/** A D1 wrapper that counts queries as D1 bills them and keeps each statement's SQL for diagnostics. */
export function countingDatabase(database: D1Database) {
  const log: string[] = []; let counting = false;
  const statements = new WeakMap<object, D1Statement>();
  const wrap = (statement: D1Statement, sql: string): D1Statement => {
    const wrapped: D1Statement = {
      bind: (...values) => wrap(statement.bind(...values), sql),
      first: (...args: []) => { if (counting) log.push(sql); return statement.first(...args); },
      all: () => { if (counting) log.push(sql); return statement.all(); },
      run: () => { if (counting) log.push(sql); return statement.run(); },
    };
    statements.set(wrapped, statement);
    return Object.assign(wrapped, { sql });
  };
  const counted: D1Database = {
    prepare: (sql) => wrap(database.prepare(sql), sql),
    batch: (batch) => { if (counting) log.push(`batch(${batch.length}): ${batch.map((statement) => (statement as { sql?: string }).sql?.replace(/\s+/g, " ").slice(0, 60)).join(" | ")}`); return database.batch(batch.map((statement) => statements.get(statement) ?? statement)); },
  };
  return { database: counted, log, start() { log.length = 0; counting = true; }, stop() { counting = false; return [...log]; } };
}

/**
 * A migrated installation through the Worker with the given modules enabled and set up, synthetic members, labels, a
 * meeting with attendance, and plugin rows where those plugins are composed. Returns a client whose `measure` counts one
 * request's D1 queries.
 */
export async function reportInstallation(worker: Fetcher, enabled: readonly string[]) {
  const db = new PluginDatabase();
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test" };
  const call = async (path: string, body?: unknown, method?: string) => {
    const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
    return worker.fetch(new Request(`https://api.example.test${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  };
  const json = async (path: string, body?: unknown, method?: string) => { const response = await call(path, body, method); const text = await response.text(); assert.ok(response.ok, `${path}: ${response.status} ${text}`); return JSON.parse(text) as Record<string, any>; };
  const modules = await json("/platform/modules");
  if (enabled.length > 1) await json("/admin/modules", { enabled, revision: modules.revision, confirmDisable: [] }, "PUT");
  const setUp = async (moduleId: string, stepId: string) => {
    const generation = (await json("/platform/modules")).modules.find((module: any) => module.id === moduleId).generation as number;
    await json(`/admin/modules/${moduleId}/setup`, { generation, stepId, outcome: "completed" }, "PUT");
  };
  db.raw.exec(`UPDATE organization_settings SET attendance_reporting_starts_on='2026-09-01';
    INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,email) VALUES
      ('ma','primary','T-A','Test Student','A','2026-01-01','test-student-a@example.test'),('mb','primary','T-B','Test Student','B','2026-01-01','test-student-b@example.test');
    INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES
      ('meet-1','primary','Test Meeting 1','2026-09-08T16:00:00Z','2026-09-08T18:00:00Z','admin','${created}'),('meet-2','primary','Test Meeting 2','2026-09-15T16:00:00Z','2026-09-15T18:00:00Z','admin','${created}');
    INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) VALUES
      ('in-a','primary','ma','meet-1','manual','2026-09-08T16:00:00Z','check_in'),('out-a','primary','ma','meet-1','manual','2026-09-08T18:00:00Z','check_out');
    INSERT INTO member_labels(id,installation_id,name,active,formula_enabled,created_at) VALUES
      ('robotics','primary','Test Robotics Class',1,0,'2026-01-01'),('build','primary','Test Build Team',1,0,'2026-01-01'),('crew','primary','Test Outreach Crew',1,0,'2026-01-01'),('mentors','primary','Test Mentors',1,0,'2026-01-01');
    INSERT INTO label_attendance_rules(id,installation_id,label_id,starts_on,ends_on,rule_type,threshold_percent,meetings_per_week,excused_handling,created_at,updated_at) VALUES
      ('rule-robotics','primary','robotics',NULL,NULL,'weighted_percentage',80,NULL,'exclude','2026-01-01','2026-01-01'),
      ('rule-build','primary','build',NULL,NULL,'weighted_percentage',75,NULL,'count_missed','2026-01-01','2026-01-01'),
      ('rule-crew','primary','crew',NULL,NULL,'weekly_count',NULL,1,'exclude','2026-01-01','2026-01-01');
    INSERT INTO member_label_changes(id,installation_id,member_id,label_id,action,effective_date,created_at) VALUES
      ('ma-robotics','primary','ma','robotics','add','2026-08-01','2026-08-01'),('ma-build','primary','ma','build','add','2026-08-01','2026-08-01'),('mb-crew','primary','mb','crew','add','2026-08-01','2026-08-01'),('mb-mentors','primary','mb','mentors','add','2026-08-01','2026-08-01');
    INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at) VALUES
      ('mb-meet-2','primary','mb','meet-2','excused','Synthetic test outcome','admin','2026-09-20T00:00:00.000Z');`);
  if (enabled.includes("hour-tracking")) {
    db.raw.exec(`INSERT INTO hours_teams(installation_id,id,number,name,program,created_at,updated_at) VALUES ('primary','test-team-99902','99902','Test Team 99902','FIRST Robotics Competition','${created}','${created}')`);
    await setUp("hour-tracking", "rules"); await setUp("hour-tracking", "catalog");
    db.raw.exec(`INSERT OR IGNORE INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES ('primary','event','Event','event',1,'${created}','${created}');
      INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,created_at,updated_at) VALUES ('primary','activity-1','event','event','2026-09-20','Test Open House','${created}','${created}');
      INSERT INTO hours_entries(installation_id,id,member_id,activity_id,service_date,time_zone,start_local,end_local,start_ms,end_ms,start_offset_seconds,end_offset_seconds,duration_minutes,attribution,actor_user_id,created_at,updated_at) VALUES
        ('primary','entry-a','ma','activity-1','2026-09-20','UTC','10:00','11:00',0,3600000,0,0,60,'staff_recorded','admin','${created}','${created}'),
        ('primary','entry-b','mb','activity-1','2026-09-20','UTC','11:00','12:40',3600000,9600000,0,0,100,'staff_recorded','admin','${created}','${created}')`);
  }
  if (enabled.includes("visits")) {
    const start = Date.parse("2026-09-10T16:00:00.000Z");
    db.raw.exec(`UPDATE visits_settings SET test_email_sent_at='${created}';
      INSERT INTO visits_windows(installation_id,id,start_ms,end_ms,created_at,updated_at) VALUES ('primary','window-1',${start},${start + 7_200_000},'${created}','${created}')`);
    await setUp("visits", "email"); await setUp("visits", "availability");
    db.raw.exec(`INSERT INTO visits_teams(installation_id,id,number,name,program,created_at,updated_at) VALUES ('primary','guest-99901','99901','Test Team 99901','FRC','${created}','${created}');
      INSERT INTO visits_bookings(installation_id,id,window_id,team_id,contact_name,contact_email,arrival_ms,departure_ms,headcount,created_at,updated_at)
        VALUES ('primary','visit-1','window-1','guest-99901','Test Student A','test-student-a@example.test',${start},${start + 3_600_000},4,'${created}','${created}')`);
  }
  return {
    db, call, json,
    /**
     * One request's D1 queries, with the SQL of each, through a new binding over the same database: a new isolate's view.
     * `cold` counts the isolate's first request, module reconciliation included; otherwise a /health request warms the
     * isolate first. Either way the report data cache, keyed by the binding, starts empty.
     */
    async measure(path: string, body?: unknown, { cold = false } = {}) {
      const isolate = countingDatabase(db as unknown as D1Database);
      const isolateEnv = { ...env, DB: isolate.database };
      const send = async (target: string, payload?: unknown) => {
        const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
        return worker.fetch(new Request(`https://api.example.test${target}`, { method: payload === undefined ? "GET" : "POST", headers: { cookie, ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), isolateEnv);
      };
      if (!cold) assert.equal((await send("/health")).status, 200);
      isolate.start();
      const response = await send(path, body); const text = await response.text();
      const log = isolate.stop(); assert.ok(response.ok, `${path}: ${response.status} ${text}`);
      return { queries: log.length, log, body: text };
    },
  };
}

/** Every dataset the composed build offers, with its default definition and an all-time period so every row is read. */
export function reportDatasetDefinitions() {
  return reportDatasetCatalog.flatMap((dataset) => {
    const base = { ...defaultReportDefinition(false, dataset.id), period: { type: "all" as const } };
    // Every column the dataset offers, so each source module's projection runs; label columns use one label.
    const columns = [base.columns[0]!, ...dataset.fields.filter((field) => field.id !== base.columns[0]!.key).map((field) => ({ key: field.id, ...(reportColumnCatalog.find((item) => item.key === field.id)?.requiresLabel ? { labelId: "robotics" } : {}) }))].slice(0, 32);
    return [{ id: dataset.id, definition: base }, { id: `${dataset.id} (every column)`, definition: { ...base, columns } }];
  });
}

/** Each dataset's uncached report query, each in a new isolate over one installation. */
export async function measureReportDatasets(worker: Fetcher, enabled: readonly string[], options: { cold?: boolean } = {}) {
  const installation = await reportInstallation(worker, enabled);
  try {
    const results: { id: string; queries: number; log: string[]; body: string }[] = [];
    for (const { id, definition } of reportDatasetDefinitions()) results.push({ id, ...await installation.measure("/reports/query", { definition, pageSize: "all" }, options).catch((error) => { throw new Error(`${id}: ${error.message}`); }) });
    return results;
  } finally { installation.db.raw.close(); }
}
