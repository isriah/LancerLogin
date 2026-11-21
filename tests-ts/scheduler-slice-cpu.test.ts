// Guards each Durable Object slice's CPU on the Workers Free plan (10 ms per invocation, alarms included).
//
// Slice CPU on Cloudflare is mostly the per-call cost of D1 queries and provider requests, not JavaScript: on dev
// (wrangler tail, 2026-11-05, 30 alarm slices) slices with 4-8 D1 queries and no provider request used 3-6 ms, and the
// Discord channel slice with 13 queries and 3 Discord requests used 11-13 ms. Those fit about
//   1.5 ms + 0.45 ms per D1 query + 1.5 ms per provider request,
// plus 3-5 ms more for the first slice after the object wakes. This test holds every steady-state slice to an estimate
// of at most 7 ms, leaving that headroom under 10 ms, and checks the changes that got the channel and housekeeping
// slices there return the same results. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { registeredCoreSchedulerJobs, registeredModuleSchedulerJobs, runSchedulerSlice, type Env } from "../apps/api/src/index.ts";
import { schedulerClass, schedulerRequest, type InFlight, type SliceHooks } from "../apps/api/src/platform-scheduler.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { InstallationSeed, TestD1Database, attendanceWithOutreachDisabled } from "./fixtures/d1-database.ts";
import { sessionSecret } from "./fixtures/worker-fake-database.ts";
import { countingDatabase } from "./fixtures/counting-database.ts";

const jobIds = [...registeredCoreSchedulerJobs, ...registeredModuleSchedulerJobs].map((job) => job.id);
const channelId = "223456789012345678";
/** The estimate fitted to dev's tail; see the header. */
const estimatedCpuMs = (d1: number, provider: number) => 1.5 + 0.45 * d1 + 1.5 * provider;
const steadyBudgetMs = 7;
const hooks = (): SliceHooks & { marked: string[] } => { const marked: string[] = []; return { marked, started: async (job) => { marked.push(job); } }; };

async function installation() {
  const db = new TestD1Database({ seed: new InstallationSeed("2026-09-01T00:00:00Z").users("admin").organization().modules(...attendanceWithOutreachDisabled(true)) });
  const discord = await encryptIntegration({ botToken: "synthetic-bot-token", guildId: "123456789012345678", channelId, publicKey: "a".repeat(64), applicationId: "323456789012345678" }, sessionSecret);
  db.sqlite.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES ('discord-1','primary','discord',?,?,'2026-09-01','2026-09-01')").run(discord.ciphertext, discord.iv);
  db.sqlite.exec("UPDATE installations SET discord_enabled = 1; UPDATE organization_settings SET discord_channel_manager_enabled = 1");
  for (const name of ["Test Kiosk A", "Test Kiosk B"]) {
    db.sqlite.prepare("INSERT INTO pairing_codes(id,installation_id,code_hash,purpose,expires_at,created_by,created_at) VALUES(?,'primary',?,'hardware','2099-01-01','admin','2026-01-01')").run(name, name);
    db.sqlite.prepare("INSERT INTO kiosks(id,installation_id,name,token_hash,pairing_code_id,pairing_bound,created_at,last_seen_at) VALUES(?,'primary',?,?,?,1,'2026-01-01',?)").run(name, name, createHash("sha256").update(name).digest("base64url"), name, new Date().toISOString());
  }
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: db } as unknown as Env;
  return { db, env };
}
function quietJobs(db: TestD1Database, now = Date.now()) {
  const jobs = Object.fromEntries(jobIds.map((id) => [id, { next: now + 3_600_000, last: now - 60_000, outcome: "ok" }]));
  db.sqlite.prepare("INSERT INTO platform_scheduler_state(installation_id,jobs_json,updated_at) VALUES ('primary',?,?) ON CONFLICT(installation_id) DO UPDATE SET jobs_json = excluded.jobs_json").run(JSON.stringify(jobs), new Date(now).toISOString());
}
const jobState = (db: TestD1Database, job: string) => JSON.parse((db.sqlite.prepare("SELECT jobs_json AS j FROM platform_scheduler_state").get() as { j: string }).j)[job];

/** Discord stand-in: managed messages exist and are pinned unless `unpinned` is set; records each request. */
async function withDiscord<T>(work: (requests: string[], discord: { unpinned: boolean }) => Promise<T>): Promise<T> {
  const original = globalThis.fetch; const requests: string[] = []; const discord = { unpinned: false }; let id = 1000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET"; requests.push(`${method} ${url.replace("https://discord.com/api/v10", "")}`);
    if (url.endsWith("/scheduled-events") && method === "GET") return Response.json([]);
    if (/\/commands$/.test(url) && method === "GET") return Response.json([]);
    return Response.json({ id: method === "POST" ? String(++id) : url.split("/").pop(), pinned: !discord.unpinned, content: "synthetic" });
  }) as typeof fetch;
  try { return await work(requests, discord); } finally { globalThis.fetch = original; }
}

/** One five-minute round of a job on the Durable Object: its first slice, then each step it asks for. */
async function round(env: Env, job: string, requests: string[]) {
  const slices: { d1: number; provider: number; requests: string[] }[] = []; let now = Date.now(); let pokes: Record<string, number> = { [job]: now };
  for (let step = 0; step < 8; step += 1) {
    requests.length = 0; const report = await runSchedulerSlice(env, pokes, now, hooks());
    slices.push({ d1: report.d1Queries, provider: report.externalRequests, requests: [...requests] });
    if (!report.more) break; pokes = {}; now = report.nextWake;
  }
  return slices;
}

test("every Core job's steady-state slice stays within an estimated 7 ms of Free-plan CPU", async (t) => {
  const { db, env } = await installation();
  await withDiscord(async (requests) => {
    const table: Record<string, unknown>[] = [];
    for (const job of jobIds) {
      quietJobs(db); await round(env, job, requests); // the first round posts the managed messages
      quietJobs(db); const slices = await round(env, job, requests);
      slices.forEach((slice, index) => {
        const estimate = estimatedCpuMs(slice.d1, slice.provider);
        table.push({ job, step: index + 1, d1: slice.d1, provider: slice.provider, estimate });
        assert.ok(estimate <= steadyBudgetMs, `${job} step ${index + 1}: ${slice.d1} D1 queries and ${slice.provider} provider requests estimate ${estimate.toFixed(1)} ms`);
        assert.ok(slice.provider <= 1, `${job} step ${index + 1} makes at most one provider request: ${slice.requests.join(", ")}`);
      });
    }
    t.diagnostic(JSON.stringify(table));
  });
});

test("the channel manager is two slices, one Discord request each, and still re-pins and re-posts as before", async () => {
  const { db, env } = await installation();
  await withDiscord(async (requests, discord) => {
    quietJobs(db); const first = await round(env, "attendance.discord-channel", requests);
    assert.equal(first.length, 2, "kiosk status, then the help message");
    assert.deepEqual(first.map((slice) => slice.requests.map((line) => line.split(" ")[0])), [["POST", "PUT"], ["POST"]], "the first round posts and pins the status and posts the help message");
    const recorded = db.sqlite.prepare("SELECT state_key, external_id, updated_at FROM integration_state WHERE provider = 'discord' ORDER BY state_key").all();
    quietJobs(db); const steady = await round(env, "attendance.discord-channel", requests);
    assert.deepEqual(steady.map((slice) => slice.requests), [[], []], "an unchanged message checked within the hour costs no Discord request");
    assert.deepEqual(db.sqlite.prepare("SELECT state_key, external_id, updated_at FROM integration_state WHERE provider = 'discord' ORDER BY state_key").all(), recorded, "nothing is rewritten when nothing changed");
    // An hour after the last check each message is checked against Discord once, and the check's time is recorded.
    const hourAgo = new Date(Date.now() - 61 * 60_000).toISOString(); const aged = () => db.sqlite.prepare("UPDATE integration_state SET updated_at = ? WHERE provider = 'discord'").run(hourAgo);
    aged(); quietJobs(db); const refreshed = await round(env, "attendance.discord-channel", requests);
    assert.deepEqual(refreshed.map((slice) => slice.requests), [[`GET /channels/${channelId}/messages/1001`], [`GET /channels/${channelId}/messages/1002`]], "an unchanged, still-pinned message is only checked");
    assert.ok((db.sqlite.prepare("SELECT MIN(updated_at) AS at FROM integration_state WHERE provider = 'discord'").get() as { at: string }).at > hourAgo, "the check is recorded, so the next one waits an hour");
    quietJobs(db); assert.deepEqual((await round(env, "attendance.discord-channel", requests)).map((slice) => slice.requests), [[], []]);
    // Someone unpinned the status message: the next hourly check pins it again.
    discord.unpinned = true; aged(); quietJobs(db); const repinned = await round(env, "attendance.discord-channel", requests);
    assert.deepEqual(repinned[0]!.requests, [`GET /channels/${channelId}/messages/1001`, `PUT /channels/${channelId}/messages/pins/1001`]);
    // A kiosk change edits the status message in place.
    discord.unpinned = false; db.sqlite.exec("UPDATE kiosks SET last_seen_at = '2026-01-01T00:00:00Z' WHERE name = 'Test Kiosk B'");
    quietJobs(db); const edited = await round(env, "attendance.discord-channel", requests);
    assert.deepEqual(edited[0]!.requests.map((line) => line.split(" ")[0]), ["PATCH", "PUT"]);
    assert.equal(jobState(db, "attendance.discord-channel").cursor, undefined, "a finished round leaves no step behind");
  });
  // Outside a Durable Object slice (the cron fallback, or the settings page), both messages are handled in one call.
  db.sqlite.exec("DELETE FROM integration_state");
  await withDiscord(async (requests) => {
    quietJobs(db); db.sqlite.exec("UPDATE platform_scheduler_state SET jobs_json = json_set(jobs_json, '$.\"attendance.discord-channel\".next', 0)");
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() } as never, env);
    assert.equal(requests.filter((line) => line.startsWith("POST /channels")).length, 2);
  });
});

test("housekeeping runs reconcile, prune and cleanup as three small slices on the Durable Object and in one cron pass", async () => {
  const { db, env } = await installation();
  db.sqlite.prepare("INSERT INTO auth_rate_limits(bucket, window_start_ms, attempts) VALUES ('synthetic', 0, 1)").run();
  quietJobs(db); const slices = await round(env, "core.housekeeping", []);
  assert.equal(slices.length, 3);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_rate_limits").get() as { n: number }).n, 0, "the prune step ran");
  assert.equal(jobState(db, "core.housekeeping").cursor, undefined);
  assert.ok(jobState(db, "core.housekeeping").next > Date.now() + 200_000, "after the last step the job waits its interval");
  db.sqlite.prepare("INSERT INTO auth_rate_limits(bucket, window_start_ms, attempts) VALUES ('synthetic', 0, 1)").run();
  quietJobs(db); db.sqlite.exec("UPDATE platform_scheduler_state SET jobs_json = json_set(jobs_json, '$.\"core.housekeeping\".next', 0)");
  await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() } as never, env);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_rate_limits").get() as { n: number }).n, 0, "one cron pass ran every step");
});

test("the label job's slice calls Discord for nothing while every two-way label waits on a role sync", async () => {
  const { db, env } = await installation();
  for (const [index, label] of ["Test Label A", "Test Label B", "Test Label C"].entries()) {
    const id = `label-${index}`; const roleId = String(700000000000000000n + BigInt(index));
    db.sqlite.prepare("INSERT INTO member_labels(id,installation_id,name,created_at) VALUES (?,'primary',?,'2026-01-01')").run(id, label);
    db.sqlite.prepare("INSERT INTO discord_label_role_mappings(installation_id,label_id,guild_id,role_id,role_name,created_at,sync_direction) VALUES ('primary',?,'123456789012345678',?,?,'2026-01-01','two_way')").run(id, roleId, label);
    // Each label's queued role changes wait out a Discord rate limit.
    db.sqlite.prepare("INSERT INTO discord_label_role_jobs(id,installation_id,label_id,guild_id,role_id,status,source_fingerprint,next_attempt_at,created_at,updated_at) VALUES (?,'primary',?,'123456789012345678',?,'pending','synthetic','2999-01-01T00:00:00.000Z','2026-01-01','2026-01-01')").run(`job-${index}`, id, roleId);
  }
  await withDiscord(async (requests) => {
    quietJobs(db); const slices = await round(env, "attendance.discord-label-roles", requests);
    assert.equal(slices.length, 1);
    assert.deepEqual(slices[0]!.requests, [], "no role check and no member list while every label is syncing");
    assert.ok(estimatedCpuMs(slices[0]!.d1, slices[0]!.provider) <= steadyBudgetMs, JSON.stringify(slices[0]));
  });
});

test("a Durable Object slice records its job in the object's storage, not with a D1 write", async () => {
  const { db, env } = await installation(); quietJobs(db);
  const marks = hooks(); let writes = 0;
  const counted = { prepare: (sql: string) => { if (/^\s*INSERT INTO platform_scheduler_state/.test(sql)) writes += 1; return db.prepare(sql); }, batch: (statements: never[]) => db.batch(statements) };
  await runSchedulerSlice({ ...env, DB: counted } as unknown as Env, { "core.discord-commands": Date.now() }, undefined, marks);
  assert.deepEqual(marks.marked, ["core.discord-commands"]);
  assert.equal(writes, 1, "only the outcome is written to D1");
});

test("a slice stopped once, as a deploy resetting the object does, runs its job again and does not show it as failed", async () => {
  const { db, env } = await installation(); quietJobs(db);
  const crashed: InFlight = { job: "attendance.discord-channel", at: Date.now() - 2_000, count: 1 };
  await withDiscord(async () => {
    const report = await runSchedulerSlice(env, { "attendance.discord-channel": Date.now() - 3_000 }, undefined, { ...hooks(), crashed });
    assert.deepEqual(report.attempted, ["attendance.discord-channel"], "the job is still due and runs in the next slice");
  });
  assert.equal(jobState(db, "attendance.discord-channel").outcome, "ok");
});

test("a job whose slice the platform stopped twice in a row is marked failed and the next slice moves on to other work", async () => {
  const { db, env } = await installation(); quietJobs(db);
  const crashed: InFlight = { job: "attendance.discord-channel", at: Date.now() - 2_000, count: 2 };
  const report = await runSchedulerSlice(env, { "attendance.discord-channel": Date.now() - 3_000, "core.discord-commands": Date.now() }, undefined, { ...hooks(), crashed });
  assert.deepEqual(report.attempted, ["core.discord-commands"], "the stopped job is not retried straight away");
  const state = jobState(db, "attendance.discord-channel");
  assert.equal(state.outcome, "failed"); assert.equal(state.last, crashed.at); assert.ok(state.next > Date.now() + 200_000);
});

test("the Durable Object hands a stopped slice's job to the next alarm and clears it after a finished one", async () => {
  const stored = new Map<string, unknown>(); let alarm: number | null = null;
  const storage = { get: async <T>(key: string) => stored.get(key) as T | undefined, put: async (key: string, value: unknown) => { stored.set(key, value); }, delete: async (key: string) => stored.delete(key), getAlarm: async () => alarm, setAlarm: async (time: number) => { alarm = time; }, deleteAlarm: async () => { alarm = null; } };
  const seen: (InFlight | undefined)[] = []; let stop = true;
  const Scheduler = schedulerClass([{ id: "fixture.heavy", interval: 300_000, run: async () => undefined }, { id: "fixture.light", interval: 300_000, run: async () => undefined }], async (_env, _pokes, hooks) => {
    seen.push(hooks.crashed);
    await hooks.started(stop ? "fixture.heavy" : "fixture.light");
    // The platform stopping a slice at its CPU limit: the handler never finishes.
    if (stop) { stop = false; return new Promise<never>(() => undefined); }
    return { ran: "fixture.light", nextWake: Date.now() + 300_000 };
  });
  void new Scheduler({ storage }, {}).alarm();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await new Scheduler({ storage }, {}).alarm(); // a new instance, as after the platform resets the object
  assert.equal(seen[1]?.job, "fixture.heavy"); assert.equal(seen[1]?.count, 1, "the first stop on this job");
  assert.equal(stored.has("inflight"), false, "a finished slice clears the marker");
  assert.equal((await (await new Scheduler({ storage }, {}).fetch(schedulerRequest("status"))).json() as { alarm: number }).alarm, alarm);
});

// ---- The kiosk status message is the channel job's work, not the heartbeat's (database-access audit, 2026-11-20) ----

const heartbeat = (env: Env, kiosk: string, body: Record<string, unknown> = {}, context?: { waitUntil(promise: Promise<unknown>): void }) => worker.fetch(new Request("https://api.example.test/kiosk/heartbeat", { method: "POST", headers: { authorization: `Bearer ${kiosk}`, "content-type": "application/json" }, body: JSON.stringify({ readerOnline: true, releaseVersion: "2.1.0-beta.11", pendingEvents: 0, ...body }) }), env, context as never);

test("a heartbeat that changes nothing costs the same D1 queries with Discord configured as without, and asks Discord nothing", async () => {
  // The same installation twice: once with Discord verified and the channel manager on, once with no Discord at all.
  const configured = await installation(); const bare = await installation();
  bare.db.sqlite.exec("DELETE FROM encrypted_integrations; UPDATE installations SET discord_enabled = 0; UPDATE organization_settings SET discord_channel_manager_enabled = 0");
  const cost = async ({ db, env }: Awaited<ReturnType<typeof installation>>) => {
    const counted = countingDatabase(db); const countedEnv = { ...env, DB: counted } as Env;
    // The first heartbeat records the reader and release; the second changes nothing a status message shows.
    assert.equal((await heartbeat(countedEnv, "Test Kiosk A")).status, 200);
    const before = counted.queries.length;
    assert.equal((await heartbeat(countedEnv, "Test Kiosk A")).status, 200);
    return counted.queries.slice(before);
  };
  await withDiscord(async (requests) => {
    const without = await cost(bare); const withDiscordConfigured = await cost(configured);
    assert.equal(withDiscordConfigured.length, without.length, `with Discord: ${withDiscordConfigured.length} queries; without: ${without.length}`);
    for (const table of ["encrypted_integrations", "integration_state", "platform_scheduler_state", "organization_settings"]) assert.equal(withDiscordConfigured.some((sql) => sql.includes(table)), false, `a heartbeat does not read ${table}`);
    assert.equal(withDiscordConfigured.filter((sql) => /FROM kiosks\b/.test(sql)).length, 1, "the kiosk's row is read once, to authenticate it");
    assert.deepEqual(requests, [], "and no request goes to Discord");
  });
});

test("a heartbeat pokes the channel job only when it changes what the status message shows for that kiosk", async () => {
  const { db, env } = await installation();
  const pokes: string[][] = [];
  const durable = { ...env, PLATFORM_SCHEDULER: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => { pokes.push(((await request.json()) as { jobs: string[] }).jobs); return Response.json({ alarm: 1 }); } }) } } as unknown as Env;
  const beat = async (body: Record<string, unknown> = {}) => { const waiting: Promise<unknown>[] = []; assert.equal((await heartbeat(durable, "Test Kiosk A", body, { waitUntil: (promise) => { waiting.push(promise); } })).status, 200); await Promise.all(waiting); };
  await withDiscord(async (requests) => {
    await beat(); assert.deepEqual(pokes, [["attendance.discord-channel"]], "its reader and release are reported for the first time");
    await beat(); await beat(); assert.equal(pokes.length, 1, "unchanged heartbeats poke nothing");
    await beat({ readerOnline: false }); assert.equal(pokes.length, 2, "the reader went offline");
    await beat({ readerOnline: false }); assert.equal(pokes.length, 2);
    await beat({ readerOnline: false, releaseVersion: "2.1.0-beta.12" }); assert.equal(pokes.length, 3, "a new release");
    // Silent for longer than the two minutes a kiosk counts as online: its next heartbeat brings it back.
    db.sqlite.prepare("UPDATE kiosks SET last_seen_at = ? WHERE name = 'Test Kiosk A'").run(new Date(Date.now() - 3 * 60_000).toISOString());
    await beat({ readerOnline: false, releaseVersion: "2.1.0-beta.12" }); assert.equal(pokes.length, 4, "it came back online");
    assert.deepEqual(requests, [], "the heartbeats themselves never call Discord");
  });
  // On the cron fallback there is nothing to poke; the channel job's five-minute run picks the change up.
  await withDiscord(async (requests) => { assert.equal((await heartbeat(env, "Test Kiosk B", { readerOnline: false })).status, 200); assert.deepEqual(requests, []); });
});

test("two passes that both find the kiosk status message missing post it once", async () => {
  for (const pinned of [0, 1]) {
    const { db, env } = await installation(); db.sqlite.prepare("UPDATE organization_settings SET discord_channel_manager_enabled = ?").run(pinned);
    const original = globalThis.fetch; const requests: string[] = []; let id = 2000;
    // Discord answers after a pause, so the second pass reads the tracking row before the first has saved the message.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET"; requests.push(`${method} ${String(input).replace("https://discord.com/api/v10", "")}`);
      await new Promise((resolve) => setImmediate(resolve));
      return Response.json({ id: method === "POST" ? String(++id) : String(input).split("/").pop(), pinned: true });
    }) as typeof fetch;
    try {
      quietJobs(db); const now = Date.now(); const pokes = { "attendance.discord-channel": now };
      await Promise.all([runSchedulerSlice(env, pokes, now, hooks()), runSchedulerSlice(env, pokes, now, hooks())]);
    } finally { globalThis.fetch = original; }
    assert.equal(requests.filter((line) => line === `POST /channels/${channelId}/messages`).length, 1, `${pinned ? "pinned" : "unpinned"}: ${JSON.stringify(requests)}`);
    const tracked = db.sqlite.prepare("SELECT state_key AS stateKey, external_id AS externalId FROM integration_state WHERE provider = 'discord' AND state_key LIKE 'kiosk-status%'").all().map((row) => ({ ...row }));
    assert.deepEqual(tracked, [{ stateKey: "kiosk-status", externalId: "2001" }], "one message is tracked and the claim is released");
  }
});

test("the kiosk status message follows a kiosk going silent at the channel job's next run, and an unchanged status asks Discord nothing", async () => {
  const { db, env } = await installation(); db.sqlite.exec("UPDATE organization_settings SET discord_channel_manager_enabled = 0");
  await withDiscord(async (requests) => {
    quietJobs(db); await round(env, "attendance.discord-channel", requests);
    assert.deepEqual(requests, [`POST /channels/${channelId}/messages`], "the first run posts the message");
    quietJobs(db); const steady = await round(env, "attendance.discord-channel", requests);
    assert.deepEqual(steady.map((slice) => slice.requests), [[]], "nothing changed: no request, where every run used to check the message");
    assert.ok(steady[0]!.d1 <= 6, `and ${steady[0]!.d1} D1 queries`);
    // Kiosk B stops sending heartbeats. No heartbeat reports that, so the job's own run is what notices.
    db.sqlite.prepare("UPDATE kiosks SET last_seen_at = ? WHERE name = 'Test Kiosk B'").run(new Date(Date.now() - 3 * 60_000).toISOString());
    quietJobs(db); const silent = await round(env, "attendance.discord-channel", requests);
    assert.deepEqual(silent[0]!.requests, [`PATCH /channels/${channelId}/messages/1001`]);
  });
});
