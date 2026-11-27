// quick-check: covers apps/api/migrations/**
// Saving Discord credentials must never make LancerLogin forget the scheduled events it created (pre-stable ledger N15).
// It used to delete every event mapping and queued operation, so verifying again after a bot token reset created a second
// Discord event for every upcoming meeting, and the first ones stayed on the server with nothing linking them.
//
// Through the real Worker, a real migrated SQLite database and the real scheduler, against synthetic Discord servers:
// - credentials for the same server keep the mappings and the queue, so a token reset changes nothing on Discord;
// - credentials for another server record every event left on the old one, which is then removed there when the new
//   bot can reach it and recorded for an Admin when it cannot, without holding the new server's queue;
// - two saves at once, and a save while an event is being delivered, each end with one event per meeting.
// Synthetic data only: no request leaves the process, and every name, id and token here is made up.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import worker from "../apps/api/src/index.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { BackupDatabase, sessionSecret } from "./fixtures/backup-database.ts";
import { countingDatabase } from "./fixtures/report-query-budget.ts";
import { SchedulerBudgetError } from "../apps/api/src/scheduler-budget.ts";

const origin = "https://dashboard.example.test";
const serverA = "123456789012345678"; const serverB = "523456789012345678";
const channel = "223456789012345678"; const applicationId = "323456789012345678";
const day = 86_400_000;
const keys = generateKeyPairSync("ed25519");
const publicKey = (keys.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
const credentials = (guildId: string, botToken: string) => ({ botToken, applicationId, guildId, channelId: channel, publicKey });
type RemoteEvent = { name: string; location?: string };

async function fixture(context: TestContext) {
  const db = new BackupDatabase(); context.after(() => db.close());
  const stored = await encryptIntegration(credentials(serverA, "test-token-1"), sessionSecret);
  db.sqlite.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, verified_at, updated_at) VALUES ('discord-1', 'primary', 'discord', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(stored.ciphertext, stored.iv);
  db.sqlite.exec("UPDATE installations SET discord_enabled = 1");
  // Synthetic Discord: each server's scheduled events, which bot tokens Discord accepts, and which servers each can reach.
  const remote = {
    servers: new Map<string, Map<string, RemoteEvent>>([[serverA, new Map()], [serverB, new Map()]]),
    tokens: new Set(["test-token-1"]), reach: new Map<string, Set<string>>(), unknownServers: new Set<string>(),
    requests: [] as { method: string; server: string; event: string; token: string; status: number }[], ids: 0,
  };
  const reaches = (token: string, server: string) => remote.reach.get(token)?.has(server) ?? true;
  const originalFetch = globalThis.fetch; context.after(() => { globalThis.fetch = originalFetch; });
  for (const method of ["log", "error"] as const) context.mock.method(console, method, () => {});
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input); const method = (init?.method ?? "GET").toUpperCase();
    const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bot /, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, any> : {};
    const match = /discord\.com\/api\/v10\/guilds\/(\d+)\/scheduled-events(?:\/(\d+))?/.exec(url);
    if (match) {
      const [, server, event = ""] = match; const answer = (response: Response) => { remote.requests.push({ method, server: server!, event, token, status: response.status }); return response; };
      if (!remote.tokens.has(token)) return answer(Response.json({ message: "401: Unauthorized", code: 0 }, { status: 401 }));
      const events = remote.servers.get(server!);
      if (!events || remote.unknownServers.has(server!)) return answer(Response.json({ message: "Unknown Guild", code: 10004 }, { status: 404 }));
      if (!reaches(token, server!)) return answer(Response.json({ message: "Missing Access", code: 50001 }, { status: 403 }));
      if (!event && method === "GET") return answer(Response.json([...events].map(([id, value]) => ({ id, name: value.name, entity_metadata: { location: value.location } }))));
      if (!event) { const id = String(900000000000000000n + BigInt(remote.ids += 1)); events.set(id, { name: body.name, location: body.entity_metadata?.location }); return answer(Response.json({ id })); }
      if (!events.has(event)) return answer(Response.json({ message: "Unknown Guild Scheduled Event", code: 10070 }, { status: 404 }));
      if (method === "DELETE") { events.delete(event); return answer(new Response(null, { status: 204 })); }
      events.set(event, { name: body.name, location: body.entity_metadata?.location }); return answer(Response.json({ id: event }));
    }
    // Other scheduled jobs (commands, channel upkeep) talk to Discord too; they are not under test.
    if (url.startsWith("https://discord.com/api/v10/")) return method === "GET" ? Response.json([]) : Response.json({ id: "999999999999999999" });
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  const counted = countingDatabase(db);
  const env = { DB: counted.database, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: origin };
  const cookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" })}`;
  await worker.fetch(new Request("https://api.example.test/health"), env);
  async function request<T = Record<string, any>>(method: string, path: string, body?: unknown, expected = 200) {
    counted.start();
    const response = await worker.fetch(new Request(`https://api.example.test${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const log = counted.stop(); const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    return { body: JSON.parse(text) as T, queries: log.length };
  }
  const rows = <T = Record<string, any>>(sql: string, ...values: unknown[]) => db.sqlite.prepare(sql).all(...values as never[]).map((row) => ({ ...row })) as T[];
  const count = (sql: string, ...values: unknown[]) => Number((db.sqlite.prepare(sql).get(...values as never[]) as { n: number }).n);
  const cronPass = async (slot = 0) => { db.sqlite.exec("DELETE FROM platform_scheduler_state"); await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: slot * 300_000 } as never, env as never); };
  /** Cron passes until no calendar work is due. */
  async function deliver() {
    const due = () => { const now = new Date().toISOString(); return count("SELECT (SELECT COUNT(*) FROM discord_calendar_operations WHERE status != 'delivered' AND next_attempt_at <= ?) + (SELECT COUNT(*) FROM calendar_event_removals WHERE next_attempt_at <= ?) AS n", now, now); };
    for (let pass = 0; pass < 150 && due() > 0; pass += 1) await cronPass(pass);
    assert.equal(due(), 0, "the scheduler delivers everything that is due");
  }
  /** Saves Discord credentials as the dashboard does. The new token is the one Discord accepts from then on. */
  async function save(server: string, botToken: string, expected = 200) {
    const result = await request("PUT", "/admin/integrations/discord", credentials(server, botToken), expected);
    if (expected === 200) { remote.tokens.clear(); remote.tokens.add(botToken); }
    return result;
  }
  /** An Admin clicks the verification button in Discord: the signed interaction the Worker verifies the connection by. */
  async function verify(server: string) {
    const token = "test-verification-challenge"; const hash = createHash("sha256").update(token).digest("base64url");
    db.sqlite.prepare("INSERT OR REPLACE INTO integration_verification_challenges (installation_id, provider, challenge_hash, target, external_id, expires_at, created_by, created_at) VALUES ('primary', 'discord', ?, ?, '777777777777777777', ?, 'admin', ?)").run(hash, server, new Date(Date.now() + 600_000).toISOString(), new Date().toISOString());
    const body = JSON.stringify({ id: "1", type: 3, guild_id: server, channel_id: channel, data: { custom_id: `lancerlogin-verify:${token}` }, member: { user: { id: "888888888888888888" } }, message: { id: "777777777777777777" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await worker.fetch(new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex"), "x-signature-timestamp": timestamp }, body }), env);
    assert.equal(response.status, 200); assert.match(JSON.stringify(await response.json()), /LancerLogin is verified/);
    assert.equal(count("SELECT COUNT(*) AS n FROM encrypted_integrations WHERE provider = 'discord' AND verified_at IS NOT NULL"), 1);
  }
  const events = (server: string) => [...remote.servers.get(server)!].map(([id, event]) => `${id} ${event.name}`).sort();
  const mappings = () => rows<{ meeting: string; event: string | null; generation: number; active: number }>("SELECT meeting_id AS meeting, event_id AS event, generation, active FROM discord_calendar_event_mappings ORDER BY meeting_id");
  return { db, env, remote, request, rows, count, cronPass, deliver, save, verify, events, mappings };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const base = Math.floor(Date.now() / 60_000) * 60_000;
/** Synthetic meetings a day apart, starting `offset` days from now (negative: in the past). */
function seedMeetings(app: Fixture, total: number, offset = 0, prefix = "seed") {
  const insert = app.db.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES(?,'primary',?,?,?,1,'admin','2026-01-01')");
  const ids = Array.from({ length: total }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}`);
  ids.forEach((id, index) => { const start = base + (offset + index + 1) * day + 5 * 3_600_000; insert.run(id, `Test Meeting ${id}`, new Date(start).toISOString(), new Date(start + 3_600_000).toISOString()); });
  return ids;
}
/** Three meetings with live events on server A, a fourth whose event is still queued, and the first one's delete queued. */
async function connected(app: Fixture) {
  const ids = seedMeetings(app, 3); await app.request("POST", "/admin/integrations/discord/calendar/sync-all"); await app.deliver();
  assert.equal(app.events(serverA).length, 3);
  const [queued] = seedMeetings(app, 1, 10, "later"); await app.request("POST", "/admin/integrations/discord/calendar/sync-all");
  await app.request("DELETE", `/meetings/${ids[0]}`, { scope: "occurrence" });
  assert.deepEqual(app.rows("SELECT action, status, COUNT(*) AS n FROM discord_calendar_operations WHERE status != 'delivered' GROUP BY action, status ORDER BY action"), [{ action: "delete", status: "pending", n: 1 }, { action: "upsert", status: "pending", n: 3 }]);
  return { ids, queued: queued!, before: app.events(serverA) };
}
const posts = (app: Fixture, server?: string) => app.remote.requests.filter((request) => request.method === "POST" && (!server || request.server === server)).length;

test("a token reset for the same server keeps every mapping and queued operation: verifying again creates no second event", async (context) => {
  const app = await fixture(context); const { ids, queued, before } = await connected(app);
  const mapped = app.mappings(); const operations = app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations"); app.remote.requests.length = 0;

  const saved = await app.save(serverA, "test-token-2");
  assert.deepEqual({ ...saved.body, updatedAt: undefined }, { saved: true, configured: false, created: false, provider: "discord", state: "verification_required", updatedAt: undefined });
  assert.ok(saved.queries <= 8, `the save costs ${saved.queries} D1 queries`);
  assert.deepEqual(app.mappings(), mapped, "the mappings are as they were"); assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations"), operations, "and so is the queue");
  assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
  assert.deepEqual(app.rows("SELECT json_extract(metadata_json, '$.calendar') AS calendar FROM audit_log WHERE action = 'integration.rotated'"), [{ calendar: "kept" }]);

  // Until an Admin verifies again nothing is sent, and nothing that was queued is lost.
  for (let slot = 0; slot < 3; slot += 1) await app.cronPass(slot);
  assert.deepEqual(app.remote.requests, [], "an unverified connection sends nothing"); assert.deepEqual(app.events(serverA), before);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE status != 'delivered'"), 4, "the queued delete and upserts are still there");

  await app.verify(serverA); await app.deliver();
  assert.equal(posts(app), 1, "only the meeting that had no event yet is created");
  assert.ok(app.remote.requests.every((request) => request.token === "test-token-2" && request.status < 400), "everything went out with the new token and was accepted");
  const after = app.events(serverA);
  assert.deepEqual(after.filter((event) => !event.endsWith(queued)), before.filter((event) => !event.endsWith(ids[0]!)), "the two live events are the same events, and the deleted meeting's event is gone");
  assert.deepEqual(after.map((event) => event.split(" ").slice(1).join(" ")).sort(), [`Test Meeting ${ids[1]}`, `Test Meeting ${ids[2]}`, `Test Meeting ${queued}`].sort(), "one event for each live meeting, none twice");
  assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE status != 'delivered'"), 0);
  // A second reset, and a second verification, change nothing either.
  app.remote.requests.length = 0; await app.save(serverA, "test-token-3"); await app.verify(serverA); await app.deliver();
  assert.equal(posts(app), 0); assert.deepEqual(app.events(serverA), after);
});

test("credentials for another server record every event left on the old one, and the same bot then removes them there", async (context) => {
  const app = await fixture(context); const { ids, queued } = await connected(app);
  // A meeting that is over keeps its mapping, but its event is over too and is not recorded. A removal that was waiting
  // with no server recorded belongs to the server being left.
  const [past] = seedMeetings(app, 1, -30, "past");
  app.db.sqlite.prepare("INSERT INTO discord_calendar_event_mappings (installation_id, meeting_id, event_id, generation, active, updated_at) VALUES ('primary', ?, '900000000000000555', 1, 1, '2026-01-01')").run(past);
  app.remote.servers.get(serverA)!.set("900000000000000777", { name: "Test Meeting removed earlier" });
  app.db.sqlite.exec("INSERT INTO calendar_event_removals(installation_id,provider,event_id,target,attempts,next_attempt_at,updated_at) VALUES('primary','discord','900000000000000777',NULL,0,'2026-01-01','2026-01-01')");
  const left = app.events(serverA).map((event) => event.split(" ")[0]!).sort(); assert.equal(left.length, 4); app.remote.requests.length = 0;

  const saved = await app.save(serverB, "test-token-1");
  assert.deepEqual([saved.body.serverChanged, saved.body.previousServerEvents, saved.body.state], [true, 3, "verification_required"]);
  assert.equal(JSON.stringify(saved.body).includes(serverA), false, "the response names no server id");
  assert.ok(saved.queries <= 8, `the save costs ${saved.queries} D1 queries`);
  assert.deepEqual(app.rows("SELECT event_id AS event, target, attempts FROM calendar_event_removals ORDER BY event_id"), left.map((event) => ({ event, target: serverA, attempts: 0 })), "each event still on the old server is recorded under that server, once");
  assert.equal(app.count("SELECT (SELECT COUNT(*) FROM discord_calendar_event_mappings) + (SELECT COUNT(*) FROM discord_calendar_operations) + (SELECT COUNT(*) FROM integration_state WHERE provider = 'discord' AND state_key LIKE 'calendar:%') AS n"), 0, "the old server's mappings and queue are gone");
  assert.deepEqual(app.rows("SELECT json_extract(metadata_json, '$.calendar') AS calendar, json_extract(metadata_json, '$.eventsRecordedForRemoval') AS events FROM audit_log WHERE action = 'integration.rotated'"), [{ calendar: "server_changed", events: 3 }]);
  const card = async () => ((await app.request("GET", "/admin/integrations")).body.integrations as { provider: string; pendingOperations?: number }[]).find((item) => item.provider === "discord")!;
  assert.equal((await card()).pendingOperations, 4, "the card counts them as waiting");

  for (let slot = 0; slot < 3; slot += 1) await app.cronPass(slot);
  assert.deepEqual(app.remote.requests, [], "nothing is sent before the new server is verified");
  await app.verify(serverB); await app.deliver();
  assert.deepEqual(app.events(serverA), [], "the old server's events are removed from the old server");
  assert.deepEqual(app.events(serverB).map((event) => event.split(" ").slice(1).join(" ")).sort(), [`Test Meeting ${ids[1]}`, `Test Meeting ${ids[2]}`, `Test Meeting ${queued}`].sort(), "the new server has one event for each live meeting");
  assert.ok(app.remote.requests.filter((request) => request.method === "DELETE").every((request) => request.server === serverA), "no removal was sent to the new server");
  assert.deepEqual([app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'calendar.event_removal_abandoned'")], [0, 0]);
});

for (const refusal of ["the new bot is not allowed on the old server", "Discord no longer knows the old server"] as const) {
  test(`when ${refusal}, its events are recorded for an Admin and the new server's queue is not held`, async (context) => {
    const app = await fixture(context); const { before } = await connected(app);
    await app.save(serverB, "test-token-other-bot");
    if (refusal.startsWith("the new bot")) app.remote.reach.set("test-token-other-bot", new Set([serverB])); else app.remote.unknownServers.add(serverA);
    app.remote.requests.length = 0; await app.verify(serverB); await app.deliver();
    assert.equal(app.events(serverB).length, 3, "the new server gets its events in the same rounds: a refusal on the old server holds nothing");
    assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE status != 'delivered'"), 0);
    assert.equal(app.remote.requests.filter((request) => request.server === serverA).length, 3, "each old event was asked for once");
    assert.deepEqual(app.events(serverA), before, "the old server's events could not be removed");
    assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
    assert.deepEqual(app.rows<{ server: string; event: string }>("SELECT json_extract(metadata_json, '$.serverId') AS server, json_extract(metadata_json, '$.eventId') AS event FROM audit_log WHERE action = 'calendar.event_removal_abandoned' ORDER BY event").map((row) => `${row.server} ${row.event}`), before.map((event) => `${serverA} ${event.split(" ")[0]}`), "the audit log names each event and the server it is on");
  });
}

test("a rejected token while removing another server's events is the bot's own trouble: the removals wait and are tried again", async (context) => {
  const app = await fixture(context); await connected(app);
  await app.save(serverB, "test-token-2"); await app.verify(serverB);
  app.remote.tokens.clear(); await app.cronPass();
  assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 3, "no removal is given up because the token was rejected");
  assert.equal(app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'calendar.event_removal_abandoned'"), 0);
  app.remote.tokens.add("test-token-2"); await app.request("POST", "/admin/integrations/discord/calendar/retry", {}); await app.deliver();
  assert.deepEqual([app.events(serverA).length, app.events(serverB).length, app.count("SELECT COUNT(*) AS n FROM calendar_event_removals")], [0, 3, 0]);
});

/** A save whose request body arrives only after `during` has run: by then the route has read the stored credentials. */
async function saveWhile(app: Fixture, server: string, botToken: string, during: () => Promise<unknown>) {
  const cookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" })}`;
  const bytes = new TextEncoder().encode(JSON.stringify(credentials(server, botToken))); let ran = false;
  const body = new ReadableStream<Uint8Array>({ async pull(controller) { if (!ran) { ran = true; await during(); } controller.enqueue(bytes); controller.close(); } });
  const response = await worker.fetch(new Request("https://api.example.test/admin/integrations/discord", { method: "PUT", headers: { cookie, origin, "content-type": "application/json" }, body, duplex: "half" } as RequestInit), app.env);
  assert.ok(ran, "the other request ran while this one was in flight");
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test("two saves at once: a token reset that loses to a change of server deletes and records nothing twice", async (context) => {
  const app = await fixture(context); await connected(app);
  // The reset read the old credentials (server A, so it would keep everything); the change of server lands first.
  const reset = await saveWhile(app, serverA, "test-token-reset", () => app.save(serverB, "test-token-2"));
  assert.equal(reset.status, 409); assert.match(reset.body.error, /changed by another request/);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'integration.rotated'"), 1, "the save that lost wrote nothing");
  assert.deepEqual(app.rows("SELECT DISTINCT target FROM calendar_event_removals"), [{ target: serverA }]); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 3);
  await app.verify(serverB); await app.deliver();
  assert.deepEqual([app.events(serverA).length, app.events(serverB).length], [0, 3], "server B's credentials won: one event per live meeting there, none left on A");
});

test("two saves at once: a change of server that loses to a token reset forgets nothing", async (context) => {
  const app = await fixture(context); const { before } = await connected(app); const mapped = app.mappings();
  // The change of server read the old credentials (so it would record and delete); the token reset lands first.
  const change = await saveWhile(app, serverB, "test-token-b", () => app.save(serverA, "test-token-2"));
  assert.equal(change.status, 409);
  assert.deepEqual(app.mappings(), mapped, "the mappings the reset kept are still there"); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0, "and no live event is recorded for removal");
  assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE status != 'delivered'"), 4);
  app.remote.requests.length = 0; await app.verify(serverA); await app.deliver();
  assert.equal(posts(app), 1, "only the meeting with no event yet is created"); assert.equal(app.events(serverA).length, 3);
  assert.deepEqual(app.events(serverA).filter((event) => before.includes(event)).length, 2, "the two live events are the ones that were there");
  // Saved again, the change of server now goes through, from the credentials that are stored.
  const again = await app.save(serverB, "test-token-b"); assert.equal(again.body.previousServerEvents, 3);
});

test("two saves at once for the same new server record the old server's events once", async (context) => {
  const app = await fixture(context); await connected(app);
  const second = await saveWhile(app, serverB, "test-token-b2", () => app.save(serverB, "test-token-b1"));
  assert.equal(second.status, 409); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals WHERE target = ?", serverA), 3);
  assert.deepEqual(app.rows("SELECT json_extract(metadata_json, '$.eventsRecordedForRemoval') AS events FROM audit_log WHERE action = 'integration.rotated'"), [{ events: 3 }]);
});

/** Runs `during` once, while Discord is answering the first request that creates an event. */
function whileCreating(app: Fixture, during: () => Promise<unknown>) {
  const mocked = globalThis.fetch; let raced = false;
  globalThis.fetch = async (input, init) => {
    const response = await mocked(input, init);
    if (!raced && /\/scheduled-events$/.test(String(input)) && init?.method === "POST") { raced = true; await during(); }
    return response;
  };
  return { raced: () => raced, restore: () => { globalThis.fetch = mocked; } };
}

test("a token reset saved while an event is being created keeps that event linked: it is not created again", async (context) => {
  const app = await fixture(context); const [meeting] = seedMeetings(app, 1); await app.request("POST", "/admin/integrations/discord/calendar/sync-all");
  const race = whileCreating(app, () => app.save(serverA, "test-token-2"));
  await app.cronPass(); race.restore(); assert.ok(race.raced());
  const [event] = app.events(serverA); assert.ok(event, "Discord created the event");
  assert.deepEqual(app.mappings(), [{ meeting, event: event!.split(" ")[0], generation: 1, active: 1 }], "the delivery recorded its event on the mapping the save kept");
  assert.deepEqual(app.rows("SELECT action, status FROM discord_calendar_operations"), [{ action: "upsert", status: "delivered" }]);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
  app.remote.requests.length = 0; await app.verify(serverA); await app.deliver();
  assert.equal(posts(app), 0, "verifying again updates the event, it does not create another"); assert.deepEqual(app.events(serverA), [event]);
});

test("a change of server saved while an event is being created records that event too, and it is removed from the old server", async (context) => {
  const app = await fixture(context); seedMeetings(app, 1); await app.request("POST", "/admin/integrations/discord/calendar/sync-all");
  const race = whileCreating(app, async () => { const saved = await app.save(serverB, "test-token-1"); assert.equal(saved.body.previousServerEvents, 0, "the save cannot know of an event that has no id yet"); });
  await app.cronPass(); race.restore(); assert.ok(race.raced());
  const [event] = app.events(serverA); assert.ok(event, "Discord created the event on the old server");
  assert.deepEqual(app.rows("SELECT event_id AS event, target FROM calendar_event_removals"), [{ event: event!.split(" ")[0], target: serverA }], "the delivery records the event it can no longer link, under the server it is on");
  await app.verify(serverB); await app.deliver();
  assert.deepEqual([app.events(serverA).length, app.events(serverB).length, app.count("SELECT COUNT(*) AS n FROM calendar_event_removals")], [0, 1, 0]);
});

test("a token reset saved after a delivery read the old token: Discord refuses it, the operation waits, and one event is created", async (context) => {
  const app = await fixture(context); const [meeting] = seedMeetings(app, 1); await app.request("POST", "/admin/integrations/discord/calendar/sync-all");
  // The delivery already holds the old configuration when the token is reset: Discord answers 401 to its request.
  const mocked = globalThis.fetch; let raced = false;
  globalThis.fetch = async (input, init) => { if (!raced && /\/scheduled-events$/.test(String(input)) && init?.method === "POST") { raced = true; await app.save(serverA, "test-token-2"); } return mocked(input, init); };
  await app.cronPass(); globalThis.fetch = mocked; assert.ok(raced);
  assert.deepEqual(app.events(serverA), [], "nothing was created with the old token");
  assert.deepEqual(app.rows("SELECT action, status, next_attempt_at IS NOT NULL AS retried FROM discord_calendar_operations"), [{ action: "upsert", status: "failed", retried: 1 }], "the operation is kept for another attempt");
  await app.verify(serverA); await app.deliver();
  assert.deepEqual(app.events(serverA).map((event) => event.split(" ").slice(1).join(" ")), [`Test Meeting ${meeting}`]); assert.equal(posts(app, serverA), 2, "one refused attempt and one creation");
});

test("replacing credentials that cannot be read keeps the mappings, as for the same server", async (context) => {
  const app = await fixture(context); const { before } = await connected(app); const mapped = app.mappings();
  // The stored value no longer decrypts (the integration key was replaced, say), so it names no server.
  app.db.sqlite.exec("UPDATE encrypted_integrations SET ciphertext = substr(ciphertext, 1, 20) || 'AAAA' || substr(ciphertext, 25) WHERE provider = 'discord'");
  const saved = await app.save(serverA, "test-token-2"); assert.equal("serverChanged" in saved.body, false);
  assert.deepEqual(app.mappings(), mapped); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
  assert.deepEqual(app.rows("SELECT json_extract(metadata_json, '$.calendar') AS calendar FROM audit_log WHERE action = 'integration.rotated'"), [{ calendar: "kept_server_unknown" }]);
  app.remote.requests.length = 0; await app.verify(serverA); await app.deliver();
  assert.equal(posts(app), 1, "only the meeting with no event yet is created"); assert.equal(app.events(serverA).filter((event) => before.includes(event)).length, 2);
});

test("the first save of Discord credentials has nothing to keep or record, and a save racing it is refused", async (context) => {
  const app = await fixture(context); app.db.sqlite.exec("DELETE FROM encrypted_integrations WHERE provider = 'discord'");
  const second = await saveWhile(app, serverA, "test-token-b", async () => { const first = await app.save(serverA, "test-token-a"); assert.deepEqual([first.body.created, "serverChanged" in first.body], [true, false]); });
  assert.equal(second.status, 409);
  assert.deepEqual(app.rows("SELECT action, metadata_json AS metadata FROM audit_log WHERE action LIKE 'integration.%'"), [{ action: "integration.saved", metadata: "{}" }]);
});

// Coming back to a server that was left: its events are linked again, not removed and created a second time.
const calls = (app: Fixture, server: string) => app.remote.requests.filter((request) => request.server === server).map((request) => request.method).sort().join(" ");
/** Three meetings with live events on server A; the second was deleted and restored, so its mapping is on generation 2. */
async function threeLive(app: Fixture) {
  const ids = seedMeetings(app, 3); await app.request("POST", "/admin/integrations/discord/calendar/sync-all"); await app.deliver();
  const deleted = await app.request("DELETE", `/meetings/${ids[1]}`, { scope: "occurrence" });
  await app.request("POST", `/meetings/${ids[1]}/restore`, { scope: "occurrence", deletion: deleted.body.deletion }); await app.deliver();
  const mapped = app.mappings(); assert.deepEqual(mapped.map((mapping) => [mapping.generation, mapping.active, mapping.event !== null]), [[1, 1, true], [2, 1, true], [1, 1, true]]);
  app.remote.requests.length = 0;
  return { ids, mapped, before: app.events(serverA) };
}

test("a mistyped server corrected (A, then B never verified, then A again) updates A's events where they are: nothing is deleted or created", async (context) => {
  const app = await fixture(context); const { mapped, before } = await threeLive(app);
  const away = await app.save(serverB, "test-token-1"); assert.equal(away.body.previousServerEvents, 3);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals WHERE target = ?", serverA), 3);
  const back = await app.save(serverA, "test-token-1");
  assert.deepEqual([back.body.serverChanged, back.body.previousServerEvents], [true, 0], "server B had no events to leave behind");
  assert.ok(back.queries <= 8, `the save costs ${back.queries} D1 queries`);
  assert.deepEqual(app.mappings(), mapped, "each meeting has its event and generation again");
  assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0, "and no event of server A is waiting to be removed");
  assert.equal(app.count("SELECT COUNT(*) AS n FROM integration_state WHERE provider = 'discord' AND state_key LIKE 'calendar-left:%'"), 0, "nothing stays remembered for a server that is connected");
  assert.deepEqual(app.rows("SELECT json_extract(metadata_json, '$.eventsRestored') AS restored FROM audit_log WHERE action = 'integration.rotated' ORDER BY created_at, rowid"), [{ restored: 0 }, { restored: 3 }]);
  await app.verify(serverA); await app.deliver();
  assert.equal(calls(app, serverA), "PATCH PATCH PATCH", "Discord sees an update of each event, no DELETE and no POST");
  assert.deepEqual(app.events(serverA), before, "the same three events"); assert.deepEqual(app.events(serverB), []);
  assert.deepEqual(app.mappings(), mapped);
});

test("coming back to a server keeps the event of a meeting that is in progress", async (context) => {
  const app = await fixture(context); const { ids, before } = await threeLive(app);
  // The first meeting has started: Discord cannot be given a new event for it, so its event must not be removed.
  app.db.sqlite.prepare("UPDATE meetings SET starts_at = ?, ends_at = ? WHERE id = ?").run(new Date(Date.now() - 30 * 60_000).toISOString(), new Date(Date.now() + 30 * 60_000).toISOString(), ids[0]);
  await app.save(serverB, "test-token-1"); await app.save(serverA, "test-token-2"); await app.verify(serverA); await app.deliver();
  assert.equal(calls(app, serverA), "PATCH PATCH PATCH", "the meeting in progress is updated like the others: no DELETE, no POST");
  assert.deepEqual(app.events(serverA), before); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE status != 'delivered'"), 0);
});

test("a move to another server that is undone (A, then B verified with its own events, then A again) keeps A's events and removes B's", async (context) => {
  const app = await fixture(context); const { ids, mapped, before } = await threeLive(app);
  await app.save(serverB, "test-token-1"); await app.verify(serverB);
  // Only the creates on B have gone out when the move is undone: the removals of A's events were still waiting.
  await app.cronPass(); assert.equal(app.events(serverB).length, 3); assert.equal(calls(app, serverA), "", "nothing was sent to server A yet");
  const back = await app.save(serverA, "test-token-1"); assert.equal(back.body.previousServerEvents, 3, "server B's three events are the ones left behind now");
  assert.deepEqual(app.mappings(), mapped, "server A's events are mapped again");
  assert.deepEqual(app.rows("SELECT DISTINCT target FROM calendar_event_removals"), [{ target: serverB }]);
  app.remote.requests.length = 0; await app.verify(serverA); await app.deliver();
  assert.equal(calls(app, serverA), "PATCH PATCH PATCH", "no DELETE and no POST on server A"); assert.deepEqual(app.events(serverA), before);
  assert.equal(calls(app, serverB), "DELETE DELETE DELETE"); assert.deepEqual(app.events(serverB), []);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
  // A meeting deleted outright while away is not mapped again, and its event is still removed.
  await app.save(serverB, "test-token-1"); app.db.sqlite.prepare("DELETE FROM meetings WHERE id = ?").run(ids[2]);
  await app.save(serverA, "test-token-1"); assert.equal(app.mappings().length, 2);
  assert.deepEqual(app.rows("SELECT event_id AS event FROM calendar_event_removals WHERE target = ?", serverA), [{ event: mapped[2]!.event }]);
  await app.verify(serverA); await app.deliver(); assert.equal(app.events(serverA).length, 2); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
});

test("events of a server that was left and have since been removed there are created again on coming back, once", async (context) => {
  const app = await fixture(context); await threeLive(app);
  await app.save(serverB, "test-token-1"); await app.verify(serverB); await app.deliver();
  assert.deepEqual([app.events(serverA).length, app.events(serverB).length], [0, 3], "the move finished: A's events are gone");
  await app.save(serverA, "test-token-1"); await app.verify(serverA); await app.deliver();
  assert.deepEqual([app.events(serverA).length, app.events(serverB).length], [3, 0], "A has one event per meeting again, and B's are removed");
  assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE status != 'delivered'"), 0);
});

test("an event created on A while the server was being changed is linked again when A comes back", async (context) => {
  const app = await fixture(context); const [meeting] = seedMeetings(app, 1); await app.request("POST", "/admin/integrations/discord/calendar/sync-all");
  const race = whileCreating(app, () => app.save(serverB, "test-token-1")); await app.cronPass(); race.restore(); assert.ok(race.raced());
  const [event] = app.events(serverA); assert.ok(event); app.remote.requests.length = 0;
  await app.save(serverA, "test-token-1");
  assert.deepEqual(app.mappings(), [{ meeting, event: event!.split(" ")[0], generation: 1, active: 1 }]); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
  await app.verify(serverA); await app.deliver();
  assert.equal(calls(app, serverA), "PATCH"); assert.deepEqual(app.events(serverA), [event]);
});


// With the unreadable-credentials handling of ledger N16 merged in.
test("saved Discord credentials that cannot be read are replaced without losing the calendar, unless the encryption key itself is unusable", async (context) => {
  const app = await fixture(context); const { mapped } = await threeLive(app);
  app.db.sqlite.exec("UPDATE encrypted_integrations SET ciphertext = substr(ciphertext, 1, 20) || 'AAAA' || substr(ciphertext, 25) WHERE provider = 'discord'");
  const card = ((await app.request("GET", "/admin/integrations")).body.integrations as { provider: string; state: string }[]).find((item) => item.provider === "discord")!;
  assert.equal(card.state, "unreadable");
  // A key of the wrong size is refused before anything is read or written.
  const cookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" })}`;
  const refused = await worker.fetch(new Request("https://api.example.test/admin/integrations/discord", { method: "PUT", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(credentials(serverA, "test-token-2")) }), { ...app.env, INTEGRATION_KEY: "too-short" });
  assert.equal(refused.status, 503); assert.match(((await refused.json()) as { error: string }).error, /INTEGRATION_KEY must be 32 random bytes/);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'integration.%'"), 0); assert.deepEqual(app.mappings(), mapped);
  // With a usable key the save goes through: the unreadable value is replaced and the mappings are kept.
  const saved = await app.save(serverA, "test-token-2"); assert.deepEqual([saved.body.saved, saved.body.created, "serverChanged" in saved.body], [true, false, false]);
  assert.deepEqual(app.rows("SELECT json_extract(metadata_json, '$.calendar') AS calendar FROM audit_log WHERE action = 'integration.rotated'"), [{ calendar: "kept_server_unknown" }]);
  assert.deepEqual(app.mappings(), mapped); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
  await app.verify(serverA); await app.deliver(); assert.equal(calls(app, serverA), "PATCH PATCH PATCH");
});

test("unreadable credentials replaced by ones for another server: its events are created there, and the old server's are left behind", async (context) => {
  const app = await fixture(context); const { ids, before } = await connected(app);
  app.db.sqlite.exec("UPDATE encrypted_integrations SET ciphertext = substr(ciphertext, 1, 20) || 'AAAA' || substr(ciphertext, 25) WHERE provider = 'discord'");
  // Nothing names the old server, so the save cannot tell that this one is different.
  const saved = await app.save(serverB, "test-token-2"); assert.equal("serverChanged" in saved.body, false);
  assert.deepEqual(app.rows("SELECT json_extract(metadata_json, '$.calendar') AS calendar FROM audit_log WHERE action = 'integration.rotated'"), [{ calendar: "kept_server_unknown" }]);
  app.remote.requests.length = 0; await app.verify(serverB); await app.deliver();
  assert.deepEqual(app.events(serverB).map((event) => event.split(" ").slice(1).join(" ")).sort(), [`Test Meeting ${ids[1]}`, `Test Meeting ${ids[2]}`, "Test Meeting later-000"].sort(), "each live meeting gets one event on the new server, as its old event id is not found there");
  assert.equal(app.remote.requests.filter((request) => request.server === serverB && request.method === "DELETE" && request.status === 404).length, 1, "the queued delete finds no such event on the new server and is done");
  assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE status != 'delivered'"), 0);
  assert.equal(calls(app, serverA), "", "nothing is sent to the server nobody could name"); assert.deepEqual(app.events(serverA), before, "its events stay where they are");
  assert.deepEqual([app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'calendar.event_removal_abandoned'")], [0, 0], "and the audit entry of the save is the only record of them");
});

// Removing the connection leaves the server like a change of server does: nothing is forgotten (third review round).
const leftRows = (app: Fixture) => app.count("SELECT COUNT(*) AS n FROM integration_state WHERE provider = 'discord' AND state_key LIKE 'calendar-left:%'");
const inProgress = (app: Fixture, meeting: string) => app.db.sqlite.prepare("UPDATE meetings SET starts_at = ?, ends_at = ? WHERE id = ?").run(new Date(Date.now() - 30 * 60_000).toISOString(), new Date(Date.now() + 30 * 60_000).toISOString(), meeting);
/** Sets Discord up again after it was removed: credentials, the switch, verification, delivery, then Sync all and delivery again. */
async function setUpAgain(app: Fixture, server: string, botToken = "test-token-1") {
  const saved = await app.save(server, botToken); await app.request("PATCH", "/admin/integrations/discord", { enabled: true });
  await app.verify(server); await app.deliver();
  await app.request("POST", "/admin/integrations/discord/calendar/sync-all"); await app.deliver();
  return saved;
}

for (const path of ["removed and set up again", "pointed at a mistyped server, removed, and set up again"] as const) {
  test(`Discord ${path} for the same server: its events are linked again, none is deleted or created, a meeting in progress included`, async (context) => {
    const app = await fixture(context); const { ids, mapped, before } = await threeLive(app); inProgress(app, ids[0]!);
    if (path.startsWith("pointed")) await app.save(serverB, "test-token-1");
    const removed = await app.request("DELETE", "/admin/integrations/discord");
    assert.ok(removed.queries <= 8, `removing costs ${removed.queries} D1 queries`);
    assert.equal(app.count("SELECT COUNT(*) AS n FROM discord_calendar_event_mappings"), 0); assert.equal(leftRows(app), 3, "each live event is remembered with its meeting");
    assert.deepEqual(app.rows("SELECT target, next_attempt_at AS due, COUNT(*) AS n FROM calendar_event_removals GROUP BY target, next_attempt_at"), [{ target: serverA, due: null, n: 3 }], "and recorded under its server, set aside while nothing is connected");
    const saved = await setUpAgain(app, serverA);
    assert.deepEqual([saved.body.created, "serverChanged" in saved.body], [true, false]); assert.ok(saved.queries <= 8, `the save costs ${saved.queries} D1 queries`);
    assert.equal(calls(app, serverA), "PATCH PATCH PATCH PATCH PATCH PATCH", "verifying and Sync all each update the three events: no DELETE, no POST");
    assert.deepEqual(app.events(serverA), before, "the same three events, the meeting in progress included"); assert.deepEqual(app.events(serverB), []);
    assert.deepEqual(app.mappings(), mapped); assert.deepEqual([app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), leftRows(app)], [0, 0]);
  });
}

test("Discord removed and set up for a different server is a change of server: the old server's events are removed there, not forgotten", async (context) => {
  const app = await fixture(context); const { ids } = await threeLive(app); inProgress(app, ids[0]!);
  await app.request("DELETE", "/admin/integrations/discord");
  const saved = await setUpAgain(app, serverB);
  assert.deepEqual([saved.body.created, saved.body.serverChanged, saved.body.previousServerEvents], [true, true, 3]);
  assert.deepEqual(app.rows("SELECT json_extract(metadata_json, '$.calendar') AS calendar, json_extract(metadata_json, '$.eventsRecordedForRemoval') AS events FROM audit_log WHERE action = 'integration.saved'"), [{ calendar: "server_connected", events: 3 }]);
  assert.equal(calls(app, serverA), "DELETE DELETE DELETE"); assert.deepEqual(app.events(serverA), []);
  assert.deepEqual(app.events(serverB).map((event) => event.split(" ").slice(1).join(" ")).sort(), [`Test Meeting ${ids[1]}`, `Test Meeting ${ids[2]}`].sort(), "one event for each meeting Discord can still schedule, none twice");
  assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
  // Coming back to A afterwards finds its events gone and creates them once.
  await app.save(serverA, "test-token-1"); await app.verify(serverA); await app.deliver();
  assert.deepEqual([app.events(serverA).length, app.events(serverB).length], [2, 0]);
});

test("removing Discord costs the same for a hundred upcoming meetings, and so does setting it up again", async (context) => {
  const app = await fixture(context); const ids = seedMeetings(app, 100);
  const insert = app.db.sqlite.prepare("INSERT INTO discord_calendar_event_mappings (installation_id, meeting_id, event_id, generation, active, synced_at, updated_at) VALUES ('primary', ?, ?, 1, 1, '2026-01-01', '2026-01-01')");
  ids.forEach((id, index) => { const event = String(800000000000000000n + BigInt(index)); insert.run(id, event); app.remote.servers.get(serverA)!.set(event, { name: `Test Meeting ${id}` }); });
  const removed = await app.request("DELETE", "/admin/integrations/discord"); const saved = await app.save(serverA, "test-token-1");
  context.diagnostic(`100 meetings: remove ${removed.queries} D1 queries, save ${saved.queries}`);
  assert.ok(removed.queries <= 8 && saved.queries <= 8, `remove ${removed.queries}, save ${saved.queries}`);
  assert.deepEqual([app.count("SELECT COUNT(*) AS n FROM discord_calendar_event_mappings WHERE event_id IS NOT NULL"), app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), leftRows(app)], [100, 0, 0]);
});

test("a server that comes back while its removals are being sent keeps every event not yet sent, and a meeting in progress is not left with a dead event", async (context) => {
  const app = await fixture(context); const { ids, mapped } = await threeLive(app);
  await app.save(serverB, "test-token-1"); await app.verify(serverB); await app.cronPass(); assert.equal(app.events(serverA).length, 3, "the first round only created B's events");
  // The removals of A's events are due; the first meeting has started meanwhile, and its removal goes first.
  inProgress(app, ids[0]!); app.db.sqlite.prepare("UPDATE calendar_event_removals SET next_attempt_at = '2026-01-01T00:00:00.000Z' WHERE event_id = ?").run(mapped[0]!.event);
  app.remote.requests.length = 0;
  // The job has read all three removals when credentials for A are saved again, while Discord answers the first DELETE.
  const mocked = globalThis.fetch; let raced = false;
  globalThis.fetch = async (input, init) => { const response = await mocked(input, init); if (!raced && init?.method === "DELETE" && String(input).includes(`/guilds/${serverA}/`)) { raced = true; await app.save(serverA, "test-token-1"); } return response; };
  await app.cronPass(1); globalThis.fetch = mocked; assert.ok(raced);
  assert.equal(calls(app, serverA), "DELETE", "only the removal already sent went out: the other two were cancelled by the save and are not sent");
  assert.equal(app.events(serverA).length, 2); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals WHERE target = ?", serverA), 0);
  app.remote.requests.length = 0; await app.verify(serverA); await app.deliver();
  assert.deepEqual(calls(app, serverA).split(" ").filter((method) => method === "DELETE" || method === "POST"), [], "nothing more is deleted, and the meeting in progress cannot be given a new event");
  const [first, second, third] = app.mappings();
  assert.deepEqual([second, third], [mapped[1], mapped[2]], "the two events that were kept are linked as before");
  assert.deepEqual([first!.event, first!.active], [null, 1], "the meeting in progress has no event, and its mapping does not keep the id of the one that is gone");
  assert.match(app.rows<{ error: string }>("SELECT last_error AS error FROM discord_calendar_event_mappings WHERE meeting_id = ?", ids[0])[0]!.error, /removed on Discord after the meeting started/);
});

test("a removal that Discord fails keeps its row, with the attempt it made", async (context) => {
  const app = await fixture(context); await threeLive(app);
  await app.save(serverB, "test-token-1"); await app.verify(serverB); await app.cronPass(); app.remote.requests.length = 0;
  const mocked = globalThis.fetch; globalThis.fetch = async (input, init) => init?.method === "DELETE" && String(input).includes(`/guilds/${serverA}/`) ? Response.json({ message: "Internal Server Error" }, { status: 500 }) : mocked(input, init);
  await app.cronPass(1); globalThis.fetch = mocked;
  assert.deepEqual(app.rows("SELECT target, attempts, next_attempt_at IS NOT NULL AS due, last_error IS NOT NULL AS failed FROM calendar_event_removals"), Array.from({ length: 3 }, () => ({ target: serverA, attempts: 1, due: 1, failed: 1 })));
  await app.request("POST", "/admin/integrations/discord/calendar/sync-all"); app.db.sqlite.exec("UPDATE calendar_event_removals SET next_attempt_at = '2026-01-01T00:00:00.000Z'"); await app.deliver();
  assert.deepEqual([app.events(serverA).length, app.count("SELECT COUNT(*) AS n FROM calendar_event_removals")], [0, 0]);
});

test("an event whose creation on A finishes after the server was changed and changed back is linked to its meeting, not recorded for removal", async (context) => {
  const app = await fixture(context); const [meeting] = seedMeetings(app, 1); await app.request("POST", "/admin/integrations/discord/calendar/sync-all");
  const race = whileCreating(app, async () => { await app.save(serverB, "test-token-1"); await app.save(serverA, "test-token-1"); });
  await app.cronPass(); race.restore(); assert.ok(race.raced());
  const [event] = app.events(serverA); assert.ok(event);
  assert.deepEqual(app.mappings(), [{ meeting, event: event!.split(" ")[0], generation: 1, active: 1 }], "the event is the meeting's");
  assert.deepEqual([app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), leftRows(app)], [0, 0], "nothing is recorded for removal or remembered for a server that is connected");
  app.remote.requests.length = 0; await app.verify(serverA); await app.deliver();
  assert.equal(calls(app, serverA), "PATCH", "verifying updates it: no second event, no DELETE"); assert.deepEqual(app.events(serverA), [event]);
});

test("a meeting deleted while another server was connected has its event removed when the server comes back, and the others are kept", async (context) => {
  const app = await fixture(context); const { ids, mapped, before } = await threeLive(app);
  await app.save(serverB, "test-token-1"); await app.request("DELETE", `/meetings/${ids[2]}`, { scope: "occurrence" });
  await app.save(serverA, "test-token-1"); await app.verify(serverA); await app.deliver();
  assert.equal(calls(app, serverA), "DELETE PATCH PATCH", "the deleted meeting's event is removed, the two live ones are updated");
  assert.deepEqual(app.events(serverA), before.filter((event) => !event.startsWith(mapped[2]!.event!)));
  assert.deepEqual(app.mappings().map((mapping) => [mapping.meeting, mapping.event, mapping.active]), [[ids[0], mapped[0]!.event, 1], [ids[1], mapped[1]!.event, 1], [ids[2], null, 0]]);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
});

test("a meeting with no event yet keeps its generation across a change of server, so an older event of the same meeting is never taken for its own", async (context) => {
  const app = await fixture(context); const [meeting] = seedMeetings(app, 1); await app.request("POST", "/admin/integrations/discord/calendar/sync-all"); await app.deliver();
  const [old] = app.events(serverA);
  // Deleted and restored, not yet delivered: the mapping is on generation 2 with no event, and the first event's delete is queued.
  const deleted = await app.request("DELETE", `/meetings/${meeting}`, { scope: "occurrence" }); await app.request("POST", `/meetings/${meeting}/restore`, { scope: "occurrence", deletion: deleted.body.deletion });
  assert.deepEqual(app.mappings(), [{ meeting, event: null, generation: 2, active: 1 }]);
  await app.save(serverB, "test-token-1"); await app.save(serverA, "test-token-1");
  assert.deepEqual(app.mappings(), [{ meeting, event: null, generation: 2, active: 1 }], "the generation came back with the mapping");
  assert.deepEqual(app.rows("SELECT event_id AS event, target FROM calendar_event_removals"), [{ event: old!.split(" ")[0], target: serverA }], "and the first event is still to be removed");
  // The first attempt to create the new event fails, so the next one looks for an event by the meeting's location.
  const mocked = globalThis.fetch; let failed = false;
  globalThis.fetch = async (input, init) => { if (!failed && init?.method === "POST" && /\/scheduled-events$/.test(String(input))) { failed = true; return Response.json({ message: "Internal Server Error" }, { status: 500 }); } return mocked(input, init); };
  await app.verify(serverA); await app.deliver(); globalThis.fetch = mocked; assert.ok(failed);
  await app.request("POST", "/admin/integrations/discord/calendar/retry", {}); await app.deliver();
  const after = app.events(serverA); assert.equal(after.length, 1, "one event for the meeting"); assert.notEqual(after[0], old, "the new one: the first event was removed, not adopted");
  assert.deepEqual(app.mappings(), [{ meeting, event: after[0]!.split(" ")[0], generation: 2, active: 1 }]); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0);
});

test("housekeeping drops what is remembered for meetings that have ended", async (context) => {
  const app = await fixture(context); const { ids } = await threeLive(app); await app.save(serverB, "test-token-1"); assert.equal(leftRows(app), 3);
  app.db.sqlite.prepare("UPDATE meetings SET starts_at = '2026-01-01T00:00:00.000Z', ends_at = '2026-01-01T01:00:00.000Z' WHERE id = ?").run(ids[0]);
  for (let slot = 0; slot < 9 && leftRows(app) === 3; slot += 1) await app.cronPass(slot);
  assert.equal(leftRows(app), 2);
});

test("credentials removed while a change of server is being saved: the save is a first set-up, and the removed server's events become due for removal", async (context) => {
  const app = await fixture(context); await threeLive(app);
  const saved = await saveWhile(app, serverB, "test-token-b", () => app.request("DELETE", "/admin/integrations/discord"));
  assert.equal(saved.status, 200); assert.deepEqual([saved.body.created, saved.body.serverChanged, saved.body.previousServerEvents], [true, true, 3]);
  assert.deepEqual(app.rows("SELECT action, json_extract(metadata_json, '$.calendar') AS calendar FROM audit_log WHERE action IN ('integration.saved', 'integration.rotated')"), [{ action: "integration.saved", calendar: "server_connected" }]);
  assert.deepEqual(app.rows("SELECT target, next_attempt_at IS NOT NULL AS due, COUNT(*) AS n FROM calendar_event_removals GROUP BY target, due"), [{ target: serverA, due: 1, n: 3 }]);
});

// A removal is leased while it is sent, never deleted first: whatever stops the delivery, the row is still there (fourth review round).
const serverRow = (app: Fixture) => app.rows<{ server: string }>("SELECT external_id AS server FROM integration_state WHERE provider = 'discord' AND state_key = 'calendar-server'").map((row) => row.server);
/** Server A's three events recorded for removal and due, with server B connected and verified and its own events created. */
async function removalsDue(app: Fixture) {
  const live = await threeLive(app); await app.save(serverB, "test-token-1"); await app.verify(serverB); await app.cronPass();
  assert.equal(app.events(serverA).length, 3); app.remote.requests.length = 0;
  return live;
}
const removalRows = (app: Fixture) => app.rows<{ event: string; attempts: number; due: string | null; error: string | null }>("SELECT event_id AS event, attempts, next_attempt_at AS due, last_error AS error FROM calendar_event_removals ORDER BY event_id");
const minutesFromNow = (time: string | null) => time === null ? null : (Date.parse(time) - Date.now()) / 60_000;

for (const stop of ["the scheduler's budget refuses the request", "the request to Discord throws"] as const) {
  test(`when ${stop} while a removal is being sent, the removal is still there and due again after its lease`, async (context) => {
    const app = await fixture(context); await removalsDue(app);
    const mocked = globalThis.fetch; const during: ReturnType<typeof removalRows>[] = [];
    globalThis.fetch = async (input, init) => {
      if (init?.method !== "DELETE" || !String(input).includes(`/guilds/${serverA}/`)) return mocked(input, init);
      during.push(removalRows(app));
      throw stop.startsWith("the scheduler") ? new SchedulerBudgetError("provider request") : new TypeError("fetch failed");
    };
    await app.cronPass(1); globalThis.fetch = mocked;
    assert.ok(during.length >= 1, "a removal was being sent"); assert.equal(during[0]!.length, 3, "its row is there while the request is out");
    assert.equal(app.events(serverA).length, 3); const rows = removalRows(app); assert.equal(rows.length, 3, "no removal is lost");
    const sent = rows.filter((row) => minutesFromNow(row.due)! > 1); assert.ok(sent.length >= 1);
    for (const row of sent) assert.ok(minutesFromNow(row.due)! > 4 && minutesFromNow(row.due)! < 1_500, `due again later, not lost: ${row.due}`);
    if (stop.startsWith("the scheduler")) assert.deepEqual(sent.map((row) => [row.attempts, row.error]), [[0, null]], "a refusal by the budget is not an attempt: the removal waits out its lease as it was");
    // Once the lease has ended the removals go out.
    app.db.sqlite.exec("UPDATE calendar_event_removals SET next_attempt_at = '2026-01-01T00:00:00.000Z'"); await app.deliver();
    assert.deepEqual([app.events(serverA).length, app.count("SELECT COUNT(*) AS n FROM calendar_event_removals")], [0, 0]);
  });
}

test("a removal that Discord rate limits three times in a row stays within the cost declared for it and is kept for another attempt", async (context) => {
  const app = await fixture(context); await removalsDue(app);
  const mocked = globalThis.fetch; let limited = 0;
  globalThis.fetch = async (input, init) => { if (init?.method === "DELETE" && String(input).includes(`/guilds/${serverA}/`)) { limited += 1; return Response.json({ message: "You are being rate limited.", retry_after: 0.01, global: false }, { status: 429 }); } return mocked(input, init); };
  await app.cronPass(1); globalThis.fetch = mocked;
  assert.equal(limited, 3, "one removal, sent three times; the rate limit then holds the others back");
  const rows = removalRows(app); assert.equal(rows.length, 3); assert.deepEqual(rows.map((row) => row.attempts).sort(), [0, 0, 1]);
  assert.ok(rows.every((row) => row.due !== null && minutesFromNow(row.due)! > 0.5), "all three wait: the one that was refused and the two held behind it");
});

test("a removal cancelled by its server coming back while it is being sent is not brought back when the request fails", async (context) => {
  const app = await fixture(context); const { mapped, before } = await removalsDue(app);
  // Credentials for A are saved again while Discord is answering the first DELETE, and Discord then fails it.
  const mocked = globalThis.fetch; let raced = false;
  globalThis.fetch = async (input, init) => { if (init?.method === "DELETE" && String(input).includes(`/guilds/${serverA}/`)) { if (!raced) { raced = true; await app.save(serverA, "test-token-1"); } return Response.json({ message: "Internal Server Error" }, { status: 500 }); } return mocked(input, init); };
  await app.cronPass(1); globalThis.fetch = mocked; assert.ok(raced);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals WHERE target = ?", serverA), 0, "the cancelled removal stays cancelled, and the other two were not sent");
  assert.deepEqual(app.mappings(), mapped); assert.deepEqual(app.events(serverA), before);
  app.remote.requests.length = 0; await app.verify(serverA); await app.deliver();
  assert.equal(calls(app, serverA), "PATCH PATCH PATCH"); assert.deepEqual(app.events(serverA), before);
});

test("a removal whose event an active mapping holds is deleted without asking Discord", async (context) => {
  const app = await fixture(context); const { mapped, before } = await threeLive(app);
  app.db.sqlite.prepare("INSERT INTO calendar_event_removals(installation_id,provider,event_id,target,attempts,next_attempt_at,updated_at) VALUES('primary','discord',?,?,0,'2026-01-01','2026-01-01')").run(mapped[0]!.event, serverA);
  await app.deliver();
  assert.deepEqual(app.remote.requests, [], "nothing is sent"); assert.equal(app.count("SELECT COUNT(*) AS n FROM calendar_event_removals"), 0); assert.deepEqual(app.events(serverA), before);
});

test("Remove integration racing a change of server changes nothing and records nothing under the wrong server", async (context) => {
  const app = await fixture(context); await threeLive(app);
  // The Remove request has read the credentials for A when a save for B lands; its batch then runs against B's.
  const database = app.env.DB as unknown as { prepare(sql: string): any }; const prepare = database.prepare; let raced = false;
  database.prepare = (sql: string) => {
    const prepared = prepare(sql); if (raced || !/FROM encrypted_integrations i JOIN installations/.test(sql)) return prepared;
    const bind = prepared.bind; prepared.bind = (...values: unknown[]) => { const boundStatement = bind(...values); const first = boundStatement.first;
      boundStatement.first = async (...args: unknown[]) => { const row = await first(...args); if (!raced && values[0] === "discord") { raced = true; database.prepare = prepare; await app.save(serverB, "test-token-2"); } return row; };
      return boundStatement; };
    return prepared;
  };
  const cookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" })}`;
  const removed = await worker.fetch(new Request("https://api.example.test/admin/integrations/discord", { method: "DELETE", headers: { cookie, origin } }), app.env); database.prepare = prepare;
  assert.ok(raced); assert.equal(removed.status, 409); assert.match(((await removed.json()) as { error: string }).error, /changed by another request/);
  assert.equal(app.count("SELECT COUNT(*) AS n FROM encrypted_integrations WHERE provider = 'discord'"), 1, "the credentials the save stored are still there"); assert.deepEqual(serverRow(app), [serverB]);
  assert.equal(app.count("SELECT discord_enabled AS n FROM installations"), 1); assert.equal(app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'integration.removed'"), 0);
  assert.deepEqual(app.rows("SELECT target, next_attempt_at IS NOT NULL AS due, COUNT(*) AS n FROM calendar_event_removals GROUP BY target, due"), [{ target: serverA, due: 1, n: 3 }], "A's events are recorded under A, by the save, and not set aside");
  assert.deepEqual(app.rows("SELECT DISTINCT substr(state_key, 1, 33) AS key FROM integration_state WHERE state_key LIKE 'calendar-left:%'"), [{ key: `calendar-left:${serverA}:` }], "nothing is remembered under B");
});

test("removing Discord twice changes nothing the second time", async (context) => {
  const app = await fixture(context); const { mapped, before } = await threeLive(app);
  await app.request("DELETE", "/admin/integrations/discord"); const once = [removalRows(app), leftRows(app), app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'calendar.event_removal_abandoned'")];
  await app.request("DELETE", "/admin/integrations/discord");
  assert.deepEqual([removalRows(app), leftRows(app), app.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'calendar.event_removal_abandoned'")], once);
  await setUpAgain(app, serverA); assert.equal(calls(app, serverA), "PATCH PATCH PATCH PATCH PATCH PATCH"); assert.deepEqual(app.events(serverA), before); assert.deepEqual(app.mappings(), mapped);
});

test("removing Discord while its saved credentials cannot be read uses the server the last save recorded", async (context) => {
  const app = await fixture(context); const { mapped, before } = await threeLive(app);
  await app.save(serverA, "test-token-2"); await app.verify(serverA); await app.deliver(); assert.deepEqual(serverRow(app), [serverA]); app.remote.requests.length = 0;
  app.db.sqlite.exec("UPDATE encrypted_integrations SET ciphertext = substr(ciphertext, 1, 20) || 'AAAA' || substr(ciphertext, 25) WHERE provider = 'discord'");
  await app.request("DELETE", "/admin/integrations/discord");
  assert.deepEqual(app.rows("SELECT DISTINCT target, next_attempt_at AS due FROM calendar_event_removals"), [{ target: serverA, due: null }]); assert.equal(leftRows(app), 3); assert.deepEqual(serverRow(app), []);
  await setUpAgain(app, serverA, "test-token-2"); assert.equal(calls(app, serverA), "PATCH PATCH PATCH PATCH PATCH PATCH"); assert.deepEqual(app.events(serverA), before); assert.deepEqual(app.mappings(), mapped);
});

test("an installation from before this change has no recorded server: a save records it, and Remove and a create that finishes late work without it", async (context) => {
  const app = await fixture(context); const [meeting] = seedMeetings(app, 1); await app.request("POST", "/admin/integrations/discord/calendar/sync-all");
  assert.deepEqual(serverRow(app), [], "nothing has recorded the server yet");
  // The connection is removed while the meeting's event is being created; neither has a recorded server to go by.
  const race = whileCreating(app, () => app.request("DELETE", "/admin/integrations/discord")); await app.cronPass(); race.restore(); assert.ok(race.raced());
  const [event] = app.events(serverA); assert.ok(event);
  assert.deepEqual(app.rows("SELECT event_id AS event, target, next_attempt_at AS due FROM calendar_event_removals"), [{ event: event!.split(" ")[0], target: serverA, due: null }]); assert.equal(leftRows(app), 1);
  app.remote.requests.length = 0; await setUpAgain(app, serverA);
  assert.deepEqual(serverRow(app), [serverA], "the save recorded the server"); assert.equal(calls(app, serverA), "PATCH PATCH", "the event is linked again and only updated"); assert.deepEqual(app.events(serverA), [event]);
  assert.deepEqual(app.mappings(), [{ meeting, event: event!.split(" ")[0], generation: 1, active: 1 }]);
  // A token reset on such an installation records the server too, and keeps the calendar.
  const other = await fixture(context); await threeLive(other); await other.save(serverA, "test-token-2"); assert.deepEqual(serverRow(other), [serverA]);
});
