// quick-check: covers apps/api/migrations/**
// The bulk Discord label routes (Sync all linked roles, and Create labels from roles) on a real migrated SQLite database
// with a synthetic Discord server. Each must stay within the Cloudflare Workers Free limit of 50 subrequests per
// invocation at its full size, where every D1 query, every db.batch() and every Discord request counts as one; must use
// the same number whatever the number of labels; must give the results the one-label routes give; and must leave nothing
// half-applied when it fails. Synthetic data only: no request leaves the process.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/index.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import type { D1Database } from "../apps/api/src/d1-usage.ts";
import { BackupDatabase, sessionSecret } from "./fixtures/backup-database.ts";
import { countingDatabase } from "./fixtures/report-query-budget.ts";

/** Well under the 50 the plan allows, so the rest of an invocation (a job pass started by the request) has room. */
const subrequestBudget = 15;
/** A request together with the job pass it starts in its invocation: under the 50 the plan allows, with room to spare. */
const invocationBudget = 45;
const guildId = "123456789012345678", botId = "523456789012345678", botRoleId = "623456789012345678";
const roleIdFor = (index: number) => String(700000000000000000n + BigInt(index));
const userIdFor = (index: number) => String(800000000000000000n + BigInt(index));
const pad = (index: number) => String(index).padStart(2, "0");
const labelIdFor = (index: number) => `label-${pad(index)}`;
const memberCount = 30;

type Preview = { previewId: string; labelId: string; labelName: string; roleId: string; roleName: string; memberCount: number; additions: { discordUserId: string }[]; removals: { discordUserId: string }[]; unpaired: unknown[]; absent: unknown[]; inactive: unknown[] };
type Job = { jobId: string; labelId: string; status: string; additions: number; removals: number };

/**
 * An installation with `labels` linked labels and thirty synthetic members, and a synthetic Discord server with one role
 * per label. Label 0 already matches the server, so its sync has nothing to change. The others mix every preview outcome:
 * members to add and remove, an unpaired member, one absent from the server, an inactive one, a member whose label was
 * removed again, and one whose label starts in the future.
 */
async function fixture(context: TestContext, labels: number, options: { linked?: boolean } = {}) {
  const db = new BackupDatabase(); context.after(() => db.raw.close());
  const encrypted = await encryptIntegration({ botToken: "synthetic-bot-token", guildId }, sessionSecret);
  db.raw.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, verified_at, updated_at) VALUES ('discord-1', 'primary', 'discord', ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')").run(encrypted.ciphertext, encrypted.iv);
  db.raw.exec("UPDATE installations SET discord_enabled = 1");
  const insertMember = db.raw.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id,active,created_at) VALUES (?, 'primary', ?, 'Test Student', ?, ?, ?, ?, '2026-01-01')");
  // Member 1 is unpaired, member 2 is inactive and member 3 is paired with an account that is not in the server.
  for (let index = 0; index < memberCount; index += 1) insertMember.run(`m-${String(index).padStart(2, "0")}`, `TEST-${index}`, `No. ${index}`, `test-student-${index}@example.test`, index === 1 ? null : userIdFor(index), index === 2 ? 0 : 1);
  const insertLabel = db.raw.prepare("INSERT INTO member_labels(id,installation_id,name,created_at) VALUES (?, 'primary', ?, '2026-01-01T00:00:00.000Z')");
  const insertMapping = db.raw.prepare("INSERT INTO discord_label_role_mappings(installation_id,label_id,guild_id,role_id,role_name,created_at) VALUES ('primary', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')");
  const insertChange = db.raw.prepare("INSERT INTO member_label_changes(id,installation_id,member_id,label_id,action,effective_date,created_by,created_at) VALUES (?, 'primary', ?, ?, ?, ?, 'admin', ?)");
  const holds = (label: number, member: number) => label === 0 ? member >= 10 && member < 14 : (member + label) % 3 === 0;
  for (let label = 0; label < labels; label += 1) {
    insertLabel.run(labelIdFor(label), `Test Label ${pad(label)}`);
    if (options.linked !== false) insertMapping.run(labelIdFor(label), guildId, roleIdFor(label), `Test Role ${label}`);
    for (let member = 0; member < memberCount; member += 1) {
      const id = `m-${String(member).padStart(2, "0")}`;
      if (holds(label, member)) insertChange.run(`add-${label}-${member}`, id, labelIdFor(label), "add", "2026-02-01", "2026-02-01T00:00:00.000Z");
      // Added and later removed: the later row decides.
      else if (label > 0 && (member + label) % 3 === 1 && member % 2 === 0) { insertChange.run(`add-${label}-${member}`, id, labelIdFor(label), "add", "2026-02-01", "2026-02-01T00:00:00.000Z"); insertChange.run(`remove-${label}-${member}`, id, labelIdFor(label), "remove", "2026-02-15", "2026-02-15T00:00:00.000Z"); }
      // Not in effect until a date far in the future.
      else if (label > 0 && member % 7 === 5) insertChange.run(`later-${label}-${member}`, id, labelIdFor(label), "add", "2999-01-01", "2026-02-01T00:00:00.000Z");
    }
  }
  // In the server: every paired member but member 3, and a stranger. Label 0's role is held by exactly its members; every
  // other role is held by members 4 to 9 and the stranger, whatever the label says.
  const guildMembers = [...Array.from({ length: memberCount }, (_, index) => index).filter((index) => index !== 1 && index !== 3).map((index) => ({ user: { id: userIdFor(index), username: `test-student-${index}` }, roles: Array.from({ length: Math.max(labels, 25) }, (_, label) => label).filter((label) => label === 0 ? holds(0, index) : index >= 4 && index < 10).map(roleIdFor) })),
    { user: { id: userIdFor(99), username: "test-stranger" }, roles: Array.from({ length: Math.max(labels, 25) }, (_, label) => label + 1).map(roleIdFor) }];
  const roles = [{ id: guildId, name: "@everyone", position: 0, permissions: "0" }, { id: botRoleId, name: "Test Bot", position: 100, permissions: String(1 << 28) }, ...Array.from({ length: Math.max(labels, 25) }, (_, index) => ({ id: roleIdFor(index), name: `Test Role ${index}`, position: index + 1, permissions: "0" }))];
  const discord = { requests: 0, roles };
  const originalFetch = globalThis.fetch; context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input); discord.requests += 1;
    if (!url.startsWith("https://discord.com/api/v10/")) throw new Error(`Unexpected request: ${url}`);
    if (url.endsWith("/roles")) return Response.json(discord.roles);
    if (url.endsWith("/users/@me")) return Response.json({ id: botId });
    if (url.endsWith(`/members/${botId}`)) return Response.json({ user: { id: botId }, roles: [botRoleId] });
    if (url.includes("/members?limit=1000")) return Response.json(guildMembers);
    if (/\/members\/\d+\/roles\/\d+$/.test(url)) return new Response(null, { status: 204 });
    throw new Error(`Unexpected Discord request: ${url}`);
  };
  const counted = countingDatabase(db);
  // `beforeJobWrite` runs just before the batch that writes jobs, standing in for another request that finished first.
  const hooks: { beforeJobWrite?: () => void } = {};
  const database: D1Database = { prepare: (sql) => counted.database.prepare(sql), batch: (statements) => { if (statements.some((statement) => (statement as { sql?: string }).sql?.includes("INSERT INTO discord_label_role_jobs"))) hooks.beforeJobWrite?.(); return counted.database.batch(statements); } };
  const env = { DB: database, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test" };
  // The first request in an isolate reconciles installed modules; serve it before any measured request.
  await worker.fetch(new Request("https://fixture.test/health"), env);
  const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
  /**
   * One request, with the subrequests it made: D1 queries and batches plus Discord requests. With `background`, the work
   * the request leaves running in its invocation (waitUntil) runs too and is counted with it.
   */
  const call = async (path: string, body: unknown, background = false) => {
    const running: Promise<unknown>[] = []; discord.requests = 0; counted.start();
    const result = await worker.fetch(new Request(`https://fixture.test${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), env, background ? { waitUntil: (promise) => { running.push(promise); } } : undefined);
    const text = await result.text(); await Promise.all(running); const queries = counted.stop();
    return { status: result.status, body: JSON.parse(text) as Record<string, any>, usage: { d1: queries.length, discord: discord.requests, total: queries.length + discord.requests }, queries };
  };
  return { db, call, discord, hooks };
}
const base = "/admin/integrations/discord/label-roles";
const outcome = (preview: Preview) => ({ labelId: preview.labelId, labelName: preview.labelName, roleId: preview.roleId, roleName: preview.roleName, memberCount: preview.memberCount, additions: preview.additions, removals: preview.removals, unpaired: preview.unpaired, absent: preview.absent, inactive: preview.inactive });
const fingerprints = (db: BackupDatabase) => Object.fromEntries(db.rows<{ label_id: string; fingerprint: string }>("SELECT label_id, fingerprint FROM discord_label_role_previews ORDER BY label_id").map((row) => [row.label_id, row.fingerprint]));
const jobState = (db: BackupDatabase) => db.rows<Record<string, unknown>>(`SELECT j.label_id AS labelId, j.status, j.guild_id AS guildId, j.role_id AS roleId, j.source_fingerprint AS sourceFingerprint, j.actor_user_id AS actor, j.completed_at IS NOT NULL AS completed,
  (SELECT json_group_array(json_array(discord_user_id, action, status)) FROM (SELECT discord_user_id, action, status FROM discord_label_role_job_items i WHERE i.job_id = j.id ORDER BY discord_user_id)) AS items,
  (SELECT COUNT(*) FROM audit_log a WHERE a.action = 'discord.label_role_sync_requested' AND a.target_id = j.label_id AND json_extract(a.metadata_json, '$.jobId') = j.id) AS audits
  FROM discord_label_role_jobs j ORDER BY j.label_id`);
const report = (route: string, labels: number, usage: { d1: number; discord: number; total: number }, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ benchmark: "discord_label_bulk_subrequests", route, labels, ...usage, ...extra }));

test("Preview all previews 25 linked labels within the subrequest limit, with the previews the one-label route gives", async (context) => {
  const bulk = await fixture(context, 25);
  const all = await bulk.call(`${base}/preview-all`, {});
  assert.equal(all.status, 200, JSON.stringify(all.body));
  const previews = all.body.previews as Preview[];
  assert.equal(previews.length, 25); assert.deepEqual(all.body.skipped, []);
  report("preview-all", 25, all.usage);
  assert.ok(all.usage.total <= subrequestBudget, `${all.usage.total} subrequests: ${all.queries.join("\n")}`);
  // The fixture exercises every outcome, so equal previews are a meaningful comparison.
  assert.ok(previews[5].additions.length > 0 && previews[5].removals.length > 0 && previews[5].unpaired.length + previews[4].unpaired.length > 0 && previews.some((preview) => preview.absent.length > 0) && previews.some((preview) => preview.inactive.length > 0));
  assert.deepEqual([previews[0].additions, previews[0].removals], [[], []], "label 0 already matches the server");

  const single = await fixture(context, 25);
  const one: Preview[] = [];
  for (let label = 0; label < 25; label += 1) { const result = await single.call(`${base}/preview`, { labelId: labelIdFor(label) }); assert.equal(result.status, 200, JSON.stringify(result.body)); one.push(result.body as Preview); }
  assert.deepEqual(previews.map(outcome), one.map(outcome));
  assert.deepEqual(fingerprints(bulk.db), fingerprints(single.db), "the stored fingerprints, which cover each roster and role, are the same");

  // The count is the same for 3 labels as for 25: nothing is read or written per label.
  const small = await fixture(context, 3);
  const few = await small.call(`${base}/preview-all`, {});
  assert.equal((few.body.previews as Preview[]).length, 3); assert.deepEqual(few.usage, all.usage);
});

test("Preview all skips a label it cannot sync and still stores the others in one batch", async (context) => {
  const { db, call, discord } = await fixture(context, 6);
  discord.roles = discord.roles.filter((role) => role.id !== roleIdFor(2));
  db.raw.exec(`UPDATE discord_label_role_mappings SET two_way_error = 'restore_review_required' WHERE label_id = '${labelIdFor(4)}'`);
  const all = await call(`${base}/preview-all`, {});
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual((all.body.previews as Preview[]).map((preview) => preview.labelId), [0, 1, 3, 5].map(labelIdFor));
  assert.deepEqual((all.body.skipped as { labelId: string; reason: string }[]).map((item) => item.labelId), [2, 4].map(labelIdFor));
  assert.match(all.body.skipped[0].reason, /no longer exists/); assert.match(all.body.skipped[1].reason, /paused after a restore/);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_previews"), 4);
});

test("Apply all starts 25 jobs within the subrequest limit, with the jobs the one-preview route starts", async (context) => {
  const bulk = await fixture(context, 25);
  const previews = (await bulk.call(`${base}/preview-all`, {})).body.previews as Preview[];
  const applied = await bulk.call(`${base}/apply-all`, { previewIds: previews.map((preview) => preview.previewId) });
  assert.equal(applied.status, 202, JSON.stringify(applied.body));
  const jobs = applied.body.jobs as Job[];
  assert.deepEqual(applied.body.failed, []); assert.equal(jobs.length, 25);
  report("apply-all", 25, applied.usage);
  assert.ok(applied.usage.total <= subrequestBudget, `${applied.usage.total} subrequests: ${applied.queries.join("\n")}`);
  assert.deepEqual(jobs.map((job) => [job.labelId, job.status, job.additions, job.removals]), previews.map((preview) => [preview.labelId, preview.additions.length + preview.removals.length ? "pending" : "completed", preview.additions.length, preview.removals.length]));
  assert.equal(jobs[0].status, "completed", "nothing to change for label 0");
  assert.equal(bulk.db.count("SELECT COUNT(*) AS n FROM discord_label_role_previews WHERE used_at IS NULL"), 0, "every preview is used");

  const single = await fixture(context, 25);
  for (let label = 0; label < 25; label += 1) {
    const preview = (await single.call(`${base}/preview`, { labelId: labelIdFor(label) })).body as Preview;
    const result = await single.call(`${base}/apply`, { previewId: preview.previewId });
    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.deepEqual([result.body.labelId, result.body.status, result.body.additions, result.body.removals], [jobs[label].labelId, jobs[label].status, jobs[label].additions, jobs[label].removals]);
  }
  // Jobs, their members and their audit entries, including the roster fingerprint a job pass checks before it changes a role.
  const written = jobState(bulk.db);
  assert.equal(written.length, 25); assert.ok(written.every((job) => job.audits === 1 && job.actor === "admin"));
  assert.ok(written.some((job) => String(job.items).includes('"add"')) && written.some((job) => String(job.items).includes('"remove"')));
  assert.deepEqual(written, jobState(single.db));
  // A job pass accepts a job the bulk route wrote: its roster fingerprint is the one the pass computes for itself.
  const advanced = await bulk.call(`/admin/integrations/discord/label-role-jobs/${jobs[1].jobId}/advance`, {});
  assert.equal(advanced.status, 200, JSON.stringify(advanced.body)); assert.notEqual(advanced.body.status, "stale");
  assert.ok((advanced.body.items as { status: string }[]).some((item) => item.status === "completed"));

  const small = await fixture(context, 3);
  const fewPreviews = (await small.call(`${base}/preview-all`, {})).body.previews as Preview[];
  const few = await small.call(`${base}/apply-all`, { previewIds: fewPreviews.map((preview) => preview.previewId) });
  assert.equal((few.body.jobs as Job[]).length, 3); assert.deepEqual(few.usage, applied.usage);
});

test("Apply all and the first job pass it starts stay within one invocation's subrequest limit", async (context) => {
  const { db, call } = await fixture(context, 25);
  const previews = (await call(`${base}/preview-all`, {})).body.previews as Preview[];
  const applied = await call(`${base}/apply-all`, { previewIds: previews.map((preview) => preview.previewId) }, true);
  assert.equal((applied.body.jobs as Job[]).length, 25);
  report("apply-all with its first job pass", 25, applied.usage);
  assert.ok(applied.usage.total <= 40, `${applied.usage.total} subrequests: ${applied.queries.join("\n")}`);
  // The pass changed some members' roles in the first job and left the rest for the next pass.
  assert.ok(db.count("SELECT COUNT(*) AS n FROM discord_label_role_job_items WHERE status = 'completed'") > 0);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_jobs WHERE status = 'running'"), 0);
});

// The one-label routes start a job pass in their own invocation too. Label 1 has twelve role changes (eleven for two-way,
// which leaves the stranger alone), more than a pass does, so each pass below runs at its item limit.
test("Sync to Discord, Retry failed and turning on two-way sync each stay within one invocation's subrequest limit with the job pass they start", async (context) => {
  const pending = (db: BackupDatabase, jobId: string) => db.count("SELECT COUNT(*) AS n FROM discord_label_role_job_items WHERE job_id = ? AND status = 'pending'", jobId);
  const done = (db: BackupDatabase, jobId: string) => db.count("SELECT COUNT(*) AS n FROM discord_label_role_job_items WHERE job_id = ? AND status = 'completed'", jobId);
  const within = (route: string, result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["call"]>>) => { report(route, 1, result.usage); assert.ok(result.usage.total <= invocationBudget, `${route}: ${result.usage.total} subrequests: ${result.queries.join("\n")}`); };

  const { db, call } = await fixture(context, 3);
  const preview = (await call(`${base}/preview`, { labelId: labelIdFor(1) })).body as Preview;
  assert.equal(preview.additions.length + preview.removals.length, 12);
  const applied = await call(`${base}/apply`, { previewId: preview.previewId }, true);
  assert.equal(applied.status, 202, JSON.stringify(applied.body));
  within("apply with its first job pass", applied);
  const jobId = applied.body.jobId as string;
  // The pass changed some members' roles and left the rest, still pending, for the dashboard's polling and the scheduler.
  assert.ok(done(db, jobId) > 0 && pending(db, jobId) > 0); assert.equal(done(db, jobId) + pending(db, jobId), 12);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_jobs WHERE status = 'pending' AND lease_token IS NULL"), 1);
  // Polling finishes the job: no member is lost by the shorter first pass.
  for (let pass = 0; pass < 6 && pending(db, jobId) > 0; pass += 1) assert.equal((await call(`/admin/integrations/discord/label-role-jobs/${jobId}/advance`, {})).status, 200);
  assert.equal(done(db, jobId), 12); assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_jobs WHERE id = ? AND status = 'completed'", jobId), 1);

  // Retry failed: every change of a partly failed sync is still needed (the synthetic server never changes).
  db.raw.exec(`UPDATE discord_label_role_jobs SET status = 'partial' WHERE id = '${jobId}'; UPDATE discord_label_role_job_items SET status = 'failed', last_error = 'synthetic failure' WHERE job_id = '${jobId}'`);
  const retried = await call(`/admin/integrations/discord/label-role-jobs/${jobId}/retry`, {}, true);
  assert.equal(retried.status, 202, JSON.stringify(retried.body)); assert.equal(retried.body.retried, 12);
  within("retry with its first job pass", retried);
  const retryId = retried.body.jobId as string;
  assert.ok(done(db, retryId) > 0 && pending(db, retryId) > 0); assert.equal(done(db, retryId) + pending(db, retryId), 12);

  // Turning on two-way sync with the dashboard chosen for everyone pushes eleven role changes.
  const twoWay = await fixture(context, 3);
  const review = await twoWay.call(`${base}/two-way/preview`, { labelId: labelIdFor(1) });
  assert.equal(review.status, 200, JSON.stringify(review.body)); assert.equal(review.body.mismatches.length, 11);
  const confirmed = await twoWay.call(`${base}/two-way/confirm`, { previewId: review.body.previewId, all: "dashboard" }, true);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body)); assert.equal(confirmed.body.rolesAdded + confirmed.body.rolesRemoved, 11);
  within("two-way confirm", confirmed);
  // The confirmation runs no pass of its own: the queued changes are the scheduler's label job, which its response pokes.
  const confirmId = confirmed.body.jobId as string;
  assert.equal(done(twoWay.db, confirmId), 0); assert.equal(pending(twoWay.db, confirmId), 11);
});

test("Apply all reports each preview it cannot use and starts the rest", async (context) => {
  const { db, call } = await fixture(context, 6);
  const previews = (await call(`${base}/preview-all`, {})).body.previews as Preview[];
  const again = (await call(`${base}/preview`, { labelId: labelIdFor(1) })).body as Preview;
  // Label 2's roster changes after its preview, label 3's preview expires, and label 4 already has a sync running.
  db.raw.exec(`INSERT INTO member_label_changes(id,installation_id,member_id,label_id,action,effective_date,created_by,created_at) VALUES ('late','primary','m-22','${labelIdFor(2)}','remove','2026-03-01','admin','2026-03-01T00:00:00.000Z');
    UPDATE discord_label_role_previews SET expires_at = '2026-01-01T00:00:00.000Z' WHERE id = '${previews[3].previewId}';
    INSERT INTO discord_label_role_jobs(id,installation_id,label_id,guild_id,role_id,status,source_fingerprint,actor_user_id,next_attempt_at,created_at,updated_at) VALUES ('running-job','primary','${labelIdFor(4)}','${guildId}','${roleIdFor(4)}','pending','f','admin','2999-01-01T00:00:00.000Z','2026-01-01','2026-01-01');`);
  const applied = await call(`${base}/apply-all`, { previewIds: [...previews.map((preview) => preview.previewId), again.previewId, "no-such-preview"] });
  assert.equal(applied.status, 202, JSON.stringify(applied.body));
  assert.deepEqual((applied.body.jobs as Job[]).map((job) => job.labelId), [0, 1, 5].map(labelIdFor));
  const failed = Object.fromEntries((applied.body.failed as { previewId: string; error: string }[]).map((item) => [item.previewId, item.error]));
  assert.match(failed[previews[2].previewId], /changed since the preview/); assert.match(failed[previews[3].previewId], /expired or was already used/);
  assert.match(failed[previews[4].previewId], /already in progress/); assert.match(failed[again.previewId], /already in progress/, "a second preview of a label whose sync this request started");
  assert.match(failed["no-such-preview"], /expired or was already used/); assert.equal(Object.keys(failed).length, 5);
  const used = (id: string) => db.count("SELECT COUNT(*) AS n FROM discord_label_role_previews WHERE id = ? AND used_at IS NOT NULL", id);
  assert.deepEqual([0, 1, 5].map((label) => used(previews[label].previewId)), [1, 1, 1]);
  assert.deepEqual([previews[2].previewId, previews[3].previewId, previews[4].previewId, again.previewId].map(used), [0, 0, 0, 0], "a refused preview is not used up");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_jobs WHERE id <> 'running-job'"), 3);
  // A used preview cannot start a second job.
  const repeat = await call(`${base}/apply-all`, { previewIds: [previews[0].previewId] });
  assert.deepEqual(repeat.body.jobs, []); assert.match(repeat.body.failed[0].error, /expired or was already used/);
  for (const previewIds of [[], ["a", "a"], Array.from({ length: 101 }, (_, index) => `p-${index}`)]) assert.equal((await call(`${base}/apply-all`, { previewIds })).status, 400);
});

test("Apply all starts nothing for a preview used, or a label whose sync started, after its checks", async (context) => {
  const { db, call, hooks } = await fixture(context, 4);
  const previews = (await call(`${base}/preview-all`, {})).body.previews as Preview[];
  hooks.beforeJobWrite = () => db.raw.exec(`UPDATE discord_label_role_previews SET used_at = '2026-01-01T00:00:00.000Z' WHERE id = '${previews[1].previewId}';
    INSERT INTO discord_label_role_jobs(id,installation_id,label_id,guild_id,role_id,status,source_fingerprint,actor_user_id,next_attempt_at,created_at,updated_at) VALUES ('other-job','primary','${labelIdFor(2)}','${guildId}','${roleIdFor(2)}','pending','f','admin','2999-01-01T00:00:00.000Z','2026-01-01','2026-01-01');`);
  const applied = await call(`${base}/apply-all`, { previewIds: previews.map((preview) => preview.previewId) });
  assert.equal(applied.status, 202, JSON.stringify(applied.body));
  assert.deepEqual((applied.body.jobs as Job[]).map((job) => job.labelId), [labelIdFor(0), labelIdFor(3)]);
  assert.deepEqual((applied.body.failed as { previewId: string }[]).map((item) => item.previewId), [previews[1].previewId, previews[2].previewId]);
  for (const item of applied.body.failed) assert.match(item.error, /already used, or a sync for this label just started/);
  assert.deepEqual(db.rows("SELECT id FROM discord_label_role_jobs WHERE label_id IN (?, ?)", labelIdFor(1), labelIdFor(2)), [{ id: "other-job" }]);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_job_items i JOIN discord_label_role_jobs j ON j.id = i.job_id WHERE j.label_id IN (?, ?)", labelIdFor(1), labelIdFor(2)), 0);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_previews WHERE id = ? AND used_at IS NULL", previews[2].previewId), 1, "the preview of the label that was syncing is not used up");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'discord.label_role_sync_requested'"), 2);
});

test("Apply all that fails part-way leaves every preview unused and starts no job", async (context) => {
  const { db, call } = await fixture(context, 25);
  const previews = (await call(`${base}/preview-all`, {})).body.previews as Preview[];
  // The write for the twentieth label fails.
  db.raw.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON discord_label_role_jobs WHEN NEW.label_id = '${labelIdFor(19)}' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
  const applied = await call(`${base}/apply-all`, { previewIds: previews.map((preview) => preview.previewId) });
  assert.equal(applied.status, 500);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_jobs"), 0); assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_job_items"), 0);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_previews WHERE used_at IS NOT NULL"), 0);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'discord.label_role_sync_requested'"), 0);
  // The same previews work once the fault is gone.
  db.raw.exec("DROP TRIGGER synthetic_failure");
  const retried = await call(`${base}/apply-all`, { previewIds: previews.map((preview) => preview.previewId) });
  assert.equal((retried.body.jobs as Job[]).length, 25); assert.deepEqual(retried.body.failed, []);
});

const linkState = (db: BackupDatabase) => db.rows(`SELECT l.name, l.active, l.formula_enabled AS formula, x.guild_id AS guildId, x.role_id AS roleId, x.role_name AS roleName, x.created_by AS createdBy,
  (SELECT COUNT(*) FROM audit_log a WHERE a.action = 'label.created' AND a.target_id = l.id) AS created, (SELECT COUNT(*) FROM audit_log a WHERE a.action = 'discord.label_role_associated' AND a.target_id = l.id) AS associated
  FROM member_labels l LEFT JOIN discord_label_role_mappings x ON x.label_id = l.id ORDER BY l.name`);

test("Create labels from roles links 25 roles within the subrequest limit, as linking them one at a time does", async (context) => {
  // Labels 0 to 4 exist and are unlinked; their roles reuse them whatever the capitalization, and the other 20 are created.
  const prepare = async () => { const made = await fixture(context, 5, { linked: false }); made.discord.roles = made.discord.roles.map((role, index) => index >= 2 && index < 7 ? { ...role, name: `test LABEL ${pad(index - 2)}` } : role); return made; };
  const bulk = await prepare(); const roleIds = Array.from({ length: 25 }, (_, index) => roleIdFor(index));
  const imported = await bulk.call(`${base}/from-roles`, { roleIds });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  report("from-roles", 25, imported.usage);
  assert.ok(imported.usage.total <= subrequestBudget, `${imported.usage.total} subrequests: ${imported.queries.join("\n")}`);
  const linked = imported.body.linked as { labelId: string; labelName: string; roleId: string; roleName: string; created: boolean }[];
  assert.equal(imported.body.roleAssignmentsUnchanged, true); assert.equal(linked.length, 25);
  assert.deepEqual(linked.slice(0, 6).map((item) => [item.labelId.startsWith("label-"), item.labelName, item.roleName, item.created]), [[true, "Test Label 00", "test LABEL 00", false], [true, "Test Label 01", "test LABEL 01", false], [true, "Test Label 02", "test LABEL 02", false], [true, "Test Label 03", "test LABEL 03", false], [true, "Test Label 04", "test LABEL 04", false], [false, "Test Role 5", "Test Role 5", true]]);
  assert.equal(bulk.db.count("SELECT COUNT(*) AS n FROM discord_label_role_jobs"), 0, "linking changes nobody's roles");

  const single = await prepare(); const oneAtATime = [];
  for (const roleId of roleIds) { const result = await single.call(`${base}/from-roles`, { roleIds: [roleId] }); assert.equal(result.status, 201, JSON.stringify(result.body)); oneAtATime.push(...result.body.linked); }
  const withoutNewIds = (items: typeof linked) => items.map((item) => ({ ...item, labelId: item.created ? "new" : item.labelId }));
  assert.deepEqual(withoutNewIds(linked), withoutNewIds(oneAtATime));
  assert.deepEqual(linkState(bulk.db), linkState(single.db));
  assert.equal(linkState(bulk.db).filter((row: any) => row.roleId && row.associated === 1 && row.createdBy === "admin").length, 25);

  const small = await prepare();
  const few = await small.call(`${base}/from-roles`, { roleIds: roleIds.slice(3, 6) });
  assert.equal(few.body.linked.length, 3); assert.deepEqual(few.usage, imported.usage);
});

test("Create labels from roles links nothing when any role is refused or a write fails", async (context) => {
  const { db, call, discord } = await fixture(context, 3, { linked: false });
  const roleIds = Array.from({ length: 25 }, (_, index) => roleIdFor(index)); const before = linkState(db);
  const refused = async (pattern: RegExp, status = 409) => { const result = await call(`${base}/from-roles`, { roleIds }); assert.equal(result.status, status, JSON.stringify(result.body)); assert.match(result.body.error, pattern); assert.deepEqual(linkState(db), before); };
  const names = (change: (name: string, index: number) => string) => { discord.roles = discord.roles.map((role, index) => index < 2 ? role : { ...role, name: change(`Test Role ${index - 2}`, index - 2) }); };

  // The last role's label is retired.
  names((name, index) => index === 24 ? "Test Label 02" : name); db.raw.exec(`UPDATE member_labels SET active = 0 WHERE id = '${labelIdFor(2)}'`);
  const retired = linkState(db); before.splice(0, before.length, ...retired);
  await refused(/Restore the retired label Test Label 02/);
  db.raw.exec(`UPDATE member_labels SET active = 1 WHERE id = '${labelIdFor(2)}'`); before.splice(0, before.length, ...linkState(db));
  // Two roles would make the same label.
  names((name, index) => index === 24 ? "test role 7" : name); await refused(/More than one chosen role is named/);
  // The last role is already linked, and so is the label another role would reuse.
  names((name) => name); db.raw.exec(`INSERT INTO discord_label_role_mappings(installation_id,label_id,guild_id,role_id,role_name,created_at) VALUES ('primary','${labelIdFor(0)}','${guildId}','${roleIdFor(24)}','Test Role 24','2026-01-01')`);
  before.splice(0, before.length, ...linkState(db));
  await refused(/Test Role 24 or its label is already linked/);
  names((name, index) => index === 3 ? "Test Label 00" : name);
  const reused = await call(`${base}/from-roles`, { roleIds: roleIds.slice(0, 24) }); assert.equal(reused.status, 409); assert.match(reused.body.error, /Test Label 00 or its label is already linked/); assert.deepEqual(linkState(db), before);
  // A name that cannot be a label.
  names((name, index) => index === 10 ? "x".repeat(81) : name); const long = await call(`${base}/from-roles`, { roleIds: roleIds.slice(0, 24) }); assert.equal(long.status, 400); assert.deepEqual(linkState(db), before);

  // A write that fails for the twentieth role rolls back the nineteen before it.
  names((name) => name); db.raw.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON discord_label_role_mappings WHEN NEW.role_id = '${roleIdFor(19)}' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
  const failed = await call(`${base}/from-roles`, { roleIds: roleIds.slice(0, 24) }); assert.equal(failed.status, 500); assert.deepEqual(linkState(db), before);
  // A label another Admin created in the meantime is reported, and nothing is linked.
  db.raw.exec(`DROP TRIGGER synthetic_failure; CREATE TRIGGER synthetic_race BEFORE INSERT ON discord_label_role_mappings WHEN NEW.role_id = '${roleIdFor(19)}' BEGIN INSERT INTO member_labels(id,installation_id,name,created_at) VALUES ('raced','primary','Test Role 20','2026-01-01'); END`);
  const raced = await call(`${base}/from-roles`, { roleIds: roleIds.slice(0, 24) }); assert.equal(raced.status, 409, JSON.stringify(raced.body)); assert.match(raced.body.error, /nothing was linked/); assert.deepEqual(linkState(db), before);
  db.raw.exec("DROP TRIGGER synthetic_race");
  const linked = await call(`${base}/from-roles`, { roleIds: roleIds.slice(0, 24) }); assert.equal(linked.status, 201, JSON.stringify(linked.body)); assert.equal(linked.body.linked.length, 24);
});
