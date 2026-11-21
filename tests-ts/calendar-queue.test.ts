// quick-check: covers apps/api/migrations/**
// Meeting changes queue their Google Calendar and Discord event work in the same D1 batch as the change, and the
// scheduled calendar jobs deliver it (apps/api/src/calendar-queue.ts). On a real migrated SQLite database with synthetic
// Google and Discord servers, every meeting route must cost a small, fixed number of subrequests (each D1 query, each
// db.batch and each outbound request counts as one against the Workers Free limit of 50) whatever the number of
// meetings and whichever integrations are set up; a failed batch must leave neither the meeting change nor queued
// work; superseded operations must collapse; and the scheduler must then deliver what was queued. Synthetic data only:
// no request leaves the process.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { runSchedulerSlice } from "../apps/api/src/index.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { pruneStaleRows } from "../apps/api/src/stale-row-pruning.ts";
import { calendarFailedRetry } from "../apps/api/src/calendar-queue.ts";
import { SchedulerBudgetError } from "../apps/api/src/scheduler-budget.ts";
import { BackupDatabase, backupSeed, sessionSecret } from "./fixtures/backup-database.ts";
import { TestD1Database, coreMigrationDirectory, readCoreMigrations } from "./fixtures/d1-database.ts";
import { countingDatabase } from "./fixtures/report-query-budget.ts";

/** Well under the 50 the plan allows, so the scheduler poke and anything else in the invocation has room. */
const routeBudget = 15;
const origin = "https://dashboard.example.test";
const guildId = "123456789012345678";
const day = 86_400_000;
type Integrations = { google?: boolean; discord?: boolean };
const integrationStates: Record<string, Integrations> = { none: {}, google: { google: true }, discord: { discord: true }, both: { google: true, discord: true } };
type Summary = { synced: number; queued: number; failed: number; skipped?: number };
type Delivery = { google_calendar: Summary; discord: Summary };

async function fixture(context: TestContext, integrations: Integrations, database: TestD1Database = new BackupDatabase()) {
  const db = database; context.after(() => db.close());
  if (integrations.google) {
    const secret = await encryptIntegration({ clientId: "test-calendar-client", clientSecret: "test-calendar-secret", refreshToken: "test-refresh", calendarId: "test-calendar@example.test", calendarLabel: "Test Calendar A" }, sessionSecret);
    db.sqlite.prepare("INSERT INTO google_calendar_authorizations(installation_id,ciphertext,iv,authorized_at,verified_at,updated_at) VALUES('primary',?,?,'2026-01-01','2026-01-01','2026-01-01')").run(secret.ciphertext, secret.iv);
    db.sqlite.exec("UPDATE installations SET google_calendar_enabled = 1");
  }
  if (integrations.discord) {
    const secret = await encryptIntegration({ botToken: "test-bot-token", guildId, channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
    db.sqlite.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, verified_at, updated_at) VALUES ('discord-1', 'primary', 'discord', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(secret.ciphertext, secret.iv);
    db.sqlite.exec("UPDATE installations SET discord_enabled = 1");
  }
  // Synthetic Google Calendar and Discord: events by id, and every calendar request made.
  const remote = { google: new Map<string, { summary: string }>(), discord: new Map<string, { name: string }>(), discordLocations: new Map<string, string>(), requests: [] as string[], total: 0, discordIds: 0 };
  const originalFetch = globalThis.fetch; context.after(() => { globalThis.fetch = originalFetch; });
  // A cron pass logs the jobs its budget deferred; the passes here are only a means of delivery.
  const originalLog = console.log; console.log = () => {}; context.after(() => { console.log = originalLog; });
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input); const method = (init?.method ?? "GET").toUpperCase(); remote.total += 1;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, any> : {};
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "test-access-token", expires_in: 3600 });
    const google = /googleapis\.com\/calendar\/v3\/calendars\/[^/]+\/events(?:\/([^/?]+))?/.exec(url);
    if (google) {
      const id = google[1] ? decodeURIComponent(google[1]) : String(body.id); remote.requests.push(`google ${method} ${id}`);
      if (method === "POST") { if (remote.google.has(id)) return Response.json({ error: { code: 409 } }, { status: 409 }); remote.google.set(id, { summary: body.summary }); return Response.json({ id }); }
      if (!remote.google.has(id)) return Response.json({ error: { code: 404, message: "Not Found" } }, { status: 404 });
      if (method === "DELETE") { remote.google.delete(id); return new Response(null, { status: 204 }); }
      remote.google.set(id, { summary: body.summary }); return Response.json({ id });
    }
    const discord = new RegExp(`discord\\.com/api/v10/guilds/${guildId}/scheduled-events(?:/(\\d+))?`).exec(url);
    if (discord) {
      remote.requests.push(`discord ${method} ${discord[1] ?? ""}`.trim());
      if (!discord[1] && method === "GET") return Response.json([...remote.discord].map(([id, event]) => ({ id, ...event, entity_metadata: { location: remote.discordLocations.get(id) } })));
      if (!discord[1]) { const id = String(900000000000000000n + BigInt(remote.discordIds += 1)); remote.discord.set(id, { name: body.name }); remote.discordLocations.set(id, body.entity_metadata?.location); return Response.json({ id }); }
      if (!remote.discord.has(discord[1])) return Response.json({ message: "Unknown Guild Scheduled Event", code: 10070 }, { status: 404 });
      if (method === "DELETE") { remote.discord.delete(discord[1]); return new Response(null, { status: 204 }); }
      remote.discord.set(discord[1], { name: body.name }); return Response.json({ id: discord[1] });
    }
    // Other scheduled jobs (commands, channel upkeep) talk to Discord too; they are not under test.
    if (url.startsWith("https://discord.com/api/v10/")) return method === "GET" ? Response.json([]) : Response.json({ id: "999999999999999999" });
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  const counted = countingDatabase(db);
  // Every statement the Worker prepares, whole, for checking query plans.
  const prepared: string[] = []; const recorded = { prepare: (sql: string) => { prepared.push(sql); return counted.database.prepare(sql); }, batch: counted.database.batch };
  const env = { DB: recorded, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: origin };
  const cookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" })}`;
  // An isolate reconciles its modules on its first request; serve that before anything is measured.
  await worker.fetch(new Request("https://api.example.test/health"), env);
  /** One request, with what it cost: D1 queries (a batch counts once) plus outbound requests. */
  async function request<T = Record<string, any>>(method: string, path: string, body?: unknown, expected = 200) {
    const before = remote.total; counted.start();
    const response = await worker.fetch(new Request(`https://api.example.test${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const log = counted.stop(); const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    return { body: JSON.parse(text) as T, subrequests: log.length + remote.total - before, outbound: remote.total - before, log };
  }
  /** Cron passes until no calendar work is due (each pass delivers a few operations within its budget). */
  async function deliver() {
    const due = () => Number((db.sqlite.prepare("SELECT (SELECT COUNT(*) FROM google_calendar_operations WHERE status != 'delivered' AND next_attempt_at <= ?) + (SELECT COUNT(*) FROM discord_calendar_operations WHERE status != 'delivered' AND next_attempt_at <= ?) + (SELECT COUNT(*) FROM calendar_event_removals WHERE next_attempt_at <= ?) AS n").get(new Date().toISOString(), new Date().toISOString(), new Date().toISOString()) as { n: number }).n);
    for (let pass = 0; pass < 150 && due() > 0; pass += 1) {
      // Every job is due again once the scheduler's state is cleared; each slot starts with a different job.
      db.sqlite.exec("DELETE FROM platform_scheduler_state");
      await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: pass * 300_000 } as never, env as never);
    }
    assert.equal(due(), 0, "the scheduler delivers everything that is due");
  }
  const rows = <T = Record<string, any>>(sql: string, ...values: unknown[]) => db.sqlite.prepare(sql).all(...values as never[]).map((row) => ({ ...row })) as T[];
  const count = (sql: string, ...values: unknown[]) => Number((db.sqlite.prepare(sql).get(...values as never[]) as { n: number }).n);
  return { db, remote, counted, prepared, env, request, deliver, rows, count };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// Meeting times count from the minute the file loads, so how many fall within Discord's 60-day horizon never depends on the time of day.
const base = Math.floor(Date.now() / 60_000) * 60_000;
const startOf = (index: number, hour = 0) => new Date(base + (index + 1) * day + hour * 3_600_000);
const meetingBody = (index: number, title = `Test Meeting ${index}`) => ({ title, startsAt: startOf(index).toISOString(), endsAt: new Date(startOf(index).getTime() + 2 * 3_600_000).toISOString() });
/** Synthetic meetings written straight to the database, a day apart, starting `offset` days out. */
function seedMeetings(app: Fixture, total: number, offset = 0, prefix = "seed") {
  const insert = app.db.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES(?,'primary',?,?,?,1,'admin','2026-01-01')");
  const ids = Array.from({ length: total }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}`);
  ids.forEach((id, index) => insert.run(id, `Test Meeting ${id}`, startOf(offset + index, 5).toISOString(), new Date(startOf(offset + index, 5).getTime() + 3_600_000).toISOString()));
  return ids;
}
const weekly = (occurrences: number, firstIndex: number) => ({ ...meetingBody(firstIndex, "Test Weekly Series"), recurrence: { frequency: "weekly", until: new Date(startOf(firstIndex).getTime() + (occurrences - 1) * 7 * day + 3_600_000).toISOString() } });

for (const [state, integrations] of Object.entries(integrationStates)) {
  test(`meeting routes cost the same for one meeting and for many (${state})`, async (context) => {
    const app = await fixture(context, integrations); const costs: Record<string, number> = {};
    const measured = async (name: string, run: () => Promise<{ subrequests: number; outbound: number; body: any }>) => {
      const result = await run(); assert.equal(result.outbound, 0, `${name} sends nothing to a calendar itself`);
      assert.ok(result.subrequests <= routeBudget, `${name} costs ${result.subrequests} subrequests`);
      return result;
    };
    const same = (name: string, one: number, many: number) => { assert.equal(many, one, `${name}: ${many} subrequests for many, ${one} for one`); costs[name] = one; };
    const expectQueued = (delivery: Delivery, google: number, discord: number, name: string) => {
      assert.deepEqual([delivery.google_calendar.queued, delivery.discord.queued], [integrations.google ? google : 0, integrations.discord ? discord : 0], name);
      assert.deepEqual([delivery.google_calendar.synced, delivery.google_calendar.failed, delivery.discord.synced, delivery.discord.failed], [0, 0, 0, 0], `${name} reports nothing as delivered`);
    };

    // Create: one meeting, then a 20-occurrence weekly series.
    const single = await measured("create one", () => app.request("POST", "/meetings", meetingBody(0), 201));
    const series = await measured("create a series", () => app.request("POST", "/meetings", weekly(20, 3), 201));
    assert.equal(series.body.meetings.length, 20); same("POST /meetings", single.subrequests, series.subrequests);
    expectQueued(single.body.calendarDelivery, 1, 1, "create one"); expectQueued(series.body.calendarDelivery, 20, 20, "create a series");
    assert.deepEqual(single.body.calendarSync, single.body.calendarDelivery.google_calendar, "calendarSync is still the Google summary");
    const seriesIds = series.body.meetings.map((meeting: { id: string }) => meeting.id) as string[];
    // 9 of the 20 start within Discord's 60-day horizon; the others are queued but fall due later.
    if (integrations.discord) assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE next_attempt_at <= ?", new Date().toISOString()), 10, "only meetings within 60 days are due for Discord");

    // Edit one meeting, and a whole series from its first occurrence and from its nineteenth.
    const meetingId = single.body.meeting.id as string;
    const patched = await measured("patch one", () => app.request("PATCH", `/meetings/${meetingId}`, { ...meetingBody(0, "Test Meeting renamed"), endsAt: new Date(startOf(0).getTime() + 3 * 3_600_000).toISOString() }));
    costs["PATCH /meetings/:id"] = patched.subrequests; expectQueued(patched.body.calendarDelivery, 1, 1, "patch one");
    const seriesId = series.body.seriesId as string; const shifted = (index: number) => ({ title: "Test Weekly Series moved", startsAt: new Date(startOf(3).getTime() + index * 7 * day + 1_800_000).toISOString(), endsAt: new Date(startOf(3).getTime() + index * 7 * day + 9_000_000).toISOString() });
    const lastTwo = await measured("patch two occurrences", () => app.request("PATCH", `/meeting-series/${seriesId}`, { ...shifted(18), meetingId: seriesIds[18] }));
    const whole = await measured("patch a series", () => app.request("PATCH", `/meeting-series/${seriesId}`, { ...shifted(0), title: "Test Weekly Series", meetingId: seriesIds[0] }));
    assert.deepEqual([lastTwo.body.updated, whole.body.updated], [2, 20]); same("PATCH /meeting-series/:id", lastTwo.subrequests, whole.subrequests);
    expectQueued(whole.body.calendarDelivery, 20, 20, "patch a series");

    // Delete one, then this and future occurrences; restore each with the deletion the server returned.
    const deletedOne = await measured("delete one", () => app.request("DELETE", `/meetings/${meetingId}`, { scope: "occurrence" }));
    costs["DELETE /meetings/:id"] = deletedOne.subrequests;
    const deletedSeries = await measured("delete a series", () => app.request("DELETE", `/meetings/${seriesIds[0]}`, { scope: "future" }));
    assert.equal(deletedSeries.body.deleted, 20); same("DELETE /meetings/:id (series)", deletedOne.subrequests, deletedSeries.subrequests);
    // Nothing was delivered yet, so Discord has no event to delete; Google's pending upserts become deletes.
    expectQueued(deletedSeries.body.calendarDelivery, 20, 0, "delete a series");
    const restoredOne = await measured("restore one", () => app.request("POST", `/meetings/${meetingId}/restore`, { scope: "occurrence", deletion: deletedOne.body.deletion }));
    const restoredSeries = await measured("restore a series", () => app.request("POST", `/meetings/${seriesIds[0]}/restore`, { scope: "future", deletion: deletedSeries.body.deletion }));
    assert.equal(restoredSeries.body.restored, 20); same("POST /meetings/:id/restore", restoredOne.subrequests, restoredSeries.subrequests);
    expectQueued(restoredSeries.body.calendarDelivery, 20, 20, "restore a series");
    if (integrations.google) assert.equal(app.count("SELECT COUNT(*) AS n FROM google_calendar_event_mappings WHERE active = 1 AND generation = 2"), 21, "every restored Google mapping is active again, on a new generation");

    // Bulk delete: one selected meeting, then a hundred.
    const hundred = seedMeetings(app, 100, 200);
    const sync = await app.request("POST", "/calendars/sync", { meetingId: hundred[0] }, integrations.google || integrations.discord ? 200 : 409);
    if (integrations.google || integrations.discord) { assert.ok(sync.subrequests <= routeBudget && sync.outbound === 0, `Sync now costs ${sync.subrequests}`); costs["POST /calendars/sync"] = sync.subrequests; assert.deepEqual(sync.body.providers.map((provider: Summary & { provider: string }) => [provider.provider, provider.synced, provider.queued]), [...(integrations.google ? [["google_calendar", 0, 1]] : []), ...(integrations.discord ? [["discord", 0, 1]] : [])]); }
    const bulkOne = await measured("bulk delete one", () => app.request("POST", "/meetings/bulk-delete", { meetingIds: [meetingId], confirmation: "DELETE SELECTED MEETINGS" }));
    const bulkMany = await measured("bulk delete 100", () => app.request("POST", "/meetings/bulk-delete", { meetingIds: hundred, confirmation: "DELETE SELECTED MEETINGS" }));
    assert.equal(bulkMany.body.deleted, 100); assert.deepEqual(bulkMany.body.deletion.meetingIds, hundred); same("POST /meetings/bulk-delete", bulkOne.subrequests, bulkMany.subrequests);
    context.diagnostic(`${state}: ${JSON.stringify(costs)}`);
    // The same statements run whatever is set up, so the cost does not depend on the integrations.
    assert.deepEqual(costs, { "POST /meetings": 7, "PATCH /meetings/:id": 9, "PATCH /meeting-series/:id": 10, "DELETE /meetings/:id": 6, "DELETE /meetings/:id (series)": 6, "POST /meetings/:id/restore": 5, ...(integrations.google || integrations.discord ? { "POST /calendars/sync": 6 } : {}), "POST /meetings/bulk-delete": 5 });
  });
}

test("editing a meeting with a live absence notice and both calendars stays far inside the limit and keeps its calendar update", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  // A meeting that ended an hour ago, with a delivered notice of two messages and synced events on both calendars.
  const start = new Date(Date.now() - 3 * 3_600_000).toISOString(); const end = new Date(Date.now() - 3_600_000).toISOString();
  app.db.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES('test-ended','primary','Test Meeting ended',?,?,1,'admin','2026-01-01')").run(start, end);
  app.db.sqlite.exec(`INSERT INTO google_calendar_event_mappings(installation_id,meeting_id,event_id,generation,active,synced_at,updated_at) VALUES('primary','test-ended','lltestended',1,1,'2026-01-02','2026-01-02');
    INSERT INTO discord_calendar_event_mappings(installation_id,meeting_id,event_id,generation,active,synced_at,updated_at) VALUES('primary','test-ended','900000000000000777',1,1,'2026-01-02','2026-01-02');
    INSERT INTO discord_attendance_notifications(installation_id,meeting_id,status,message_id,attempts,processed_at,updated_at,channel_id,delivery_id) VALUES('primary','test-ended','delivered','800000000000000001',1,'${end}','${end}','223456789012345678','test-delivery');
    INSERT INTO discord_attendance_recipients(installation_id,meeting_id,member_id,discord_user_id,message_id,delivered_at,delivery_id) VALUES('primary','test-ended','member','700000000000000001','800000000000000002','${end}','test-delivery');`);
  const edited = await app.request("PATCH", "/meetings/test-ended", { title: "Test Meeting ended", startsAt: start, endsAt: new Date(Date.parse(end) + 60_000).toISOString() });
  context.diagnostic(`PATCH with a notice and both calendars: ${edited.subrequests} subrequests, ${edited.outbound} to Discord`);
  assert.ok(edited.subrequests <= 25, `the edit costs ${edited.subrequests} subrequests`);
  assert.deepEqual(edited.body.discordNotices, [{ meetingId: "test-ended", outcome: "retracted" }]);
  // The calendar update committed with the edit, before the notice was withdrawn. The meeting has ended, so Discord gets no update: its event is deleted.
  assert.deepEqual(edited.body.calendarDelivery.google_calendar, { synced: 0, queued: 1, failed: 0 });
  assert.deepEqual(app.rows("SELECT action, status, ends_at AS endsAt FROM google_calendar_operations"), [{ action: "upsert", status: "pending", endsAt: new Date(Date.parse(end) + 60_000).toISOString() }]);
  assert.equal(edited.body.calendarDelivery.discord.queued, 1); assert.deepEqual(app.rows("SELECT action, status, event_id AS eventId FROM discord_calendar_operations"), [{ action: "delete", status: "pending", eventId: "900000000000000777" }]);
});

test("a meeting change and its calendar work commit together or not at all", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  const created = await app.request("POST", "/meetings", meetingBody(0), 201); const meetingId = created.body.meeting.id as string;
  const snapshot = () => JSON.stringify(["meetings", "google_calendar_event_mappings", "google_calendar_operations", "discord_calendar_event_mappings", "discord_calendar_operations"].map((table) => app.rows(`SELECT * FROM ${table} ORDER BY rowid`)));
  const before = snapshot();
  // The last calendar statement of every batch fails: a Discord operation cannot be written.
  app.db.sqlite.exec("CREATE TRIGGER test_refuse_discord_insert BEFORE INSERT ON discord_calendar_operations BEGIN SELECT RAISE(ABORT, 'synthetic calendar queue failure'); END; CREATE TRIGGER test_refuse_discord_update BEFORE UPDATE ON discord_calendar_event_mappings BEGIN SELECT RAISE(ABORT, 'synthetic calendar queue failure'); END;");
  context.mock.method(console, "error", () => {});
  await app.request("POST", "/meetings", meetingBody(1), 500);
  await app.request("POST", "/meetings", weekly(5, 10), 500);
  await app.request("PATCH", `/meetings/${meetingId}`, meetingBody(0, "Test Meeting renamed"), 500);
  await app.request("DELETE", `/meetings/${meetingId}`, { scope: "occurrence" }, 500);
  await app.request("POST", "/meetings/bulk-delete", { meetingIds: [meetingId], confirmation: "DELETE SELECTED MEETINGS" }, 500);
  assert.equal(snapshot(), before, "nothing of a failed request is kept: no meeting, no mapping, no operation");
  app.db.sqlite.exec("DROP TRIGGER test_refuse_discord_insert; DROP TRIGGER test_refuse_discord_update");
  const deleted = await app.request("DELETE", `/meetings/${meetingId}`, { scope: "occurrence" });
  const afterDelete = snapshot();
  app.db.sqlite.exec("CREATE TRIGGER test_refuse_google_update BEFORE UPDATE ON google_calendar_event_mappings BEGIN SELECT RAISE(ABORT, 'synthetic calendar queue failure'); END;");
  await app.request("POST", `/meetings/${meetingId}/restore`, { scope: "occurrence", deletion: deleted.body.deletion }, 500);
  assert.equal(snapshot(), afterDelete, "a restore whose calendar work fails restores nothing");
  app.db.sqlite.exec("DROP TRIGGER test_refuse_google_update");
  await app.request("POST", `/meetings/${meetingId}/restore`, { scope: "occurrence", deletion: deleted.body.deletion });
  assert.deepEqual(app.rows("SELECT active, generation FROM google_calendar_event_mappings"), [{ active: 1, generation: 2 }]);
});

test("superseded operations collapse, and the scheduler delivers what is left", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  const calendarRequests = () => app.remote.requests.splice(0).map((request) => request.replace(/ (ll[0-9a-f]+|\d+)$/, ""));

  // Created and deleted before any delivery: Google gets one delete (the event was never made), Discord nothing.
  const brief = await app.request("POST", "/meetings", meetingBody(0), 201);
  await app.request("DELETE", `/meetings/${brief.body.meeting.id}`, { scope: "occurrence" });
  assert.deepEqual(app.rows("SELECT action, status FROM google_calendar_operations"), [{ action: "delete", status: "pending" }]);
  assert.deepEqual(app.rows("SELECT action, status FROM discord_calendar_operations"), [{ action: "upsert", status: "delivered" }]);
  await app.deliver();
  assert.deepEqual(calendarRequests(), ["google DELETE"]); assert.equal(app.remote.google.size + app.remote.discord.size, 0);

  // Created, then edited three times before delivery: one operation each, delivered once with the last title.
  const edited = await app.request("POST", "/meetings", meetingBody(1), 201); const editedId = edited.body.meeting.id as string;
  for (const title of ["Test Meeting first edit", "Test Meeting second edit", "Test Meeting final"]) await app.request("PATCH", `/meetings/${editedId}`, meetingBody(1, title));
  assert.deepEqual(app.rows("SELECT action, status FROM google_calendar_operations WHERE meeting_id = ?", editedId), [{ action: "upsert", status: "pending" }]);
  assert.deepEqual(app.rows("SELECT action, status, revision FROM discord_calendar_operations WHERE meeting_id = ?", editedId), [{ action: "upsert", status: "pending", revision: 4 }]);
  await app.deliver();
  assert.deepEqual(calendarRequests().sort(), ["discord POST", "google POST"]);
  assert.deepEqual([[...app.remote.google.values()], [...app.remote.discord.values()]], [[{ summary: "Test Meeting final" }], [{ name: "Test Meeting final" }]]);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'discord.calendar_synced'"), 1);

  // An edit after delivery updates the same events.
  await app.request("PATCH", `/meetings/${editedId}`, meetingBody(1, "Test Meeting edited again")); await app.deliver();
  assert.deepEqual(calendarRequests().sort(), ["discord PATCH", "google PATCH"]);
  assert.deepEqual([[...app.remote.google.values()], [...app.remote.discord.values()]], [[{ summary: "Test Meeting edited again" }], [{ name: "Test Meeting edited again" }]]);

  // Deleted and restored before the delete is delivered: the old events go, new ones replace them, one of each remains.
  const oldGoogle = [...app.remote.google.keys()][0]; const oldDiscord = [...app.remote.discord.keys()][0];
  const deletion = (await app.request("DELETE", `/meetings/${editedId}`, { scope: "occurrence" })).body.deletion;
  await app.request("POST", `/meetings/${editedId}/restore`, { scope: "occurrence", deletion });
  assert.deepEqual(app.rows("SELECT generation, action, status FROM discord_calendar_operations WHERE meeting_id = ? AND status != 'delivered' ORDER BY generation", editedId), [{ generation: 1, action: "delete", status: "pending" }, { generation: 2, action: "upsert", status: "pending" }]);
  await app.deliver();
  assert.deepEqual(calendarRequests().sort(), ["discord DELETE", "discord POST", "google DELETE", "google POST"]);
  assert.equal(app.remote.google.size, 1); assert.equal(app.remote.discord.size, 1);
  assert.ok(!app.remote.google.has(oldGoogle!) && !app.remote.discord.has(oldDiscord!), "the events of the deleted generation are gone");
  assert.deepEqual(app.rows("SELECT g.active AS google, g.generation AS googleGeneration, g.event_id AS googleEvent, d.active AS discord, d.generation AS discordGeneration, d.event_id AS discordEvent FROM google_calendar_event_mappings g JOIN discord_calendar_event_mappings d ON d.meeting_id = g.meeting_id WHERE g.meeting_id = ?", editedId),
    [{ google: 1, googleGeneration: 2, googleEvent: [...app.remote.google.keys()][0], discord: 1, discordGeneration: 2, discordEvent: [...app.remote.discord.keys()][0] }]);

  // Deleted after delivery: both events are removed.
  await app.request("DELETE", `/meetings/${editedId}`, { scope: "occurrence" }); await app.deliver();
  assert.deepEqual(calendarRequests().sort(), ["discord DELETE", "google DELETE"]); assert.equal(app.remote.google.size + app.remote.discord.size, 0);
  assert.equal(app.count("SELECT (SELECT COUNT(*) FROM google_calendar_operations WHERE status != 'delivered') + (SELECT COUNT(*) FROM discord_calendar_operations WHERE status != 'delivered') AS n"), 0);
});

test("a meeting edited while its operation is being delivered keeps the newer operation", async (context) => {
  const app = await fixture(context, { google: true });
  const created = await app.request("POST", "/meetings", meetingBody(0), 201); const meetingId = created.body.meeting.id as string;
  // The edit lands while Google is answering the create.
  const realFetch = globalThis.fetch; let raced = false;
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    if (!raced && String(input).includes("/events") && init?.method === "POST") { raced = true; await new Promise((resolve) => setTimeout(resolve, 5)); await app.request("PATCH", `/meetings/${meetingId}`, meetingBody(0, "Test Meeting edited in flight")); }
    return response;
  };
  app.db.sqlite.exec("DELETE FROM platform_scheduler_state"); await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: 0 } as never, app.env as never);
  assert.ok(raced); assert.deepEqual(app.rows("SELECT action, status FROM google_calendar_operations"), [{ action: "upsert", status: "pending" }], "the edit's operation is not marked delivered by the older delivery");
  globalThis.fetch = realFetch; await app.deliver();
  assert.deepEqual([...app.remote.google.values()], [{ summary: "Test Meeting edited in flight" }]);
});

for (const provider of ["google", "discord"] as const) {
  test(`${provider} Sync all queues every current and upcoming meeting in a fixed number of subrequests`, async (context) => {
    const app = await fixture(context, { [provider]: true }); const path = provider === "google" ? "/admin/integrations/google-calendar/sync-all" : "/admin/integrations/discord/calendar/sync-all";
    const operations = `${provider}_calendar_operations`; const mappings = `${provider}_calendar_event_mappings`;
    app.db.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES('test-past','primary','Test Meeting past',?,?,1,'admin','2026-01-01')").run(new Date(Date.now() - 3 * day).toISOString(), new Date(Date.now() - 3 * day + 3_600_000).toISOString());
    const first = seedMeetings(app, 1, 0, "first");
    const one = await app.request("POST", path);
    assert.deepEqual([one.body.selected, one.body.queued, one.body.synced, one.body.failed, one.body.remaining], [1, 1, 0, 0, 0]); assert.match(one.body.rule, /has not ended is queued/);
    // 300 more, the first of them starting now: more than the old limit of 100 oldest meetings ever reached.
    const many = seedMeetings(app, 300, 1);
    app.db.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES('test-current','primary','Test Meeting current',?,?,1,'admin','2026-01-01')").run(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString());
    // Left behind by an interrupted request: a deleted meeting still mapped as live, and a live meeting whose mapping is inactive.
    const event = (id: string) => provider === "google" ? `'lltest${id}'` : "'900000000000000555'";
    app.db.sqlite.exec(`UPDATE meetings SET deleted_at = '2026-01-05T00:00:00.000Z' WHERE id = 'test-past';
      INSERT INTO ${mappings}(installation_id,meeting_id,event_id,generation,active,synced_at,updated_at) VALUES('primary','test-past',${event("past")},1,1,'2026-01-02','2026-01-02'),('primary','${many[0]}',${provider === "google" ? event("stuck") : "NULL"},3,0,NULL,'2026-01-02');`);
    const all = await app.request("POST", path);
    assert.equal(all.subrequests, one.subrequests, "300 meetings cost what one does"); assert.equal(all.outbound, 0); assert.ok(all.subrequests <= routeBudget, `Sync all costs ${all.subrequests}`);
    context.diagnostic(`${provider} Sync all: ${all.subrequests} subrequests`);
    // Discord cannot schedule the meeting that has already started, so it is selected but not queued there.
    assert.deepEqual([all.body.selected, all.body.queued, all.body.deletesQueued, all.body.remaining], [302, provider === "google" ? 302 : 301, 1, 0]);
    assert.equal(app.count(`SELECT COUNT(*) AS n FROM ${operations} WHERE action = 'upsert' AND status = 'pending' AND meeting_id IN ('test-current', '${first[0]}', '${many[299]}')`), provider === "google" ? 3 : 2, "the nearest and the furthest meeting are queued, and for Google the one under way");
    assert.deepEqual(app.rows(`SELECT action, status FROM ${operations} WHERE meeting_id = 'test-past'`), [{ action: "delete", status: "pending" }]);
    assert.deepEqual(app.rows(`SELECT active, generation FROM ${mappings} WHERE meeting_id IN ('test-past', '${many[0]}') ORDER BY generation`), [{ active: 0, generation: 1 }, { active: 1, generation: 4 }]);
    if (provider === "discord") {
      assert.equal(all.body.deferred, 242, "meetings more than 60 days out wait for the horizon");
      const started = await app.request("POST", "/discord/calendar", { meetingId: "test-current" });
      assert.deepEqual([started.body.queued, started.body.skipped, started.body.outcomes[0].reason], [0, 1, "Meeting has already started and has no Discord event. Sync upcoming meetings before their start time."]); assert.equal(all.body.nextCursor, null);
      assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE status = 'pending' AND next_attempt_at > ?", new Date(Date.now() + 60_000).toISOString()), 242);
      // The Operator route for every meeting does the same work.
      const operatorRoute = await app.request("POST", "/discord/calendar", { all: true });
      assert.deepEqual([operatorRoute.body.selected, operatorRoute.body.queued, operatorRoute.subrequests <= routeBudget], [302, 301, true]);
    }
    await app.deliver();
    if (provider === "google") { assert.equal(app.remote.google.size, 302); assert.equal(app.remote.google.has("lltestpast"), false); }
    // 59 of the 60 meetings within the horizon: the one that has already started was never queued.
    else assert.equal(app.remote.discord.size, 59, "Discord has an event for each upcoming meeting within 60 days and for none beyond");
    assert.equal(app.count(`SELECT COUNT(*) AS n FROM ${operations} WHERE status = 'failed'`), 0);
  });
}

test("Delete attendance data leaves the remote events for the scheduler to delete", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  const removal = { scope: "attendance", confirmation: "DELETE ATTENDANCE" };
  seedMeetings(app, 1); await app.request("POST", "/admin/integrations/google-calendar/sync-all"); await app.request("POST", "/admin/integrations/discord/calendar/sync-all"); await app.deliver();
  assert.deepEqual([app.remote.google.size, app.remote.discord.size], [1, 1]);
  const one = await app.request("DELETE", "/admin/data", removal);
  assert.equal(one.body.calendarEventRemovalsQueued, 2); assert.equal(app.count("SELECT COUNT(*) AS n FROM meetings"), 0);
  await app.deliver(); assert.deepEqual([app.remote.google.size, app.remote.discord.size, app.count("SELECT COUNT(*) AS n FROM calendar_event_removals")], [0, 0, 0]);

  // 300 meetings: 300 Google events and the 59 Discord events within the horizon, one of them deleted but not yet removed.
  const ids = seedMeetings(app, 300); await app.request("POST", "/admin/integrations/google-calendar/sync-all"); await app.request("POST", "/admin/integrations/discord/calendar/sync-all"); await app.deliver();
  assert.deepEqual([app.remote.google.size, app.remote.discord.size], [300, 59]);
  await app.request("DELETE", `/meetings/${ids[0]}`, { scope: "occurrence" });
  // Discord is switched off before the data is deleted: its removals wait until it is back.
  app.db.sqlite.exec("UPDATE installations SET discord_enabled = 0");
  const many = await app.request("DELETE", "/admin/data", removal);
  assert.equal(many.subrequests, one.subrequests, "300 meetings cost what one does"); assert.equal(many.outbound, 0); assert.ok(many.subrequests <= routeBudget, `Delete attendance data costs ${many.subrequests}`);
  context.diagnostic(`Delete attendance data: ${many.subrequests} subrequests`);
  assert.equal(many.body.calendarEventRemovalsQueued, 359);
  assert.equal(app.count("SELECT (SELECT COUNT(*) FROM meetings) + (SELECT COUNT(*) FROM google_calendar_operations) + (SELECT COUNT(*) FROM discord_calendar_event_mappings) AS n"), 0);
  const waiting = () => app.rows<{ provider: string; n: number }>("SELECT provider, COUNT(*) AS n FROM calendar_event_removals GROUP BY provider ORDER BY provider");
  for (let pass = 0; pass < 150 && app.remote.google.size > 0; pass += 1) { app.db.sqlite.exec("DELETE FROM platform_scheduler_state"); await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: pass * 300_000 } as never, app.env as never); }
  assert.deepEqual([app.remote.google.size, app.remote.discord.size], [0, 59]); assert.deepEqual(waiting(), [{ provider: "discord", n: 59 }]);
  app.db.sqlite.exec("UPDATE installations SET discord_enabled = 1"); await app.deliver();
  assert.equal(app.remote.discord.size, 0); assert.deepEqual(waiting(), []);
});

test("the five scheduled scans search an index, and only the anomaly scan sorts what it finds", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  app.db.sqlite.exec("UPDATE organization_settings SET discord_anomaly_reports_enabled = 1, discord_anomaly_report_channel_id = '323456789012345678', discord_anomaly_reports_enabled_at = '2026-01-01T00:00:00.000Z'");
  // Enough passes for every job to run, whichever jobs a pass's budget defers.
  app.prepared.length = 0;
  for (let pass = 0; pass < 9; pass += 1) { app.db.sqlite.exec("DELETE FROM platform_scheduler_state"); await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: pass * 300_000 } as never, app.env as never); }
  const log = app.prepared;
  const scans: [string, string, RegExp][] = [
    ["Google operations", "o.updated_at AS updatedAt", /SEARCH o USING INDEX idx_google_calendar_operations_queue \(installation_id=\? AND next_attempt_at/],
    ["Discord operations", "o.actor_user_id AS actorUserId", /SEARCH o USING INDEX idx_discord_calendar_operations_queue \(installation_id=\? AND next_attempt_at/],
    ["notice expiry", "FROM discord_attendance_notifications WHERE installation_id = 'primary' AND status = 'delivered'", /SEARCH discord_attendance_notifications USING INDEX idx_discord_attendance_notifications_expiry \(installation_id=\? AND status=\?\)/],
    ["absence notices", "LEFT JOIN discord_attendance_notifications n", /SEARCH m USING INDEX idx_meetings_ended \(installation_id=\? AND ends_at/],
    ["anomaly reports", "LEFT JOIN discord_anomaly_reports r", /SEARCH m USING INDEX idx_meetings_ended \(installation_id=\? AND ends_at/],
  ];
  for (const [name, fragment, expected] of scans) {
    const sql = log.find((entry) => entry.includes(fragment)); assert.ok(sql, `the pass ran the ${name} scan`);
    const plan = app.db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => "2026-06-01T00:00:00.000Z") as never[]).map((row) => String((row as { detail: string }).detail)).join("\n");
    assert.match(plan, expected, `${name}: ${plan}`); assert.doesNotMatch(plan, /SCAN (o|m|discord_attendance_notifications)\b/, `${name}: ${plan}`);
    // The anomaly-report job puts reports never attempted first, a column of the joined table that no index on meetings
    // can order by: it sorts the meetings its bounded index search finds (those that ended since reports were turned on).
    if (name !== "anomaly reports") assert.doesNotMatch(plan, /TEMP B-TREE/, `${name}: ${plan}`);
  }
  // The event removals read in the same query search their own index.
  const removals = app.db.sqlite.prepare(`EXPLAIN QUERY PLAN ${log.find((entry) => entry.includes("o.updated_at AS updatedAt"))}`).all("2026", "2026").map((row) => String((row as { detail: string }).detail)).join("\n");
  assert.match(removals, /SEARCH r USING INDEX idx_calendar_event_removals_due \(installation_id=\? AND provider=\? AND next_attempt_at>\? AND next_attempt_at<\?\)/);
});

test("housekeeping removes delivered operations after 30 days, a bounded number per pass", async (context) => {
  const app = await fixture(context, {});
  const old = new Date(Date.now() - 31 * day).toISOString(); const recent = new Date(Date.now() - 29 * day).toISOString(); const soon = new Date(Date.now() + day).toISOString();
  const meeting = app.db.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at,deleted_at) VALUES(?,'primary','Test Meeting',?,?,1,'admin','2026-01-01',?)");
  meeting.run("test-over", old, old, null); meeting.run("test-upcoming", soon, soon, null); meeting.run("test-deleted", soon, soon, old);
  const google = app.db.sqlite.prepare("INSERT INTO google_calendar_operations(installation_id,meeting_id,event_id,action,starts_at,ends_at,status,attempts,next_attempt_at,updated_at) VALUES('primary',?,?,?,?,?,?,1,?,?)");
  const discord = app.db.sqlite.prepare("INSERT INTO discord_calendar_operations(installation_id,meeting_id,generation,action,event_id,status,attempts,next_attempt_at,updated_at) VALUES('primary',?,?,?,?,?,1,?,?)");
  // Kept: delivered recently, still pending or due for a retry, a failed delete, and a failed upsert for a meeting still to come.
  google.run("test-over", "llkeep-recent", "upsert", old, old, "delivered", null, recent); google.run("test-over", "llkeep-pending", "upsert", old, old, "pending", old, old); google.run("test-over", "llkeep-retry", "upsert", old, old, "failed", old, old);
  google.run("test-over", "llkeep-delete", "delete", null, null, "failed", null, old); google.run("test-upcoming", "llkeep-upcoming", "upsert", soon, soon, "failed", null, old);
  // Removed: delivered 31 days ago, and failed upserts nothing retries for a meeting that is over or deleted.
  google.run("test-over", "llgone-delivered", "upsert", old, old, "delivered", null, old); google.run("test-over", "llgone-over", "upsert", old, old, "failed", null, old); google.run("test-deleted", "llgone-deleted", "upsert", soon, soon, "failed", null, old);
  discord.run("test-over", 1, "upsert", null, "delivered", null, old); discord.run("test-over", 1, "delete", "900000000000000001", "delivered", null, recent); discord.run("test-over", 2, "upsert", null, "failed", null, old); discord.run("test-upcoming", 1, "upsert", null, "failed", null, old); discord.run("test-over", 3, "upsert", null, "processing", old, old);
  const removed = await pruneStaleRows(app.db);
  assert.deepEqual([removed.googleCalendarOperations, removed.discordCalendarOperations], [3, 2]);
  assert.deepEqual(app.rows<{ id: string }>("SELECT event_id AS id FROM google_calendar_operations ORDER BY event_id").map((row) => row.id), ["llkeep-delete", "llkeep-pending", "llkeep-recent", "llkeep-retry", "llkeep-upcoming"]);
  assert.deepEqual(app.rows("SELECT meeting_id AS meeting, generation, action FROM discord_calendar_operations ORDER BY meeting_id, generation, action"), [{ meeting: "test-over", generation: 1, action: "delete" }, { meeting: "test-over", generation: 3, action: "upsert" }, { meeting: "test-upcoming", generation: 1, action: "upsert" }]);
  // A backlog goes a batch at a time, oldest first.
  for (let index = 0; index < 5; index += 1) google.run("test-over", `llbacklog-${index}`, "upsert", old, old, "delivered", null, new Date(Date.parse(old) - index * 1_000).toISOString());
  assert.equal((await pruneStaleRows(app.db, Date.now(), 2)).googleCalendarOperations, 2);
  assert.deepEqual(app.rows<{ id: string }>("SELECT event_id AS id FROM google_calendar_operations WHERE event_id LIKE 'llbacklog-%' ORDER BY event_id").map((row) => row.id), ["llbacklog-0", "llbacklog-1", "llbacklog-2"]);
  for (const table of ["google_calendar_operations", "discord_calendar_operations"]) {
    const plan = app.db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM ${table} WHERE installation_id = 'primary' AND status = 'delivered' AND next_attempt_at IS NULL AND updated_at < ? ORDER BY updated_at LIMIT ?`).all(old, 200).map((row) => String((row as { detail: string }).detail)).join("\n");
    assert.match(plan, new RegExp(`SEARCH ${table} USING COVERING INDEX idx_${table}_due \\(installation_id=\\? AND status=\\? AND next_attempt_at=\\? AND updated_at<\\?\\)`)); assert.doesNotMatch(plan, /TEMP B-TREE/);
  }
});

test("operations and mappings stored before migration 0103 still deliver after it", async (context) => {
  const migrations = readCoreMigrations(); const before = migrations.filter((file) => file.name < "0103"); const later = migrations.filter((file) => file.name >= "0103");
  // Later migrations (0104's housekeeping indexes, 0105's staging tables) are applied below after 0103, as an update applies them.
  assert.equal(later[0]?.name, "0103_calendar_queue.sql");
  const db = new TestD1Database({ coreMigrations: before, recordMigrations: true, seed: backupSeed() });
  const near = startOf(1).toISOString(); const far = startOf(120).toISOString(); const hour = (value: string) => new Date(Date.parse(value) + 3_600_000).toISOString();
  const meeting = db.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at,deleted_at) VALUES(?,'primary',?,?,?,1,'admin','2026-01-01',?)");
  meeting.run("old-near", "Test Meeting near", near, hour(near), null); meeting.run("old-far", "Test Meeting far", far, hour(far), null); meeting.run("old-leased", "Test Meeting leased", near, hour(near), null); meeting.run("old-deleted", "Test Meeting deleted", near, hour(near), "2026-01-03T00:00:00.000Z");
  // As the previous Worker left them: pending upserts (one written without next_attempt_at), a delete for a deleted
  // meeting's event, a failed operation waiting for its retry, and a Discord delivery whose lease ran out.
  db.sqlite.exec(`INSERT INTO google_calendar_event_mappings(installation_id,meeting_id,event_id,generation,active,synced_at,updated_at) VALUES('primary','old-near','lloldnear',1,1,NULL,'2026-01-02'),('primary','old-far','lloldfar',1,1,NULL,'2026-01-02'),('primary','old-deleted','llolddeleted',1,0,'2026-01-02','2026-01-03');
    INSERT INTO google_calendar_operations(installation_id,meeting_id,event_id,action,starts_at,ends_at,status,attempts,next_attempt_at,updated_at) VALUES('primary','old-near','lloldnear','upsert','${near}','${hour(near)}','pending',0,NULL,'2026-01-02T00:00:00.000Z'),('primary','old-far','lloldfar','upsert','${far}','${hour(far)}','failed',2,'2026-01-02T01:00:00.000Z','2026-01-02T00:00:00.000Z'),('primary','old-deleted','llolddeleted','delete',NULL,NULL,'pending',0,'2026-01-03T00:00:00.000Z','2026-01-03T00:00:00.000Z');
    INSERT INTO discord_calendar_event_mappings(installation_id,meeting_id,event_id,generation,active,synced_at,updated_at) VALUES('primary','old-near',NULL,1,1,NULL,'2026-01-02'),('primary','old-far',NULL,1,1,NULL,'2026-01-02'),('primary','old-leased',NULL,1,1,NULL,'2026-01-02'),('primary','old-deleted','900000000000000444',1,0,'2026-01-02','2026-01-03');
    INSERT INTO discord_calendar_operations(installation_id,meeting_id,generation,action,event_id,status,attempts,revision,next_attempt_at,lease_token,lease_expires_at,updated_at) VALUES('primary','old-near',1,'upsert',NULL,'pending',0,1,'2026-01-02T00:00:00.000Z',NULL,NULL,'2026-01-02T00:00:00.000Z'),('primary','old-far',1,'upsert',NULL,'pending',0,1,'2026-01-02T00:00:00.000Z',NULL,NULL,'2026-01-02T00:00:00.000Z'),
      ('primary','old-leased',1,'upsert',NULL,'processing',0,1,NULL,'test-lease','2026-01-02T00:05:00.000Z','2026-01-02T00:00:00.000Z'),('primary','old-deleted',1,'delete','900000000000000444','pending',0,1,'2026-01-03T00:00:00.000Z',NULL,NULL,'2026-01-03T00:00:00.000Z');`);
  // 0103 and every migration after it, as an update applies them.
  for (const file of later) { db.sqlite.exec(file.content); db.sqlite.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(file.name); }
  const app = await fixture(context, { google: true, discord: true }, db);
  app.remote.google.set("llolddeleted", { summary: "Test Meeting deleted" }); app.remote.discord.set("900000000000000444", { name: "Test Meeting deleted" });
  assert.deepEqual(app.rows("SELECT meeting_id AS meeting, status, next_attempt_at AS due FROM discord_calendar_operations WHERE meeting_id IN ('old-far', 'old-leased') ORDER BY meeting_id"),
    [{ meeting: "old-far", status: "pending", due: new Date(Date.parse(far) - 60 * day).toISOString() }, { meeting: "old-leased", status: "processing", due: "2026-01-02T00:05:00.000Z" }]);
  await app.deliver();
  assert.deepEqual([...app.remote.google.keys()].sort(), ["lloldfar", "lloldnear"], "Google has both live meetings and not the deleted one");
  assert.deepEqual([...app.remote.discord.values()].map((event) => event.name).sort(), ["Test Meeting leased", "Test Meeting near"], "Discord has the meetings within 60 days and not the deleted one");
  assert.deepEqual(app.rows("SELECT meeting_id AS meeting, status FROM discord_calendar_operations WHERE status != 'delivered'"), [{ meeting: "old-far", status: "pending" }]);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM google_calendar_operations WHERE status != 'delivered'"), 0);
});

const cronPass = async (app: Fixture, slot = 0) => { app.db.sqlite.exec("DELETE FROM platform_scheduler_state"); await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: slot * 300_000 } as never, app.env as never); };
/** The answer both providers give a delete they refuse for want of a permission. */
function refuseDeletes(context: TestContext, status: number) {
  const realFetch = globalThis.fetch; context.mock.method(console, "error", () => {});
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "DELETE" && url.includes("/scheduled-events/")) return Response.json({ message: "Missing Permissions", code: 50013 }, { status });
    if (init?.method === "DELETE" && url.includes("/events/")) return Response.json({ error: { code: status, message: "Forbidden" } }, { status });
    return realFetch(input, init);
  };
  return () => { globalThis.fetch = realFetch; };
}

test("an event removal the provider refuses is retried over days, then set aside where an Admin can see and retry it", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  seedMeetings(app, 6); await app.request("POST", "/admin/integrations/google-calendar/sync-all"); await app.request("POST", "/admin/integrations/discord/calendar/sync-all"); await app.deliver();
  await app.request("DELETE", "/admin/data", { scope: "attendance", confirmation: "DELETE ATTENDANCE" });
  // The bot has lost Manage Events and the calendar is read-only: every delete is answered 403.
  const allow = refuseDeletes(context, 403);
  for (let slot = 0; slot < 9; slot += 1) await cronPass(app, slot);
  const removals = () => app.rows<{ provider: string; n: number; attempts: number; soonest: string | null }>("SELECT provider, COUNT(*) AS n, MAX(attempts) AS attempts, MIN(next_attempt_at) AS soonest FROM calendar_event_removals GROUP BY provider ORDER BY provider");
  const refused = removals();
  assert.deepEqual(refused.map((row) => [row.provider, row.n, row.attempts]), [["discord", 6, 1], ["google_calendar", 6, 1]], "a refusal keeps the removal, tried once so far");
  assert.ok(refused.every((row) => row.soonest! >= new Date(Date.now() + 14 * 60_000).toISOString()), "the next attempt is at least a quarter of an hour away");
  assert.deepEqual([app.remote.google.size, app.remote.discord.size, app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'calendar.event_removal_abandoned'")], [6, 6, 0]);
  // The ninth refusal still leaves an attempt; the tenth sets the removal aside, with its error and an audit entry.
  app.db.sqlite.exec("UPDATE calendar_event_removals SET attempts = 8, next_attempt_at = '2026-01-01T00:00:00.000Z'"); for (let slot = 0; slot < 9; slot += 1) await cronPass(app, slot);
  assert.deepEqual(removals().map((row) => [row.n, row.attempts, row.soonest === null]), [[6, 9, false], [6, 9, false]]);
  app.db.sqlite.exec("UPDATE calendar_event_removals SET next_attempt_at = '2026-01-01T00:00:00.000Z'"); for (let slot = 0; slot < 9; slot += 1) await cronPass(app, slot);
  assert.deepEqual(removals().map((row) => [row.n, row.attempts, row.soonest]), [[6, 10, null], [6, 10, null]]);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'calendar.event_removal_abandoned'"), 12);
  // The integration cards count them as needing another attempt and say why.
  const status = (await app.request("GET", "/admin/integrations")).body.integrations as { provider: string; failedOperations?: number; pendingOperations?: number; lastError?: string }[];
  const card = status.find((item) => item.provider === "google_calendar")!;
  assert.deepEqual([card.failedOperations, card.pendingOperations], [6, 0]); assert.match(card.lastError!, /^6 calendar events of deleted meetings could not be removed: /);
  assert.equal(status.find((item) => item.provider === "discord")!.failedOperations, 6);
  // Access is restored and the Admin retries from the card: the events go.
  allow(); await app.request("POST", "/admin/integrations/google-calendar/retry", {});
  await app.deliver(); assert.equal(app.remote.google.size, 0); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals WHERE provider = 'google_calendar'"), 0);
  // Sync all gives the set-aside Discord removals a fresh allowance.
  await app.request("POST", "/admin/integrations/discord/calendar/sync-all"); await app.deliver();
  assert.deepEqual([app.remote.discord.size, app.count("SELECT COUNT(*) AS n FROM calendar_event_removals")], [0, 0]);
});

test("a removal recorded for another calendar or server is dropped, not sent to the one now configured", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  seedMeetings(app, 1); await app.request("POST", "/admin/integrations/google-calendar/sync-all"); await app.request("POST", "/admin/integrations/discord/calendar/sync-all"); await app.deliver();
  await app.request("DELETE", "/admin/data", { scope: "attendance", confirmation: "DELETE ATTENDANCE" });
  assert.deepEqual(app.rows<{ provider: string; target: string }>("SELECT provider, target FROM calendar_event_removals ORDER BY provider").map((row) => [row.provider, row.provider === "discord" ? row.target : /^[0-9a-f]{32}$/.test(row.target)]), [["discord", guildId], ["google_calendar", true]]);
  // The installation is then pointed at another calendar and another server.
  app.db.sqlite.exec("UPDATE calendar_event_removals SET target = 'another-target'"); app.remote.requests.length = 0;
  await app.deliver();
  assert.deepEqual(app.remote.requests.filter((request) => request.includes("DELETE")), [], "no delete is sent"); assert.deepEqual([app.remote.google.size, app.remote.discord.size], [1, 1]);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'calendar.event_removal_abandoned' AND metadata_json LIKE '%no longer the one configured%'"), 2);
});

test("while Google refuses the token, due removals back off and the job does not ask to run again at once", async (context) => {
  const app = await fixture(context, { google: true });
  const insert = app.db.sqlite.prepare("INSERT INTO calendar_event_removals(installation_id,provider,event_id,attempts,next_attempt_at,updated_at) VALUES('primary','google_calendar',?,0,'2026-01-01','2026-01-01')");
  for (let index = 0; index < 6; index += 1) insert.run(`lltest${index}`);
  const realFetch = globalThis.fetch; context.mock.method(console, "error", () => {}); let tokenCalls = 0;
  globalThis.fetch = async (input, init) => { if (String(input) === "https://oauth2.googleapis.com/token") { tokenCalls += 1; return Response.json({ error: "invalid_grant" }, { status: 400 }); } return realFetch(input, init); };
  // Durable Object slices, each at the time the one before asked to be woken, for what would be an hour of alarms.
  const slices: boolean[] = []; let time = Date.now(); const end = time + 3_600_000;
  for (let index = 0; index < 400 && time < end; index += 1) { const report = await runSchedulerSlice(app.env as never, {}, time); if (report.ran === "attendance.google-calendar") slices.push(Boolean(report.more)); time = Math.max(time + 1, report.nextWake); }
  assert.ok(slices.length >= 1 && slices.every((more) => !more), `the job never reports more work: ${JSON.stringify(slices)}`);
  assert.ok(tokenCalls <= 13, `Google's token endpoint is asked at most once per five-minute round, not every second: ${tokenCalls}`);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals WHERE attempts >= 1 AND next_attempt_at > '2026-06-01'"), 6, "every removal is backed off");
});

for (const provider of ["google", "discord"] as const) {
  test(`${provider} delivers deletes first, then the soonest meeting first, whenever it was queued`, async (context) => {
    const app = await fixture(context, { [provider]: true }); const path = provider === "google" ? "/admin/integrations/google-calendar/sync-all" : "/admin/integrations/discord/calendar/sync-all";
    const events = () => provider === "google" ? [...app.remote.google.values()].map((event) => event.summary) : [...app.remote.discord.values()].map((event) => event.name);
    const perPass = provider === "google" ? 5 : 3;
    // An event that is delivered and then deleted, whose delete waits behind nothing.
    const gone = await app.request("POST", "/meetings", meetingBody(40, "Test Meeting to delete"), 201); await app.deliver();
    // Twelve meetings written latest first, queued together by Sync all; then one for tomorrow, queued after them.
    const insert = app.db.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES(?,'primary',?,?,?,1,'admin','2026-01-01')");
    for (let index = 11; index >= 0; index -= 1) { const start = startOf(5 + index, 5); insert.run(`test-order-${index}`, `Test Meeting day ${String(6 + index).padStart(2, "0")}`, start.toISOString(), new Date(start.getTime() + 3_600_000).toISOString()); }
    await app.request("POST", path);
    await app.request("POST", "/meetings", meetingBody(0, "Test Meeting day 01"), 201);
    await app.request("DELETE", `/meetings/${gone.body.meeting.id}`, { scope: "occurrence" });
    // One pass at a time: whatever has been delivered so far is always the delete and then the soonest meetings.
    const order = ["Test Meeting day 01", ...Array.from({ length: 12 }, (_, index) => `Test Meeting day ${String(6 + index).padStart(2, "0")}`)]; let seen = 0;
    for (let slot = 0; slot < 40 && events().length < 13 + (seen ? 0 : 1); slot += 1) {
      await cronPass(app, slot); const now = events();
      if (now.length === seen || (seen === 0 && now.includes("Test Meeting to delete") && now.length === 1)) continue;
      const created = now.filter((title) => title !== "Test Meeting to delete");
      if (created.length) assert.equal(now.includes("Test Meeting to delete"), false, "the delete went out before any new event");
      assert.deepEqual([...created].sort(), order.slice(0, created.length), `after ${created.length} events (at most ${perPass} a pass)`);
      seen = now.length; if (created.length === 13) break;
    }
    assert.deepEqual(events().sort(), order);
  });
}

test("a failing operation does not hold back the rest of the queue", async (context) => {
  const app = await fixture(context, { google: true });
  seedMeetings(app, 8); await app.request("POST", "/admin/integrations/google-calendar/sync-all");
  // Google refuses the three soonest meetings' events, retryably, every time.
  const realFetch = globalThis.fetch; context.mock.method(console, "error", () => {});
  globalThis.fetch = async (input, init) => typeof init?.body === "string" && /Test Meeting seed-00[012]/.test(init.body) ? Response.json({ error: { code: 503, message: "Synthetic outage" } }, { status: 503 }) : realFetch(input, init);
  for (let slot = 0; slot < 30 && app.remote.google.size < 5; slot += 1) await cronPass(app, slot);
  assert.deepEqual([...app.remote.google.values()].map((event) => event.summary).sort(), [3, 4, 5, 6, 7].map((index) => `Test Meeting seed-00${index}`));
  assert.deepEqual(app.rows("SELECT status, COUNT(*) AS n FROM google_calendar_operations GROUP BY status ORDER BY status"), [{ status: "delivered", n: 5 }, { status: "failed", n: 3 }]);
  // An edit starts a failed operation's retry count again.
  await app.request("PATCH", "/meetings/seed-000", { title: "Test Meeting seed-000", startsAt: startOf(0, 5).toISOString(), endsAt: new Date(startOf(0, 5).getTime() + 7_200_000).toISOString() });
  assert.deepEqual(app.rows("SELECT status, attempts, next_attempt_at AS due FROM google_calendar_operations WHERE meeting_id = 'seed-000'"), [{ status: "pending", attempts: 0, due: "1970-01-01T00:00:00.000Z" }]);
});

test("nothing is queued for an integration that is off, queued work is settled, and Sync all catches up", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  const kept = await app.request("POST", "/meetings", meetingBody(3), 201); const removed = await app.request("POST", "/meetings", meetingBody(4), 201); await app.deliver();
  const waitingEdit = await app.request("PATCH", `/meetings/${kept.body.meeting.id}`, meetingBody(3, "Test Meeting queued before off"));
  assert.deepEqual([waitingEdit.body.calendarDelivery.google_calendar.queued, waitingEdit.body.calendarDelivery.discord.queued], [1, 1]);
  app.db.sqlite.exec("UPDATE installations SET google_calendar_enabled = 0, discord_enabled = 0");
  // Housekeeping settles what was already queued, with the reason, instead of leaving it pending.
  await pruneStaleRows(app.db);
  assert.deepEqual(app.rows("SELECT 'google' AS provider, status, next_attempt_at AS due, last_error AS error FROM google_calendar_operations WHERE status != 'delivered' UNION ALL SELECT 'discord', status, next_attempt_at, last_error FROM discord_calendar_operations WHERE status != 'delivered'"),
    [{ provider: "google", status: "failed", due: null, error: "Google Calendar was switched off or is not verified. Turn it on, then choose Sync all meetings." }, { provider: "discord", status: "failed", due: null, error: "Discord was switched off or is not verified. Turn it on, then choose Sync all meetings." }]);
  // With active mappings and the integrations off, an edit and a delete queue nothing and leave the mappings alone.
  const operations = () => app.count("SELECT (SELECT COUNT(*) FROM google_calendar_operations WHERE status = 'pending') + (SELECT COUNT(*) FROM discord_calendar_operations WHERE status IN ('pending', 'processing')) AS n");
  const edited = await app.request("PATCH", `/meetings/${kept.body.meeting.id}`, meetingBody(3, "Test Meeting edited while off"));
  const deleted = await app.request("DELETE", `/meetings/${removed.body.meeting.id}`, { scope: "occurrence" });
  for (const body of [edited.body, deleted.body]) assert.deepEqual([body.calendarDelivery.google_calendar.queued, body.calendarDelivery.discord.queued], [0, 0]);
  assert.equal(operations(), 0); assert.equal(app.count("SELECT (SELECT COUNT(*) FROM google_calendar_event_mappings WHERE active = 1) + (SELECT COUNT(*) FROM discord_calendar_event_mappings WHERE active = 1) AS n"), 4);
  for (let slot = 0; slot < 9; slot += 1) await cronPass(app, slot);
  assert.equal(operations(), 0, "nothing is left pending for a provider that is off");
  // Back on: Sync all sends the edit and removes the deleted meeting's events.
  app.db.sqlite.exec("UPDATE installations SET google_calendar_enabled = 1, discord_enabled = 1");
  const google = await app.request("POST", "/admin/integrations/google-calendar/sync-all"); const discord = await app.request("POST", "/admin/integrations/discord/calendar/sync-all");
  assert.deepEqual([google.body.queued, google.body.deletesQueued, discord.body.queued, discord.body.deletesQueued], [1, 1, 1, 1]);
  await app.deliver();
  assert.deepEqual([[...app.remote.google.values()], [...app.remote.discord.values()]], [[{ summary: "Test Meeting edited while off" }], [{ name: "Test Meeting edited while off" }]]);
});

test("disabling Attendance is not blocked by queued calendar work, only by a delivery in flight, and keeps pending removals", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  const live = await app.request("POST", "/meetings", meetingBody(3), 201); const gone = await app.request("POST", "/meetings", meetingBody(4), 201); await app.deliver();
  await app.request("PATCH", `/meetings/${live.body.meeting.id}`, meetingBody(3, "Test Meeting edited")); await app.request("DELETE", `/meetings/${gone.body.meeting.id}`, { scope: "occurrence" });
  assert.equal(app.count("SELECT (SELECT COUNT(*) FROM google_calendar_operations WHERE status = 'pending') + (SELECT COUNT(*) FROM discord_calendar_operations WHERE status = 'pending') AS n"), 4);
  const disable = async (expected: number) => {
    const modules = (await app.request("GET", "/platform/modules")).body; const attendance = modules.modules.find((module: { id: string }) => module.id === "attendance");
    return app.request("PUT", "/admin/modules", { enabled: modules.modules.filter((module: { id: string; phase: string }) => module.phase === "enabled" && module.id !== "attendance").map((module: { id: string }) => module.id), revision: modules.revision, confirmDisable: [{ moduleId: "attendance", generation: attendance.generation }] }, expected);
  };
  // A Discord delivery holds its lease: that, and only that, asks the Admin to wait a moment.
  app.db.sqlite.prepare("UPDATE discord_calendar_operations SET status = 'processing', lease_token = 'test-lease', lease_expires_at = ? WHERE action = 'upsert' AND status = 'pending'").run(new Date(Date.now() + 240_000).toISOString());
  assert.match((await disable(409)).body.error, /being sent right now: try again in a moment/);
  app.db.sqlite.exec("UPDATE discord_calendar_operations SET status = 'pending', lease_token = NULL, lease_expires_at = NULL WHERE status = 'processing'");
  await disable(200);
  assert.equal((await app.request("GET", "/platform/modules")).body.modules.find((module: { id: string }) => module.id === "attendance").phase, "retained");
  // The deleted meeting's events are recorded for removal; the queued operations stay with the retained data.
  assert.deepEqual(app.rows("SELECT provider, COUNT(*) AS n FROM calendar_event_removals GROUP BY provider ORDER BY provider"), [{ provider: "discord", n: 1 }, { provider: "google_calendar", n: 1 }]);
  assert.equal(app.count("SELECT (SELECT COUNT(*) FROM google_calendar_operations WHERE status = 'pending') + (SELECT COUNT(*) FROM discord_calendar_operations WHERE status = 'pending') AS n"), 4);
});

test("a meeting with a Discord event that is edited into the past has that event deleted", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  const created = await app.request("POST", "/meetings", meetingBody(3), 201); const id = created.body.meeting.id as string; await app.deliver();
  assert.equal(app.remote.discord.size, 1); app.remote.requests.length = 0;
  const past = new Date(Date.now() - 2 * day);
  const moved = await app.request("PATCH", `/meetings/${id}`, { title: "Test Meeting 3", startsAt: past.toISOString(), endsAt: new Date(past.getTime() + 3_600_000).toISOString() });
  assert.deepEqual([moved.body.calendarDelivery.google_calendar.queued, moved.body.calendarDelivery.discord.queued], [1, 1]);
  await app.deliver();
  assert.deepEqual(app.remote.requests.map((request) => request.replace(/ (ll[0-9a-f]+|\d+)$/, "")).sort(), ["discord DELETE", "google PATCH"]);
  assert.equal(app.remote.discord.size, 0, "Discord no longer shows the event at its old time"); assert.equal(app.remote.google.size, 1);
  assert.deepEqual(app.rows("SELECT active, event_id AS eventId FROM discord_calendar_event_mappings"), [{ active: 0, eventId: null }]);
});

test("a Discord operation left in delivery with no next attempt is picked up once its lease has ended", async (context) => {
  const app = await fixture(context, { discord: true }); const ids = seedMeetings(app, 1);
  // As the previous Worker writes a claim after migration 0103 has run: processing, a lease, and no next_attempt_at.
  app.db.sqlite.exec(`INSERT INTO discord_calendar_event_mappings(installation_id,meeting_id,event_id,generation,active,synced_at,updated_at) VALUES('primary','${ids[0]}',NULL,1,1,NULL,'2026-01-02');
    INSERT INTO discord_calendar_operations(installation_id,meeting_id,generation,action,event_id,status,attempts,revision,next_attempt_at,lease_token,lease_expires_at,updated_at) VALUES('primary','${ids[0]}',1,'upsert',NULL,'processing',0,1,NULL,'test-old-lease','2026-01-02T00:05:00.000Z','2026-01-02T00:00:00.000Z')`);
  for (let slot = 0; slot < 12 && app.remote.discord.size === 0; slot += 1) await cronPass(app, slot);
  assert.equal(app.remote.discord.size, 1); assert.deepEqual(app.rows("SELECT status, next_attempt_at AS due FROM discord_calendar_operations"), [{ status: "delivered", due: null }]);
});

for (const undo of [false, true]) {
  test(`a delete${undo ? " and its undo" : ""} that lands while the create is being sent leaves ${undo ? "one event" : "no event"} on each calendar`, async (context) => {
    const app = await fixture(context, { google: true, discord: true });
    const created = await app.request("POST", "/meetings", meetingBody(2), 201); const id = created.body.meeting.id as string;
    const realFetch = globalThis.fetch; const raced = new Set<string>();
    globalThis.fetch = async (input, init) => {
      const response = await realFetch(input, init); const url = String(input);
      const which = url.includes("scheduled-events") ? "discord" : url.includes("/events") ? "google" : "";
      if (which && init?.method === "POST" && !raced.has(which)) {
        raced.add(which);
        // The first provider's create is answered: before its delivery records that, the meeting is deleted (and restored).
        if (raced.size === 1) { const deletion = (await app.request("DELETE", `/meetings/${id}`, { scope: "occurrence" })).body.deletion; if (undo) await app.request("POST", `/meetings/${id}/restore`, { scope: "occurrence", deletion }); }
      }
      return response;
    };
    await cronPass(app); await cronPass(app, 1); globalThis.fetch = realFetch; await app.deliver();
    assert.equal(raced.size >= 1, true);
    assert.deepEqual([app.remote.google.size, app.remote.discord.size], undo ? [1, 1] : [0, 0]);
    assert.deepEqual(app.rows("SELECT g.active AS google, d.active AS discord FROM google_calendar_event_mappings g JOIN discord_calendar_event_mappings d ON d.meeting_id = g.meeting_id"), [{ google: undo ? 1 : 0, discord: undo ? 1 : 0 }]);
    if (undo) assert.deepEqual(app.rows<{ eventId: string }>("SELECT event_id AS eventId FROM discord_calendar_event_mappings").map((row) => row.eventId), [...app.remote.discord.keys()], "the mapping names the event that is left");
    assert.equal(app.count("SELECT (SELECT COUNT(*) FROM google_calendar_operations WHERE status != 'delivered') + (SELECT COUNT(*) FROM discord_calendar_operations WHERE status != 'delivered') AS n"), 0);
  });
}

test("restoring a meetings backup records the events of the meetings it removes", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  const kept = await app.request("POST", "/meetings", meetingBody(3), 201); await app.deliver();
  const backup = (await app.request("GET", "/admin/data/backup?scope=meetings")).body;
  await app.request("POST", "/meetings", meetingBody(4), 201); await app.deliver();
  assert.deepEqual([app.remote.google.size, app.remote.discord.size], [2, 2]);
  const restored = await app.request("POST", "/admin/data/restore", { scope: "meetings", confirmation: "RESTORE MEETINGS", backup });
  assert.equal(restored.body.recovery.detachedCalendarEvents, 2);
  assert.deepEqual(app.rows("SELECT provider, COUNT(*) AS n FROM calendar_event_removals GROUP BY provider ORDER BY provider"), [{ provider: "discord", n: 1 }, { provider: "google_calendar", n: 1 }]);
  await app.deliver();
  assert.deepEqual([app.remote.google.size, app.remote.discord.size], [1, 1], "the meeting in the backup keeps its events");
  assert.equal(app.count("SELECT COUNT(*) AS n FROM google_calendar_event_mappings WHERE meeting_id = ? AND active = 1", kept.body.meeting.id), 1);
});

test("Retry failed delivery only makes failed work due again, and the scheduler sends it", async (context) => {
  const app = await fixture(context, { google: true });
  seedMeetings(app, 5); await app.request("POST", "/admin/integrations/google-calendar/sync-all");
  app.db.sqlite.exec("UPDATE google_calendar_operations SET status = 'failed', attempts = 3, next_attempt_at = NULL, last_error = 'Synthetic refusal'");
  const retried = await app.request("POST", "/admin/integrations/google-calendar/retry", {});
  context.diagnostic(`Retry failed delivery: ${retried.subrequests} subrequests`);
  assert.equal(retried.outbound, 0, "nothing is sent to Google by the request"); assert.ok(retried.subrequests <= routeBudget, `Retry costs ${retried.subrequests} subrequests`);
  assert.deepEqual(retried.body, { synced: 0, queued: 5, failed: 0, waiting: 5, scheduler: "cron", perPass: 5 });
  await app.deliver(); assert.equal(app.remote.google.size, 5);
});

test("a Discord create whose closing write never ran is found again, even after the meeting is edited, not created twice", async (context) => {
  const app = await fixture(context, { discord: true });
  const created = await app.request("POST", "/meetings", meetingBody(2), 201); const id = created.body.meeting.id as string;
  // Discord creates the event, and then the slice is stopped before its closing batch: the scheduler's budget refuses it.
  const database = app.env.DB as { batch: (statements: never[]) => Promise<unknown> }; const batch = database.batch; let stopped = false;
  database.batch = (statements) => {
    if (!stopped && (statements as { sql?: string }[]).some((statement) => statement.sql?.startsWith("UPDATE discord_calendar_event_mappings SET event_id = ?"))) { stopped = true; return Promise.reject(new SchedulerBudgetError("D1 query")); }
    return batch(statements);
  };
  context.mock.method(console, "error", () => {});
  for (let slot = 0; slot < 9 && !stopped; slot += 1) await cronPass(app, slot);
  database.batch = batch;
  assert.ok(stopped); assert.equal(app.remote.discord.size, 1);
  assert.deepEqual(app.rows("SELECT status, attempts, lease_token IS NOT NULL AS claimed FROM discord_calendar_operations"), [{ status: "processing", attempts: 0, claimed: 1 }]);
  // The lease ends, and the meeting is edited before the next pass: the row is pending again, with no failed attempt on it.
  app.db.sqlite.exec("UPDATE discord_calendar_operations SET lease_expires_at = '2026-01-01T00:00:00.000Z', next_attempt_at = '2026-01-01T00:00:00.000Z'");
  await app.request("PATCH", `/meetings/${id}`, meetingBody(2, "Test Meeting edited after the stop"));
  assert.deepEqual(app.rows("SELECT status, attempts, lease_token IS NOT NULL AS claimed FROM discord_calendar_operations"), [{ status: "pending", attempts: 0, claimed: 1 }]);
  app.remote.requests.length = 0; await app.deliver();
  assert.deepEqual([...app.remote.discord.values()], [{ name: "Test Meeting edited after the stop" }], "one event, updated");
  assert.equal(app.remote.requests.some((request) => request === "discord POST"), false, "no second create");
  assert.deepEqual(app.rows("SELECT event_id AS eventId FROM discord_calendar_event_mappings").map((row) => row.eventId), [...app.remote.discord.keys()]);
});

test("migration 0103 is required: no code path tolerates a schema without it, and the architecture note says so", () => {
  for (const file of ["apps/api/src/calendar-queue.ts", "apps/api/src/index.ts", "apps/api/src/module-platform.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /missingRemovalsTable|no such table: calendar_event_removals|schema from before migration 0103|schema before 0103/, file);
  }
  assert.match(readFileSync("docs/ARCHITECTURE.md", "utf8"), /Migration `0103_calendar_queue\.sql` must be applied before this Worker runs/);
});

test("housekeeping leaves a Discord upsert that is only waiting for the 60-day horizon, and re-arming keeps it waiting", async (context) => {
  const app = await fixture(context, { discord: true });
  const ids = seedMeetings(app, 1, 100, "far"); const near = seedMeetings(app, 1, 3, "near");
  await app.request("POST", "/admin/integrations/discord/calendar/sync-all");
  const state = () => app.rows<{ meeting: string; status: string; due: string | null }>("SELECT meeting_id AS meeting, status, next_attempt_at AS due FROM discord_calendar_operations ORDER BY meeting_id");
  const horizon = new Date(startOf(100, 5).getTime() - 60 * day).toISOString();
  assert.deepEqual(state(), [{ meeting: ids[0], status: "pending", due: horizon }, { meeting: near[0], status: "pending", due: "1970-01-01T00:00:00.000Z" }]);
  // Discord is switched off: the operation that is due is settled, the one waiting for the horizon is not.
  app.db.sqlite.exec("UPDATE installations SET discord_enabled = 0"); await pruneStaleRows(app.db);
  assert.deepEqual(state(), [{ meeting: ids[0], status: "pending", due: horizon }, { meeting: near[0], status: "failed", due: null }]);
  // Re-verification makes failed operations due again: at once, or when the meeting comes within range.
  app.db.sqlite.exec("UPDATE installations SET discord_enabled = 1; UPDATE discord_calendar_operations SET status = 'failed', next_attempt_at = NULL");
  await calendarFailedRetry(app.db, "discord", new Date().toISOString()).run();
  assert.deepEqual(state(), [{ meeting: ids[0], status: "pending", due: horizon }, { meeting: near[0], status: "pending", due: "1970-01-01T00:00:00.000Z" }]);
  const sync = await app.request("POST", "/calendars/sync", { meetingId: near[0] });
  assert.equal(sync.body.providers[0].waiting, 1, "the operation waiting for the horizon is not counted as waiting to be sent");
});

test("turning an integration back on queues the edits and deletes made while it was off", async (context) => {
  const app = await fixture(context, { google: true });
  const kept = await app.request("POST", "/meetings", meetingBody(3), 201); const removed = await app.request("POST", "/meetings", meetingBody(4), 201); await app.deliver();
  await app.request("PATCH", "/admin/integrations/google-calendar", { enabled: false });
  await app.request("PATCH", `/meetings/${kept.body.meeting.id}`, meetingBody(3, "Test Meeting edited while off")); await app.request("DELETE", `/meetings/${removed.body.meeting.id}`, { scope: "occurrence" });
  assert.equal(app.count("SELECT COUNT(*) AS n FROM google_calendar_operations WHERE status != 'delivered'"), 0);
  const enabled = await app.request("PATCH", "/admin/integrations/google-calendar", { enabled: true });
  context.diagnostic(`Enable Google Calendar: ${enabled.subrequests} subrequests`);
  assert.equal(enabled.outbound, 0); assert.ok(enabled.subrequests <= routeBudget, `enabling costs ${enabled.subrequests} subrequests`);
  assert.deepEqual(app.rows("SELECT action, status FROM google_calendar_operations WHERE status != 'delivered' ORDER BY action"), [{ action: "delete", status: "pending" }, { action: "upsert", status: "pending" }]);
  await app.deliver();
  assert.deepEqual([...app.remote.google.values()], [{ summary: "Test Meeting edited while off" }]);
});

test("removals Discord was never asked for, after it refuses an operation, keep their attempts", async (context) => {
  const app = await fixture(context, { discord: true });
  seedMeetings(app, 1); await app.request("POST", "/admin/integrations/discord/calendar/sync-all");
  app.db.sqlite.exec("INSERT INTO calendar_event_removals(installation_id,provider,event_id,target,attempts,next_attempt_at,updated_at) VALUES('primary','discord','900000000000000881',NULL,0,'2026-01-01','2026-01-01'),('primary','discord','900000000000000882',NULL,0,'2026-01-01','2026-01-01')");
  // The bot may not create events: the one operation is refused, which stops the batch before its two removals are sent.
  const realFetch = globalThis.fetch; context.mock.method(console, "error", () => {}); let deletes = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/scheduled-events") && init?.method === "POST") return Response.json({ message: "Missing Permissions", code: 50013 }, { status: 403 });
    if (url.includes("/scheduled-events/") && init?.method === "DELETE") deletes += 1;
    return realFetch(input, init);
  };
  for (let slot = 0; slot < 9 && app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE status = 'failed'") === 0; slot += 1) await cronPass(app, slot);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE status = 'failed'"), 1); assert.equal(deletes, 0);
  assert.deepEqual(app.rows("SELECT attempts, last_error AS error FROM calendar_event_removals"), [{ attempts: 0, error: null }, { attempts: 0, error: null }]);
});

test("removals recorded when Attendance is disabled name their calendar and server, and a disconnect sets waiting removals aside", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  const gone = await app.request("POST", "/meetings", meetingBody(4), 201); await app.deliver();
  await app.request("DELETE", `/meetings/${gone.body.meeting.id}`, { scope: "occurrence" });
  const modules = (await app.request("GET", "/platform/modules")).body; const attendance = modules.modules.find((module: { id: string }) => module.id === "attendance");
  const disabled = await app.request("PUT", "/admin/modules", { enabled: modules.modules.filter((module: { id: string; phase: string }) => module.phase === "enabled" && module.id !== "attendance").map((module: { id: string }) => module.id), revision: modules.revision, confirmDisable: [{ moduleId: "attendance", generation: attendance.generation }] });
  context.diagnostic(`Disable Attendance: ${disabled.subrequests} subrequests`); assert.ok(disabled.subrequests <= 20, `disabling costs ${disabled.subrequests} subrequests`);
  assert.deepEqual(app.rows<{ provider: string; target: string | null }>("SELECT provider, target FROM calendar_event_removals ORDER BY provider").map((row) => [row.provider, row.provider === "discord" ? row.target : /^[0-9a-f]{32}$/.test(row.target ?? "")]), [["discord", guildId], ["google_calendar", true]]);
});

test("disconnecting a provider sets its waiting removals aside, with one audit entry, and they stop counting as waiting", async (context) => {
  const app = await fixture(context, { google: true, discord: true });
  seedMeetings(app, 1); await app.request("POST", "/admin/integrations/google-calendar/sync-all"); await app.request("POST", "/admin/integrations/discord/calendar/sync-all"); await app.deliver();
  await app.request("DELETE", "/admin/data", { scope: "attendance", confirmation: "DELETE ATTENDANCE" });
  // Google Calendar is disconnected before the removal went out.
  await app.request("DELETE", "/admin/integrations/google-calendar");
  assert.deepEqual(app.rows("SELECT provider, next_attempt_at AS due, last_error AS error FROM calendar_event_removals ORDER BY provider").map((row) => [row.provider, row.due === null, row.error]), [["discord", false, null], ["google_calendar", true, "Google Calendar was disconnected before these events could be removed."]]);
  assert.deepEqual(app.rows("SELECT target_id AS provider, json_extract(metadata_json, '$.events') AS events FROM audit_log WHERE action = 'calendar.event_removal_abandoned'"), [{ provider: "google_calendar", events: 1 }]);
  const card = ((await app.request("GET", "/admin/integrations")).body.integrations as { provider: string; pendingOperations?: number; failedOperations?: number }[]).find((item) => item.provider === "google_calendar")!;
  assert.deepEqual([card.pendingOperations, card.failedOperations], [0, 1]);
  await app.request("DELETE", "/admin/integrations/google-calendar");
  assert.equal(app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'calendar.event_removal_abandoned'"), 1, "a second disconnect has nothing left to set aside");
});
