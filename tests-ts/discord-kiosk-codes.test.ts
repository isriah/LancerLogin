// quick-check: covers apps/api/migrations/**
// Discord code mode for kiosks on a real migrated SQLite database: the 0100 upgrade, /code in Discord, redeeming a code
// at a kiosk, the per-kiosk wrong-code throttle, the kiosk configuration and poll fields, the Admin setting, pruning and
// backup schema 52. All data here is synthetic.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { DISCORD_CODE_TTL_MS, hashDiscordKioskCode, normalizeDiscordKioskCode, pruneDiscordKioskCodes, randomDiscordKioskCode } from "../apps/api/src/discord-kiosk-codes.ts";
import { Statement, applyCoreMigrations, readCoreMigrations } from "./fixtures/d1-database.ts";
import { BackupDatabase } from "./fixtures/backup-database.ts";
import { omitContestResubmissionFields } from "./fixtures/backup-versions.ts";

const secret = "A".repeat(43);
const guildId = "123456789012345678";
const discordA = "323456789012345678", discordB = "423456789012345678", discordUnlinked = "523456789012345678";
const codeReply = /^Your kiosk code is \*\*(\d{3}) (\d{3})\*\*\. It works once and expires in 2 minutes\.$/;

/**
 * Counts D1 round trips, the unit the Workers Free plan limits to 50 per invocation: each batch is one (the module-scoped
 * database sends a query and its authority guards as one batch), and so is each statement run on its own.
 */
let roundTrips = 0;
for (const method of ["first", "all", "run"] as const) {
  const original = Statement.prototype[method] as (this: Statement) => Promise<unknown>;
  (Statement.prototype as unknown as Record<string, unknown>)[method] = function (this: Statement) { roundTrips += 1; return original.call(this); };
}
class CountingDatabase extends BackupDatabase {
  statements: string[] = [];
  override prepare(sql: string) { this.statements.push(sql); return super.prepare(sql); }
  override async batch(statements: Parameters<BackupDatabase["batch"]>[0]) { roundTrips += 1; return super.batch(statements); }
}
const startCount = (database: CountingDatabase) => { roundTrips = 0; database.statements.length = 0; };

async function fixture(context: TestContext) {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T12:00:00Z") });
  context.mock.method(globalThis, "fetch", () => { throw new Error("No live provider access is permitted in this fixture"); });
  const database = new CountingDatabase(); context.after(() => database.raw.close());
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const encrypted = await encryptIntegration({ botToken: "synthetic-bot-token", guildId, channelId: "223456789012345678", publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") }, secret);
  database.raw.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, verified_at, updated_at) VALUES ('discord-1', 'primary', 'discord', ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')").run(encrypted.ciphertext, encrypted.iv);
  database.raw.exec(`UPDATE installations SET discord_enabled = 1;
    INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id,created_at) VALUES
      ('test-a','primary','TEST-A','Test Student','A','test-student-a@example.test','${discordA}','2026-01-01'),
      ('test-b','primary','TEST-B','Test Student','B','test-student-b@example.test','${discordB}','2026-01-01');
    INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('test-meeting','primary','Test Meeting A','2026-09-30T11:00:00.000Z','2026-09-30T13:00:00.000Z','admin','2026-01-01');`);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: secret, INTEGRATION_KEY: secret, DB: database } as unknown as Env;
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  const call = (path: string, body?: unknown, token?: string, method?: string) => worker.fetch(new Request(`https://api.example.test${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: env.ALLOWED_ORIGIN }), ...(token ? { authorization: `Bearer ${token}` } : { cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  // A Worker isolate reconciles installed modules on its first request; serve one so query counts cover only the request under test.
  await call("/health");
  const pairWeb = async (name: string) => {
    const created = await call("/admin/pairing-codes", { kioskName: name, kind: "web" }); assert.equal(created.status, 201, await created.clone().text());
    const paired = await call("/kiosk/pair", { code: (await created.json() as { code: string }).code }); assert.equal(paired.status, 201, await paired.clone().text());
    return await paired.json() as { kioskId: string; kioskToken: string; pairingId: string };
  };
  const setMethod = (kioskId: string, body: Record<string, unknown>) => call(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "member_id", ...body }, undefined, "PATCH");
  const interaction = (payload: unknown, key: KeyObject = privateKey) => {
    const body = JSON.stringify(payload); const timestamp = String(Math.floor(Date.now() / 1000));
    return worker.fetch(new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), key).toString("hex"), "x-signature-timestamp": timestamp }, body }), env);
  };
  /** Runs /code as a Discord user and returns the whole interaction reply. */
  const slashCode = async (discordUserId: string, extra: Record<string, unknown> = {}) => {
    const result = await interaction({ type: 2, guild_id: guildId, data: { name: "code" }, member: { user: { id: discordUserId } }, ...extra }); assert.equal(result.status, 200, await result.clone().text());
    return await result.json() as { type: number; data: { content: string; flags: number; allowed_mentions: unknown } };
  };
  /** Runs /code and returns the six digits. */
  const newCode = async (discordUserId: string) => {
    const match = codeReply.exec((await slashCode(discordUserId)).data.content); assert.ok(match, "the reply carries a code");
    return match[1]! + match[2]!;
  };
  let scans = 0;
  const scan = (kiosk: { kioskToken: string; pairingId: string }, body: Record<string, unknown>) => call("/kiosk/attendance", { eventId: `test-scan-${scans += 1}`, occurredAt: new Date().toISOString(), pairingId: kiosk.pairingId, ...body }, kiosk.kioskToken);
  const codeRow = (memberId: string) => { const row = database.raw.prepare("SELECT code_hash AS hash, expires_at AS expiresAt, used_at AS usedAt, created_at AS createdAt FROM discord_kiosk_codes WHERE member_id = ?").get(memberId); return row ? { ...row } as { hash: string; expiresAt: string; usedAt: string | null; createdAt: string } : undefined; };
  const kioskRow = (kioskId: string) => ({ ...database.raw.prepare("SELECT discord_code AS discordCode, discord_code_backup AS backup, discord_code_failures AS failures, discord_code_throttle_until AS throttleUntil, require_pin AS requirePin FROM kiosks WHERE id = ?").get(kioskId) }) as { discordCode: number; backup: string; failures: number; throttleUntil: string | null; requirePin: number };
  const events = () => database.rows<{ member: string; action: string; event: string }>("SELECT member_id AS member, action, kiosk_event_id AS event FROM attendance_events ORDER BY occurred_at, id");
  return { database, env, call, pairWeb, setMethod, interaction, slashCode, newCode, scan, codeRow, kioskRow, events };
}
const json = async (result: Response) => await result.json() as Record<string, unknown>;

test("migration 0100 leaves existing kiosks without Discord codes, and the throttle never bumps the kiosk roster", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const migrations = readCoreMigrations(); const index = migrations.findIndex((file) => file.name === "0100_discord_kiosk_codes.sql");
    assert.ok(index > 0);
    applyCoreMigrations(sqlite, migrations.slice(0, index));
    sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES ('test-a','primary','TEST-A','Test Student','A','2026-01-01');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at) VALUES ('test-pairing','primary','synthetic-hash','2026-01-02','admin','2026-01-01');
      INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,created_at,configured_authentication_method,require_pin) VALUES ('test-kiosk','primary','test-pairing','Test Kiosk A','synthetic-token-hash','2026-01-01','member_id',1);
      INSERT OR IGNORE INTO kiosk_roster_revision(installation_id,revision) VALUES ('primary',0);`);
    const revision = () => Number(sqlite.prepare("SELECT revision FROM kiosk_roster_revision").get()?.revision);
    applyCoreMigrations(sqlite, migrations.slice(index));
    const before = revision();
    assert.deepEqual({ ...sqlite.prepare("SELECT discord_code, discord_code_backup, discord_code_failures, discord_code_throttle_until, require_pin, configured_authentication_method FROM kiosks").get() },
      { discord_code: 0, discord_code_backup: "offline", discord_code_failures: 0, discord_code_throttle_until: null, require_pin: 1, configured_authentication_method: "member_id" });
    sqlite.exec("UPDATE kiosks SET discord_code = 1, discord_code_backup = 'always', discord_code_failures = 6, discord_code_throttle_until = '2026-01-01T00:05:00.000Z'");
    sqlite.exec("INSERT INTO discord_kiosk_codes(installation_id,member_id,code_hash,expires_at,created_at) VALUES ('primary','test-a','synthetic-code-hash','2026-01-01T00:02:00.000Z','2026-01-01T00:00:00.000Z')");
    assert.equal(revision(), before, "neither the setting, the throttle nor a code changes the kiosk roster");
    assert.throws(() => sqlite.exec("UPDATE kiosks SET discord_code = 2"), /CHECK/);
    assert.throws(() => sqlite.exec("UPDATE kiosks SET discord_code_backup = 'never'"), /CHECK/);
    assert.throws(() => sqlite.exec("UPDATE kiosks SET discord_code_failures = -1"), /CHECK/);
    assert.throws(() => sqlite.exec("INSERT INTO discord_kiosk_codes(installation_id,member_id,code_hash,expires_at,created_at) VALUES ('primary','test-a','another-hash','2026-01-01','2026-01-01')"), /UNIQUE|PRIMARY/, "one code per member");
    sqlite.exec("DELETE FROM members WHERE id = 'test-a'");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM discord_kiosk_codes").get()?.n, 0, "a deleted member's code goes with them");
  } finally { sqlite.close(); }
});

test("codes are six digits with leading zeros kept, and typed spaces are ignored", () => {
  for (let index = 0; index < 200; index += 1) assert.match(randomDiscordKioskCode(), /^\d{6}$/);
  assert.equal(normalizeDiscordKioskCode("482 916"), "482916"); assert.equal(normalizeDiscordKioskCode("004120"), "004120");
  for (const bad of ["48291", "4829167", "48291a", "", 482916, null, undefined, "4".repeat(40)]) assert.equal(normalizeDiscordKioskCode(bad), undefined);
});

test("/code gives a linked member a private code, replaces their last one and refuses everyone else", async (context) => {
  const { database, interaction, slashCode, newCode, codeRow } = await fixture(context);
  startCount(database);
  const reply = await slashCode(discordA);
  assert.equal(reply.type, 4); assert.equal(reply.data.flags, 64, "only the member sees it"); assert.deepEqual(reply.data.allowed_mentions, { parse: [] });
  const match = codeReply.exec(reply.data.content); assert.ok(match, reply.data.content);
  const first = match[1]! + match[2]!;
  // The command itself is one read and one write, so it answers well inside Discord's three seconds.
  const commandQueries = database.statements.filter((sql) => /FROM members WHERE installation_id = 'primary' AND discord_user_id|discord_kiosk_codes/.test(sql));
  assert.equal(commandQueries.length, 2, commandQueries.join("\n"));
  assert.equal(roundTrips, 5, "with the maintenance check, the Discord credentials and the Attendance module check: five D1 round trips in all");
  const stored = codeRow("test-a")!;
  assert.deepEqual(stored, { hash: await hashDiscordKioskCode(first), expiresAt: new Date(Date.now() + DISCORD_CODE_TTL_MS).toISOString(), usedAt: null, createdAt: new Date().toISOString() });
  assert.equal(JSON.stringify(database.rows("SELECT * FROM discord_kiosk_codes")).includes(first), false, "the code itself is never stored");
  assert.equal(database.count("SELECT COUNT(*) AS n FROM audit_log WHERE metadata_json LIKE ? OR action LIKE '%code%'", `%${first}%`), 0, "and never audited");

  // Asking again replaces the member's row, used or not.
  context.mock.timers.tick(10_000);
  database.raw.exec("UPDATE discord_kiosk_codes SET used_at = '2026-09-30T12:00:05.000Z'");
  const second = await newCode(discordA);
  assert.equal(database.count("SELECT COUNT(*) AS n FROM discord_kiosk_codes"), 1);
  assert.deepEqual(codeRow("test-a"), { hash: await hashDiscordKioskCode(second), expiresAt: new Date(Date.now() + DISCORD_CODE_TTL_MS).toISOString(), usedAt: null, createdAt: new Date().toISOString() });
  await newCode(discordB);
  assert.equal(database.count("SELECT COUNT(*) AS n FROM discord_kiosk_codes"), 2, "each member has their own");

  // Not linked: sent to /pair, and nothing is written.
  assert.match((await slashCode(discordUnlinked)).data.content, /not linked to a LancerLogin member yet\. Link it first with \/pair/);
  // Linked to an inactive member: no code.
  database.raw.exec("UPDATE members SET active = 0 WHERE id = 'test-b'");
  assert.match((await slashCode(discordB)).data.content, /not linked to exactly one active LancerLogin roster member/);
  database.raw.exec("UPDATE members SET active = 1 WHERE id = 'test-b'");
  // Another server, options that /code does not take, and a bad signature.
  assert.match((await slashCode(discordA, { guild_id: "999999999999999999" })).data.content, /Use this command in the Discord server configured/);
  assert.match((await slashCode(discordA, { data: { name: "code", options: [{ name: "member-id", value: "TEST-B" }] } })).data.content, /malformed/);
  assert.equal((await interaction({ type: 2, guild_id: guildId, data: { name: "code" }, member: { user: { id: discordA } } }, generateKeyPairSync("ed25519").privateKey)).status, 401);
  assert.equal(database.count("SELECT COUNT(*) AS n FROM discord_kiosk_codes"), 2, "no refusal wrote a code");
  assert.equal(codeRow("test-a")!.hash, await hashDiscordKioskCode(second), "or replaced one");
  // With Attendance disabled the command answers as /attendance-report does.
  database.raw.exec("UPDATE platform_modules SET phase = 'disabled' WHERE module_id = 'attendance'");
  assert.match((await slashCode(discordA)).data.content, /Attendance is disabled/);
  assert.equal(codeRow("test-a")!.hash, await hashDiscordKioskCode(second));
});

test("/code never hands out a code another member is still holding", async (context) => {
  const { database, newCode, codeRow } = await fixture(context);
  const draws = [111_111, 111_111, 222_222, 111_111, 111_111, 333_333]; const original = crypto.getRandomValues.bind(crypto);
  context.mock.method(crypto, "getRandomValues", (array: ArrayBufferView) => {
    if (array instanceof Uint32Array && array.length === 1 && draws.length) { array[0] = draws.shift()!; return array; }
    return original(array as Uint8Array<ArrayBuffer>);
  });
  assert.equal(await newCode(discordA), "111111");
  assert.equal(await newCode(discordB), "222222", "drawn again when the first draw is taken");
  assert.equal(await newCode(discordA), "111111", "a member's own old code is not a clash");
  // Once the other member's code is used or expired, the number is free again.
  database.raw.exec("UPDATE discord_kiosk_codes SET used_at = '2026-09-30T12:00:01.000Z' WHERE member_id = 'test-a'");
  assert.equal(await newCode(discordB), "111111");
  assert.equal(codeRow("test-b")!.hash, await hashDiscordKioskCode("111111")); assert.deepEqual(draws, [333_333]);
});

test("a kiosk in Discord code mode records attendance from a code once, and refuses wrong, used and expired codes", async (context) => {
  const { database, pairWeb, setMethod, newCode, scan, codeRow, kioskRow, events, call } = await fixture(context);
  const kiosk = await pairWeb("Test Web Kiosk A");
  // Off until an Admin turns it on: refused without using the code up.
  const early = await newCode(discordA);
  const off = await scan(kiosk, { discordCode: early }); assert.equal(off.status, 409);
  assert.deepEqual(await json(off), { error: "This kiosk does not take Discord codes.", code: "code_not_enabled" });
  assert.equal(codeRow("test-a")!.usedAt, null);
  assert.equal((await setMethod(kiosk.kioskId, { discordCode: true })).status, 200);

  // Malformed requests are refused before the code is used.
  const both = await scan(kiosk, { discordCode: early, memberId: "TEST-A" }); assert.equal(both.status, 400); assert.equal((await json(both)).code, "invalid_scan");
  const untimed = await scan(kiosk, { discordCode: early, occurredAt: "not a time" }); assert.equal(untimed.status, 400); assert.equal((await json(untimed)).code, "invalid_scan");
  const short = await scan(kiosk, { discordCode: "12345" }); assert.equal(short.status, 400);
  assert.deepEqual(await json(short), { error: "A Discord code is 6 digits.", code: "invalid_code" });
  assert.equal(codeRow("test-a")!.usedAt, null); assert.equal(kioskRow(kiosk.kioskId).failures, 0, "none of these is a wrong try");

  // The code alone names the member: one lookup, then the usual attendance step, which uses the code up as it records the scan.
  startCount(database);
  const accepted = await scan(kiosk, { discordCode: `${early.slice(0, 3)} ${early.slice(3)}`, eventId: "test-code-scan" });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const body = await accepted.json() as { accepted: boolean; action: string; member: { id: string; externalId: string; displayName: string }; meeting: { id: string } };
  assert.equal(body.accepted, true); assert.equal(body.action, "check_in"); assert.deepEqual(body.member, { id: "test-a", externalId: "TEST-A", displayName: "Test Student A" }); assert.equal(body.meeting.id, "test-meeting");
  assert.deepEqual(events(), [{ member: "test-a", action: "check_in", event: "test-code-scan" }]);
  // One D1 round trip more than a member ID scan (the lookup, one batch), far inside the Workers Free plan's 50 per
  // invocation: the code is used up in the batch that records the scan.
  const codeScanRoundTrips = roundTrips;
  assert.ok(roundTrips <= 10, `a code scan is ${roundTrips} D1 round trips`);
  assert.equal(codeRow("test-a")!.usedAt, new Date().toISOString());

  // A kiosk that lost the answer sends the same scan again: a duplicate, not a wrong try.
  const retried = await scan(kiosk, { discordCode: early, eventId: "test-code-scan" }); assert.equal(retried.status, 200);
  assert.deepEqual(await json(retried), { accepted: false, duplicate: true, eventId: "test-code-scan", action: "check_in" });
  assert.equal(kioskRow(kiosk.kioskId).failures, 0);
  // The same code in a new scan is spent. 403, never 401: kiosks treat a 401 as a revoked credential.
  const reused = await scan(kiosk, { discordCode: early }); assert.equal(reused.status, 403);
  assert.deepEqual(await json(reused), { error: "That code is wrong or has expired. Run /code in Discord for a new one.", code: "code_invalid" });
  const wrong = await scan(kiosk, { discordCode: "000000" }); assert.equal(wrong.status, 403); assert.equal((await json(wrong)).code, "code_invalid");
  // Saying the PIN was checked offline changes nothing: the code is still looked up.
  const offline = await scan(kiosk, { discordCode: "000001", pinCheck: "offline" }); assert.equal(offline.status, 403); assert.equal((await json(offline)).code, "code_invalid");
  assert.equal(kioskRow(kiosk.kioskId).failures, 3);

  // A code expires two minutes after it was made.
  const timed = await newCode(discordB);
  context.mock.timers.tick(DISCORD_CODE_TTL_MS);
  const expired = await scan(kiosk, { discordCode: timed }); assert.equal(expired.status, 403); assert.equal((await json(expired)).code, "code_invalid");
  assert.equal(codeRow("test-b")!.usedAt, null);
  const fresh = await newCode(discordB);
  context.mock.timers.tick(DISCORD_CODE_TTL_MS - 1);
  const justInTime = await scan(kiosk, { discordCode: fresh }); assert.equal(justInTime.status, 202, await justInTime.clone().text());
  assert.equal((await justInTime.json() as { member: { displayName: string } }).member.displayName, "Test Student B");
  assert.deepEqual([kioskRow(kiosk.kioskId).failures, kioskRow(kiosk.kioskId).throttleUntil], [0, null], "a correct code clears the kiosk's wrong tries");

  // A second code for the same member checks them out, like any second scan.
  context.mock.timers.tick(10 * 60_000);
  const leaving = await scan(kiosk, { discordCode: await newCode(discordB) }); assert.equal(leaving.status, 202);
  assert.equal((await json(leaving)).action, "check_out");
  // The member ID method still works on the same kiosk as the backup.
  startCount(database);
  assert.equal((await scan(kiosk, { memberId: "001" })).status, 202);
  assert.equal(codeScanRoundTrips, roundTrips + 1, "a code scan costs one D1 round trip more than a member ID scan");
  // Turning the mode off refuses codes again.
  assert.equal((await setMethod(kiosk.kioskId, { discordCode: false })).status, 200);
  assert.equal((await scan(kiosk, { discordCode: await newCode(discordA) })).status, 409);
  assert.equal((await call("/kiosk/attendance", { eventId: "test-unpaired", occurredAt: new Date().toISOString(), discordCode: "123456" }, "not-a-kiosk-token")).status, 401);
});

test("a code needs no PIN on a Require PIN kiosk, and an inactive member's code records nothing", async (context) => {
  const { database, pairWeb, setMethod, newCode, scan, codeRow, kioskRow, events } = await fixture(context);
  const kiosk = await pairWeb("Test Web Kiosk A");
  assert.equal((await setMethod(kiosk.kioskId, { requirePin: true, discordCode: true, discordCodeBackup: "always" })).status, 200);
  const withoutPin = await scan(kiosk, { memberId: "TEST-A" }); assert.equal(withoutPin.status, 400);
  assert.equal((await json(withoutPin)).code, "pin_required", "the member ID method still asks for the PIN");
  const coded = await scan(kiosk, { discordCode: await newCode(discordA) }); assert.equal(coded.status, 202, await coded.clone().text());
  assert.equal((await coded.json() as { member: { displayName: string } }).member.displayName, "Test Student A");

  // Deactivated after asking for a code: the scan is refused as for any inactive member. The code was not what was wrong,
  // so it is not used up and is no wrong try.
  const code = await newCode(discordB);
  database.raw.exec("UPDATE members SET active = 0 WHERE id = 'test-b'");
  const inactive = await scan(kiosk, { discordCode: code }); assert.equal(inactive.status, 404);
  assert.deepEqual(await json(inactive), { error: "This identity is not linked to an active roster member", code: "roster_inactive" });
  assert.equal(codeRow("test-b")!.usedAt, null);
  assert.equal(kioskRow(kiosk.kioskId).failures, 0);
  assert.deepEqual(events().map((event) => event.member), ["test-a"]);
});

test("a code is used up only by the scan that is recorded: refusals and failures leave it good, and are no wrong tries", async (context) => {
  const { database, pairWeb, setMethod, newCode, scan, codeRow, kioskRow, events } = await fixture(context);
  const kiosk = await pairWeb("Test Web Kiosk A"), other = await pairWeb("Test Web Kiosk B");
  for (const device of [kiosk, other]) assert.equal((await setMethod(device.kioskId, { discordCode: true })).status, 200);
  const code = await newCode(discordA);
  const unused = (message: string) => { assert.equal(codeRow("test-a")!.usedAt, null, message); assert.deepEqual([kioskRow(kiosk.kioskId).failures, kioskRow(kiosk.kioskId).throttleUntil], [0, null], `${message}: no wrong try`); };

  // No meeting takes a scan made hours before the meeting. Sent more often than the throttle's free tries, to show
  // that none of them counts.
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const tooEarly = await scan(kiosk, { discordCode: code, occurredAt: "2026-09-30T05:00:00.000Z" }); assert.equal(tooEarly.status, 409);
    assert.equal((await json(tooEarly)).code, "no_eligible_meeting");
  }
  unused("a scan no meeting takes");
  // A chosen meeting whose window is closed, and a meeting that does not exist.
  const closed = await scan(kiosk, { discordCode: code, meetingId: "test-meeting", occurredAt: "2026-09-30T05:00:00.000Z" }); assert.equal((await json(closed)).code, "scan_window_closed");
  assert.equal((await scan(kiosk, { discordCode: code, meetingId: "test-no-such-meeting" })).status, 409);
  unused("a closed window");
  // The member's attendance starts after the meeting.
  database.raw.exec("UPDATE members SET attendance_required_from = '2026-10-15' WHERE id = 'test-a'");
  assert.equal((await json(await scan(kiosk, { discordCode: code }))).code, "participation_not_started");
  database.raw.exec("UPDATE members SET attendance_required_from = NULL WHERE id = 'test-a'");
  unused("attendance not started");
  // A failure while the scan is being recorded: the batch that would have used the code changed nothing.
  database.raw.exec("CREATE TRIGGER test_fail_scan BEFORE INSERT ON attendance_events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  assert.equal((await scan(kiosk, { discordCode: code, eventId: "test-retried-scan" })).status, 500);
  database.raw.exec("DROP TRIGGER test_fail_scan");
  unused("a failed write"); assert.deepEqual(events(), []);

  // The kiosk's retry of that scan, with the same code, is recorded, and only now is the code used.
  const recorded = await scan(kiosk, { discordCode: code, eventId: "test-retried-scan" }); assert.equal(recorded.status, 202, await recorded.clone().text());
  assert.equal(codeRow("test-a")!.usedAt, new Date().toISOString());
  assert.deepEqual(events(), [{ member: "test-a", action: "check_in", event: "test-retried-scan" }]);
  assert.equal((await scan(kiosk, { discordCode: code })).status, 403, "single use");

  // Attendance already complete: the third code of the meeting is refused and stays good.
  context.mock.timers.tick(10 * 60_000);
  assert.equal((await json(await scan(kiosk, { discordCode: await newCode(discordA) }))).action, "check_out");
  database.raw.exec("UPDATE kiosks SET discord_code_failures = 0, discord_code_throttle_until = NULL");
  const third = await newCode(discordA);
  assert.equal((await json(await scan(kiosk, { discordCode: third }))).code, "attendance_complete");
  unused("attendance complete");

  // Two kiosks send one code at the same time: exactly one scan is recorded, and the code is used once.
  const shared = await newCode(discordB);
  const raced = await Promise.all([scan(kiosk, { discordCode: shared, eventId: "test-race-a" }), scan(other, { discordCode: shared, eventId: "test-race-b" })]);
  assert.deepEqual(raced.map((result) => result.status).sort(), [202, 403]);
  assert.equal((await json(raced.find((result) => result.status === 403)!)).code, "code_invalid");
  assert.equal(events().filter((event) => event.member === "test-b").length, 1);
  assert.notEqual(codeRow("test-b")!.usedAt, null);
  // The same scan sent twice at once (one event id): one is recorded, the other is its duplicate.
  context.mock.timers.tick(10 * 60_000);
  const twice = await newCode(discordB);
  const doubled = await Promise.all([scan(kiosk, { discordCode: twice, eventId: "test-double" }), scan(kiosk, { discordCode: twice, eventId: "test-double" })]);
  const bodies = await Promise.all(doubled.map(json));
  assert.deepEqual(bodies.map((body) => body.accepted).sort(), [false, true]); assert.equal(bodies.find((body) => body.accepted === false)!.duplicate, true);
  assert.equal(events().filter((event) => event.event === "test-double").length, 1);
});

test("wrong codes sent at the same time pass the throttle no more often than one after another", async (context) => {
  const { pairWeb, setMethod, newCode, scan, codeRow, kioskRow, events } = await fixture(context);
  const kiosk = await pairWeb("Test Web Kiosk A");
  assert.equal((await setMethod(kiosk.kioskId, { discordCode: true })).status, 200);
  const burst = async (codes: string[]) => { const results = await Promise.all(codes.map((code) => scan(kiosk, { discordCode: code }))); return Promise.all(results.map(async (result) => ({ status: result.status, code: (await json(result)).code }))); };
  const wrongCodes = (count: number, from: number) => Array.from({ length: count }, (_, index) => String(100_000 + from + index));

  // Twenty wrong codes at once, all authenticated before any is counted: the five free tries are looked up, no more.
  const first = await burst(wrongCodes(20, 0));
  assert.equal(first.filter((result) => result.status === 403 && result.code === "code_invalid").length, 5);
  assert.equal(first.filter((result) => result.status === 429 && result.code === "code_throttled").length, 15);
  assert.equal(kioskRow(kiosk.kioskId).failures, 5);
  assert.equal(kioskRow(kiosk.kioskId).throttleUntil, new Date(Date.now() + 30_000).toISOString());

  // After the wait, one try is looked up and the rest of a burst wait again, the member's good code among them.
  context.mock.timers.tick(30_000);
  const good = await newCode(discordA);
  const second = await burst([...wrongCodes(9, 100), good]);
  assert.equal(second.filter((result) => result.status !== 429).length, 1, "one try per wait");
  assert.equal(kioskRow(kiosk.kioskId).failures, 6);
  assert.equal(codeRow("test-a")!.usedAt, null, "a code refused for the wait is not used up"); assert.deepEqual(events(), []);

  // A burst that starts with the good code records its scan once; the tries behind it start from a clean count.
  context.mock.timers.tick(60_000);
  const third = await burst([good, ...wrongCodes(9, 200)]);
  assert.equal(third.filter((result) => result.status === 202).length, 1);
  assert.equal(third.filter((result) => result.status === 403).length <= 5, true);
  assert.equal(events().length, 1);
});

test("wrong codes are throttled per kiosk: five free, then 30 s, 60 s and 5 minutes, until a correct code", async (context) => {
  const { database, pairWeb, setMethod, newCode, scan, codeRow, kioskRow } = await fixture(context);
  const kiosk = await pairWeb("Test Web Kiosk A"), other = await pairWeb("Test Web Kiosk B");
  for (const device of [kiosk, other]) assert.equal((await setMethod(device.kioskId, { discordCode: true })).status, 200);
  const revision = () => database.count("SELECT revision AS n FROM kiosk_roster_revision"); const before = revision();
  const wrong = () => scan(kiosk, { discordCode: "000000" });
  const invalid = { error: "That code is wrong or has expired. Run /code in Discord for a new one.", code: "code_invalid" };
  for (let attempt = 1; attempt <= 4; attempt += 1) { const result = await wrong(); assert.equal(result.status, 403); assert.deepEqual(await json(result), invalid); }
  const fifth = await wrong(); assert.equal(fifth.status, 403);
  assert.deepEqual(await json(fifth), { ...invalid, retryAt: new Date(Date.now() + 30_000).toISOString(), retryAfterSeconds: 30 });
  assert.deepEqual(kioskRow(kiosk.kioskId).failures, 5);

  // While the kiosk waits every try is refused the same way, right or wrong, without touching a code or the count.
  const good = await newCode(discordA);
  const refuse = async (code: string, seconds: number, message: string) => {
    const row = kioskRow(kiosk.kioskId); startCount(database);
    const refused = await scan(kiosk, { discordCode: code }); assert.equal(refused.status, 429);
    assert.deepEqual(await json(refused), { error: message, code: "code_throttled", retryAt: row.throttleUntil, retryAfterSeconds: seconds });
    assert.equal(database.statements.some((sql) => sql.includes("discord_kiosk_codes") || sql.includes("UPDATE kiosks")), false, "refused before any code query");
    assert.equal(roundTrips, 3, "the maintenance check, the module check and the kiosk credential read, as for any kiosk request");
    assert.deepEqual(kioskRow(kiosk.kioskId), row);
  };
  await refuse(good, 30, "Too many wrong codes. Try again in 30 seconds.");
  await refuse("000000", 30, "Too many wrong codes. Try again in 30 seconds.");
  assert.equal(codeRow("test-a")!.usedAt, null, "the correct code was not used up");
  // Another kiosk is not held up, and the member can use their code there.
  const elsewhere = await scan(other, { discordCode: good }); assert.equal(elsewhere.status, 202, await elsewhere.clone().text());
  context.mock.timers.tick(29_000);
  await refuse("000000", 1, "Too many wrong codes. Try again in 1 second.");
  context.mock.timers.tick(1_000);
  assert.deepEqual(await json(await wrong()), { ...invalid, retryAt: new Date(Date.now() + 60_000).toISOString(), retryAfterSeconds: 60 });
  await refuse("000000", 60, "Too many wrong codes. Try again in 1 minute.");
  context.mock.timers.tick(60_000);
  assert.deepEqual(await json(await wrong()), { ...invalid, retryAt: new Date(Date.now() + 300_000).toISOString(), retryAfterSeconds: 300 });
  context.mock.timers.tick(300_000);
  assert.deepEqual(await json(await wrong()), { ...invalid, retryAt: new Date(Date.now() + 300_000).toISOString(), retryAfterSeconds: 300 }, "capped at 5 minutes");
  assert.equal(kioskRow(kiosk.kioskId).failures, 8);
  assert.equal(kioskRow(other.kioskId).failures, 0);

  // A correct code once the wait is over starts the count again: the next wrong code is free.
  context.mock.timers.tick(300_000);
  const reset = await scan(kiosk, { discordCode: await newCode(discordB) }); assert.equal(reset.status, 202, await reset.clone().text());
  assert.deepEqual([kioskRow(kiosk.kioskId).failures, kioskRow(kiosk.kioskId).throttleUntil], [0, null]);
  assert.deepEqual(await json(await wrong()), invalid);
  assert.equal(revision(), before, "wrong tries never bump the kiosk roster");
  // Turning the mode off and on again also starts the count over.
  for (let attempt = 2; attempt <= 5; attempt += 1) await wrong();
  assert.equal((await wrong()).status, 429);
  assert.equal((await setMethod(kiosk.kioskId, { discordCode: false })).status, 200);
  assert.deepEqual([kioskRow(kiosk.kioskId).failures, kioskRow(kiosk.kioskId).throttleUntil], [0, null]);
});

test("the Admin setting validates Discord code mode and reaches the kiosk list, configuration and poll", async (context) => {
  const { database, call, pairWeb, setMethod, kioskRow } = await fixture(context);
  const kiosk = await pairWeb("Test Web Kiosk A");
  const settings = async () => {
    const config = (await (await call("/kiosk/config", undefined, kiosk.kioskToken)).json() as { settings: Record<string, unknown> }).settings;
    const poll = (await (await call("/kiosk/poll?v=1&config=1", undefined, kiosk.kioskToken)).json() as { configuration: { settings: Record<string, unknown> } }).configuration.settings;
    const listed = (await (await call("/admin/kiosks")).json() as { kiosks: Record<string, unknown>[] }).kiosks.find((item) => item.id === kiosk.kioskId)!;
    for (const source of [config, poll, listed]) assert.deepEqual([typeof source.discordCode, typeof source.discordCodeBackup], ["boolean", "string"]);
    assert.deepEqual([poll.discordCode, poll.discordCodeBackup, poll.requirePin, poll.memberLookup], [config.discordCode, config.discordCodeBackup, config.requirePin, config.memberLookup], "the poll and /kiosk/config agree");
    assert.deepEqual([listed.discordCode, listed.discordCodeBackup], [config.discordCode, config.discordCodeBackup], "and so does the Kiosks page");
    return { discordCode: config.discordCode, discordCodeBackup: config.discordCodeBackup };
  };
  assert.deepEqual(await settings(), { discordCode: false, discordCodeBackup: "offline" }, "off on a newly paired kiosk");

  const saved = await setMethod(kiosk.kioskId, { memberLookup: "search", discordCode: true, discordCodeBackup: "always" }); assert.equal(saved.status, 200);
  assert.deepEqual(await json(saved), { kioskId: kiosk.kioskId, authenticationMethod: "member_id", memberLookup: "search", requirePin: false, discordCode: true, discordCodeBackup: "always" });
  assert.deepEqual(await settings(), { discordCode: true, discordCodeBackup: "always" });
  const audit = database.rows<{ metadata_json: string }>("SELECT metadata_json FROM audit_log WHERE action = 'kiosk.authentication_method_updated' ORDER BY created_at DESC, rowid DESC LIMIT 1")[0]!;
  assert.deepEqual(JSON.parse(audit.metadata_json), { previousMethod: "member_id", authenticationMethod: "member_id", previousMemberLookup: "entry", memberLookup: "search", previousRequirePin: false, requirePin: false, previousDiscordCode: false, discordCode: true, previousDiscordCodeBackup: "offline", discordCodeBackup: "always" });

  // A save that does not mention them keeps both, and keeps member search.
  assert.deepEqual(await json(await setMethod(kiosk.kioskId, { requirePin: true })), { kioskId: kiosk.kioskId, authenticationMethod: "member_id", memberLookup: "search", requirePin: true, discordCode: true, discordCodeBackup: "always" });
  assert.deepEqual(await json(await setMethod(kiosk.kioskId, { discordCodeBackup: "offline" })), { kioskId: kiosk.kioskId, authenticationMethod: "member_id", memberLookup: "search", requirePin: true, discordCode: true, discordCodeBackup: "offline" });
  assert.deepEqual(await settings(), { discordCode: true, discordCodeBackup: "offline" });

  // Invalid values, and Discord codes with any method but member ID, are refused and change nothing.
  for (const body of [{ discordCode: "yes" }, { discordCode: 1 }, { discordCodeBackup: "never" }, { discordCodeBackup: true }, { authenticationMethod: "fingerprint", discordCode: true }]) {
    const refused = await setMethod(kiosk.kioskId, body); assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.match(String((await json(await setMethod(kiosk.kioskId, { authenticationMethod: "nfc", discordCode: true }))).error), /Discord codes can be turned on only with the member ID method/);
  assert.deepEqual(await settings(), { discordCode: true, discordCodeBackup: "offline" });

  // A Pi kiosk that moves to another method loses Discord codes, keeps the backup choice, and reports off even if an older row disagrees.
  const created = await call("/admin/pairing-codes", { kioskName: "Test Pi Kiosk A" }); const pi = await (await call("/kiosk/pair", { code: (await created.json() as { code: string }).code, kioskName: "Test Pi Kiosk A" })).json() as { kioskId: string; kioskToken: string };
  assert.equal((await setMethod(pi.kioskId, { discordCode: true, discordCodeBackup: "always" })).status, 200);
  assert.deepEqual(await json(await setMethod(pi.kioskId, { authenticationMethod: "fingerprint" })), { kioskId: pi.kioskId, authenticationMethod: "fingerprint", memberLookup: "entry", requirePin: false, discordCode: false, discordCodeBackup: "always" });
  assert.deepEqual([kioskRow(pi.kioskId).discordCode, kioskRow(pi.kioskId).backup], [0, "always"]);
  database.raw.prepare("UPDATE kiosks SET discord_code = 1 WHERE id = ?").run(pi.kioskId);
  const piPoll = (await (await call("/kiosk/poll?v=1&config=1", undefined, pi.kioskToken)).json() as { configuration: { settings: Record<string, unknown> } }).configuration.settings;
  const piConfig = (await (await call("/kiosk/config", undefined, pi.kioskToken)).json() as { settings: Record<string, unknown> }).settings;
  assert.deepEqual([piPoll.discordCode, piConfig.discordCode, piPoll.discordCodeBackup, piConfig.discordCodeBackup], [false, false, "always", "always"]);
  assert.equal((await call("/kiosk/attendance", { eventId: "test-pi-code", occurredAt: new Date().toISOString(), discordCode: "123456" }, pi.kioskToken)).status, 409);
});

test("used and expired codes are pruned, and live ones are kept", async (context) => {
  const { database, newCode } = await fixture(context);
  await newCode(discordA); await newCode(discordB);
  database.raw.exec(`UPDATE members SET discord_user_id = '${discordUnlinked}' WHERE id = 'member'`); await newCode(discordUnlinked);
  database.raw.exec("UPDATE discord_kiosk_codes SET used_at = '2026-09-30T12:00:01.000Z' WHERE member_id = 'test-a'");
  database.raw.exec("UPDATE discord_kiosk_codes SET expires_at = '2026-09-30T11:59:59.000Z' WHERE member_id = 'test-b'");
  await pruneDiscordKioskCodes(database);
  assert.deepEqual(database.rows("SELECT member_id FROM discord_kiosk_codes"), [{ member_id: "member" }]);
});

test("schema 52 backups carry each kiosk's Discord code setting; codes and the throttle never travel", async (context) => {
  const { database, call, pairWeb, setMethod, newCode, kioskRow } = await fixture(context);
  const kiosk = await pairWeb("Test Web Kiosk A");
  assert.equal((await setMethod(kiosk.kioskId, { discordCode: true, discordCodeBackup: "always" })).status, 200);
  await newCode(discordA);
  database.raw.exec("UPDATE kiosks SET discord_code_failures = 6, discord_code_throttle_until = '2026-09-30T12:05:00.000Z'");
  const exported = await call("/admin/data/backup?scope=installation"); assert.equal(exported.status, 200, await exported.clone().text());
  const backup = await exported.json() as any;
  assert.equal(backup.schemaVersion, 52);
  assert.deepEqual([backup.tables.kiosks[0].discord_code, backup.tables.kiosks[0].discord_code_backup], [1, "always"]);
  assert.equal("discord_code_failures" in backup.tables.kiosks[0], false); assert.equal("discord_code_throttle_until" in backup.tables.kiosks[0], false);
  assert.equal("discord_kiosk_codes" in backup.tables, false, "codes last two minutes and never travel");

  const restore = (source: unknown) => call("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: source });
  for (const corrupt of [
    (copy: any) => { copy.tables.kiosks[0].discord_code = 2; },
    (copy: any) => { copy.tables.kiosks[0].discord_code_backup = "never"; },
    (copy: any) => { copy.tables.kiosks[0].discord_code_backup = null; },
    (copy: any) => { copy.tables.kiosks[0].configured_authentication_method = "fingerprint"; copy.tables.kiosks[0].kind = "pi"; },
  ]) {
    const copy = structuredClone(backup); corrupt(copy);
    const refused = await restore(copy); assert.equal(refused.status, 400);
    assert.match((await refused.json() as { error: string }).error, /invalid kiosk Discord code setting/);
  }
  database.raw.exec("UPDATE kiosks SET discord_code = 0, discord_code_backup = 'offline'");
  const restored = await restore(backup); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(kioskRow(kiosk.kioskId), { discordCode: 1, backup: "always", failures: 0, throttleUntil: null, requirePin: 0 }, "the setting restores and the throttle starts over");
  assert.equal(database.count("SELECT COUNT(*) AS n FROM discord_kiosk_codes"), 0, "a restore leaves no codes behind");

  // A schema 51 backup restores every kiosk with Discord codes off and the backup choice at offline.
  const legacy = structuredClone(backup); legacy.schemaVersion = 51; omitContestResubmissionFields(legacy);
  assert.equal("discord_code" in legacy.tables.kiosks[0], false); assert.equal("discord_code_backup" in legacy.tables.kiosks[0], false);
  const stray = structuredClone(legacy); stray.tables.kiosks[0].discord_code = 1;
  assert.equal((await restore(stray)).status, 400, "a schema 51 archive never carried the setting");
  const older = await restore(legacy); assert.equal(older.status, 200, await older.clone().text());
  assert.deepEqual([kioskRow(kiosk.kioskId).discordCode, kioskRow(kiosk.kioskId).backup], [0, "offline"]);
});
