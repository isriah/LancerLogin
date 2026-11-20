// Label role jobs on the Durable Object scheduler, where each slice has the budget in scheduledSliceLimits. Seen on a
// team's v2.1.0-beta.8 install with three two-way labels: the two-way check used most of the slice, the role job was
// claimed, found no room for a single member, was released and asked for another slice a second later, forever. Every
// slice that takes a role job must change at least one member's role, and every label's queued changes must finish.
// Synthetic data only: no request leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { registeredCoreSchedulerJobs, registeredModuleSchedulerJobs, runSchedulerSlice, type Env } from "../apps/api/src/index.ts";
import { scheduledSliceLimits } from "../apps/api/src/scheduler-budget.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { InstallationSeed, TestD1Database, attendanceWithOutreachDisabled } from "./fixtures/d1-database.ts";
import { sessionSecret } from "./fixtures/worker-fake-database.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";

const guildId = "123456789012345678", botId = "523456789012345678", botRoleId = "623456789012345678";
const job = "attendance.discord-label-roles";
const labels = ["label-a", "label-b", "label-c"];
const roleFor = (index: number) => String(700000000000000000n + BigInt(index));
const userFor = (index: number) => String(800000000000000000n + BigInt(index));
const membersPerLabel = 10;

/**
 * Three two-way labels, each with ten members who have the label but not its role, so every label needs ten role
 * additions. Label A already has its job of ten pending members, queued by an earlier check.
 */
async function installation() {
  const db = new TestD1Database({ seed: new InstallationSeed("2026-09-01T00:00:00Z").users("admin").organization().modules(...attendanceWithOutreachDisabled(true)) });
  const discord = await encryptIntegration({ botToken: "synthetic-bot-token", guildId, applicationId: "323456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  db.sqlite.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES ('discord-1','primary','discord',?,?,'2026-09-01','2026-09-01')").run(discord.ciphertext, discord.iv);
  db.sqlite.exec("UPDATE installations SET discord_enabled = 1");
  const member = db.sqlite.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id,active,created_at) VALUES (?,'primary',?,'Test Student',?,?,?,1,'2026-01-01')");
  const change = db.sqlite.prepare("INSERT INTO member_label_changes(id,installation_id,member_id,label_id,action,effective_date,created_by,created_at) VALUES (?,'primary',?,?,'add','2026-02-01','admin','2026-02-01T00:00:00.000Z')");
  labels.forEach((label, index) => {
    db.sqlite.prepare("INSERT INTO member_labels(id,installation_id,name,created_at) VALUES (?,'primary',?,'2026-01-01T00:00:00.000Z')").run(label, `Test Label ${String.fromCharCode(65 + index)}`);
    // Label A was checked first, so the check that queued its job is the oldest.
    db.sqlite.prepare("INSERT INTO discord_label_role_mappings(installation_id,label_id,guild_id,role_id,role_name,created_at,sync_direction,two_way_enabled_at,two_way_checked_at) VALUES ('primary',?,?,?,?,'2026-01-01T00:00:00.000Z','two_way','2026-01-01T00:00:00.000Z',?)").run(label, guildId, roleFor(index), `Test Role ${index}`, `2026-01-0${index + 2}T00:00:00.000Z`);
    for (let n = 0; n < membersPerLabel; n += 1) {
      const id = `m-${index}-${n}`, number = index * membersPerLabel + n;
      member.run(id, `TEST-${number}`, `No. ${number}`, `test-student-${number}@example.test`, userFor(number));
      change.run(`add-${id}`, id, label);
    }
  });
  const added: string[] = [];
  const guildMembers = () => Array.from({ length: labels.length * membersPerLabel }, (_, number) => ({ user: { id: userFor(number), username: `test-student-${number}` }, roles: labels.map((_, index) => roleFor(index)).filter((role) => added.includes(`${number}:${role}`)) }));
  const roles = [{ id: guildId, name: "@everyone", position: 0, permissions: "0" }, { id: botRoleId, name: "Test Bot", position: 100, permissions: String(1 << 28) }, ...labels.map((_, index) => ({ id: roleFor(index), name: `Test Role ${index}`, position: index + 1, permissions: "0" }))];
  const requests: string[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace("https://discord.com/api/v10", ""); const method = init?.method ?? "GET"; requests.push(`${method} ${url}`);
    if (url.endsWith("/roles")) return Response.json(roles);
    if (url.endsWith("/users/@me")) return Response.json({ id: botId });
    if (url.endsWith(`/members/${botId}`)) return Response.json({ user: { id: botId }, roles: [botRoleId] });
    if (url.includes("/members?limit=1000")) return Response.json(guildMembers());
    const role = /\/members\/(\d+)\/roles\/(\d+)$/.exec(url);
    if (role && method === "PUT") { added.push(`${BigInt(role[1]!) - 800000000000000000n}:${role[2]}`); return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected Discord request: ${method} ${url}`);
  }) as typeof fetch;
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: db } as unknown as Env;
  return { db, env, requests, added, fetchStub };
}
const jobRows = (db: TestD1Database) => db.sqlite.prepare("SELECT j.label_id AS labelId, j.status, SUM(i.status = 'completed') AS completed, SUM(i.status = 'pending') AS pending, SUM(i.status = 'failed') AS failed FROM discord_label_role_jobs j JOIN discord_label_role_job_items i ON i.job_id = j.id GROUP BY j.id ORDER BY j.created_at, j.label_id").all() as { labelId: string; status: string; completed: number; pending: number; failed: number }[];
const completedItems = (db: TestD1Database) => (db.sqlite.prepare("SELECT COUNT(*) AS n FROM discord_label_role_job_items WHERE status = 'completed'").get() as { n: number }).n;

/** An Admin's request to the Worker; a POST when `body` is given. Passes it starts are collected in `passes`. */
async function call(env: Env, path: string, body?: unknown, passes: Promise<unknown>[] = []): Promise<Record<string, unknown>> {
  const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
  const context = { waitUntil: (promise: Promise<unknown>) => { passes.push(promise); } };
  const response = await worker.fetch(new Request(`https://api.example.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, origin: "https://dashboard.example.test", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, context as never);
  assert.ok(response.status < 300, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}
type ListedJob = { status: string; total: number; completed: number; failed: number };
const listedJobs = async (env: Env) => Object.fromEntries(((await call(env, "/admin/integrations/discord/label-roles")).mappings as { labelId: string; latestJob?: ListedJob }[]).map((mapping) => [mapping.labelId, mapping.latestJob && { status: mapping.latestJob.status, total: mapping.latestJob.total, completed: mapping.latestJob.completed, failed: mapping.latestJob.failed }]));

/**
 * Queues label A's ten additions through Sync to Discord, so the job carries the fingerprint the Worker checks again,
 * then puts them back to pending as the team's job was: queued, with nobody changed yet.
 */
async function queueLabelA(env: Env, fetchStub: typeof fetch, added: string[]) {
  const db = (env.DB as unknown as TestD1Database).sqlite; const original = globalThis.fetch; globalThis.fetch = fetchStub;
  try {
    db.exec("UPDATE discord_label_role_mappings SET sync_direction = 'to_discord' WHERE label_id = 'label-a'");
    const passes: Promise<unknown>[] = [];
    const preview = await call(env, "/admin/integrations/discord/label-roles/preview", { labelId: "label-a" }, passes);
    await call(env, "/admin/integrations/discord/label-roles/apply", { previewId: preview.previewId }, passes);
    await Promise.allSettled(passes);
  } finally { globalThis.fetch = original; }
  db.exec("UPDATE discord_label_role_mappings SET sync_direction = 'two_way'; UPDATE discord_label_role_job_items SET status = 'pending', attempts = 0; UPDATE discord_label_role_jobs SET status = 'pending', completed_at = NULL, lease_token = NULL, lease_expires_at = NULL");
  added.length = 0;
}

const jobUpdates = (db: TestD1Database) => new Map((db.sqlite.prepare("SELECT id, updated_at AS updatedAt FROM discord_label_role_jobs").all() as { id: string; updatedAt: string }[]).map((row) => [row.id, row.updatedAt]));
/** Every other scheduler job has just run, so each slice below is the label job's. */
function quietOtherJobs(db: TestD1Database, now: number) {
  const row = db.sqlite.prepare("SELECT jobs_json AS j FROM platform_scheduler_state").get() as { j: string } | undefined;
  const states = row ? JSON.parse(row.j) as Record<string, unknown> : {};
  for (const id of [...registeredCoreSchedulerJobs, ...registeredModuleSchedulerJobs].map((entry) => entry.id)) if (id !== job) states[id] = { next: now + 3_600_000, last: now - 60_000, outcome: "ok" };
  db.sqlite.prepare("INSERT INTO platform_scheduler_state(installation_id,jobs_json,updated_at) VALUES ('primary',?,?) ON CONFLICT(installation_id) DO UPDATE SET jobs_json = excluded.jobs_json").run(JSON.stringify(states), new Date(now).toISOString());
}

test("with three two-way labels every slice that takes a role job changes a member's role, and every label's changes finish", async () => {
  const { db, env, added, fetchStub } = await installation();
  await queueLabelA(env, fetchStub, added);
  assert.deepEqual(jobRows(db).map((row) => [row.labelId, row.status, row.pending]), [["label-a", "pending", membersPerLabel]], "label A starts with ten pending members");
  const original = globalThis.fetch; globalThis.fetch = fetchStub;
  try {
    // Settings > Labels lists each label's latest job with its progress, so a job the scheduler queued shows as syncing.
    assert.deepEqual(await listedJobs(env), { "label-a": { status: "pending", total: 10, completed: 0, failed: 0 }, "label-b": undefined, "label-c": undefined });
    let now = Date.now(); const slices: { d1: number; external: number; completed: number; touched: number }[] = [];
    // The job falls due (the write that queued the changes pokes it), then runs again each time it asks for more.
    let pokes: Record<string, number> = { [job]: now };
    for (let slice = 0; slice < 30 && completedItems(db) < labels.length * membersPerLabel; slice += 1) {
      quietOtherJobs(db, now);
      const before = completedItems(db); const updates = jobUpdates(db);
      const report = await runSchedulerSlice(env, pokes, now, { started: async () => undefined });
      assert.deepEqual(report.attempted, [job]);
      const after = jobUpdates(db); const touched = [...updates].filter(([id, at]) => after.get(id) !== at).length;
      slices.push({ d1: report.d1Queries, external: report.externalRequests, completed: completedItems(db) - before, touched });
      // Claiming a role job and releasing it with nobody changed, slice after slice, is what stalled the team's labels.
      assert.ok(!(touched && slices.at(-1)!.completed === 0), `slice ${slice + 1} took a role job and changed nobody: ${JSON.stringify(slices)}`);
      assert.ok(report.d1Queries <= scheduledSliceLimits.d1 + 1 && report.externalRequests <= scheduledSliceLimits.external, `slice ${slice + 1} stays within its budget: ${JSON.stringify(slices)}`);
      // Continue when the slice asked to; otherwise the job's next five-minute run.
      now = report.more ? report.nextWake : now + 300_000; pokes = report.more ? {} : { [job]: now };
    }
    assert.deepEqual(jobRows(db).map((row) => [row.labelId, row.status, row.completed, row.failed]), labels.map((label) => [label, "completed", membersPerLabel, 0]), `every label's role changes finish: ${JSON.stringify(slices)}`);
    assert.equal(new Set(added).size, labels.length * membersPerLabel, "each member got each role once");
    assert.deepEqual(await listedJobs(env), Object.fromEntries(labels.map((label) => [label, { status: "completed", total: 10, completed: 10, failed: 0 }])));
    assert.ok(slices.length <= 12, `finished within a bounded number of slices: ${JSON.stringify(slices)}`);
  } finally { globalThis.fetch = original; }
});

test("the cron fallback runs queued role changes and the two-way check in the same pass", async () => {
  const { db, env, added, fetchStub } = await installation();
  await queueLabelA(env, fetchStub, added);
  const original = globalThis.fetch; globalThis.fetch = fetchStub;
  try {
    const passes: number[] = [];
    for (let pass = 0; pass < 8 && completedItems(db) < labels.length * membersPerLabel; pass += 1) {
      const before = completedItems(db); const now = Date.now();
      quietOtherJobs(db, now); db.sqlite.exec(`UPDATE platform_scheduler_state SET jobs_json = json_set(jobs_json, '$."${job}".next', 0)`);
      await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: now } as never, env);
      passes.push(completedItems(db) - before);
    }
    assert.deepEqual(jobRows(db).map((row) => [row.labelId, row.status, row.completed]), labels.map((label) => [label, "completed", membersPerLabel]), JSON.stringify(passes));
    assert.ok(passes.every((count) => count > 0), `every pass changes someone's role: ${JSON.stringify(passes)}`);
  } finally { globalThis.fetch = original; }
});
