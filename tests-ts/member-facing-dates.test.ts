// quick-check: covers apps/api/migrations/**
// Meeting dates in member-facing emails and Discord messages are the organization's calendar day, written as the dashboard
// writes them, not a UTC slice: an evening Pacific meeting is not reported on the next day, nor a morning one east of UTC
// on the day before. Every person, address and credential here is synthetic; Resend and Discord are fakes.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import worker, { registeredCoreSchedulerJobs, registeredModuleSchedulerJobs, type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { memberDateText } from "../apps/api/src/member-date-text.ts";
import { TestD1Database } from "./fixtures/d1-database.ts";
import { FakeDatabase, sessionSecret } from "./fixtures/worker-fake-database.ts";

const secret = sessionSecret;
const origin = "https://dashboard.example.test";
// 18:30 on Friday Oct 16 in Los Angeles (PDT, UTC-7) is 01:30 UTC on Oct 17.
const pacificEvening = { startsAt: "2026-10-17T01:30:00.000Z", endsAt: "2026-10-17T03:30:00.000Z" };
// 08:00 on Saturday Oct 17 in Tokyo (UTC+9) is 23:00 UTC on Oct 16.
const tokyoMorning = { startsAt: "2026-10-16T23:00:00.000Z", endsAt: "2026-10-17T01:00:00.000Z" };

test("memberDateText writes the organization's calendar day like the dashboard", () => {
  assert.equal(memberDateText(pacificEvening.startsAt, "America/Los_Angeles"), "Oct 16, 2026");
  assert.equal(memberDateText(pacificEvening.startsAt, "UTC"), "Oct 17, 2026");
  assert.equal(memberDateText(tokyoMorning.startsAt, "Asia/Tokyo"), "Oct 17, 2026");
  assert.equal(memberDateText(tokyoMorning.startsAt, "UTC"), "Oct 16, 2026");
  // 11:00 on Nov 20 in Auckland (NZDT, UTC+13) is 22:00 UTC on Nov 19.
  assert.equal(memberDateText("2026-11-19T22:00:00.000Z", "Pacific/Auckland"), "Nov 20, 2026");
  assert.equal(memberDateText(pacificEvening.startsAt, null), "Oct 17, 2026", "no time zone falls back to UTC");
  assert.equal(memberDateText(pacificEvening.startsAt, "Not/A_Zone"), "Oct 17, 2026", "an unknown time zone falls back to UTC");
  assert.equal(memberDateText("not a date", "UTC"), "");
});

class Database extends TestD1Database {
  constructor(timeZone: string, meeting: { startsAt: string; endsAt: string }, discordUserId: string | null = null) {
    super({ seed: `INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','both');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','${timeZone}');
      INSERT INTO users(id,installation_id,email,local_username,role,created_at) VALUES('admin','primary','test.admin.a@example.test','admin','admin','2026-01-01');
      INSERT INTO platform_module_administration VALUES('primary',0,1); INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES('primary','attendance',1,1,'enabled',2,1,0);
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,active,created_at,attendance_required_from,discord_user_id) VALUES('member-a','primary','T-A','Test Student','A','test.student.a@example.test',1,'2026-01-01','2026-01-01',${discordUserId ? `'${discordUserId}'` : "NULL"});
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES('meeting-a','primary','Test Build Night','${meeting.startsAt}','${meeting.endsAt}',1,'admin','2026-01-01');` });
  }
}
async function emailEnvironment(db: Database) {
  const encrypted = await encryptIntegration({ apiKey: "re_synthetic", fromEmail: "attendance@example.test" }, secret);
  db.sqlite.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES('resend-1','primary','resend',?,?,'2026-01-01','2026-01-01')").run(encrypted.ciphertext, encrypted.iv);
  db.sqlite.exec("UPDATE installations SET resend_enabled = 1 WHERE id = 'primary'");
  return { APP_MODE: "configured", ALLOWED_ORIGIN: origin, SESSION_KEY: secret, INTEGRATION_KEY: secret, DB: db } as unknown as Env;
}
async function sentEmail(context: TestContext, timeZone: string, meeting: { startsAt: string; endsAt: string }, body: Record<string, unknown>) {
  const db = new Database(timeZone, meeting); context.after(() => db.close());
  const env = await emailEnvironment(db); let html = "";
  const fake = context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => { html = JSON.parse(String(init?.body)).html; return Response.json({ id: "email-1" }); });
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  const result = await worker.fetch(new Request("https://api.example.test/communications/email", { method: "POST", headers: { origin, "content-type": "application/json", cookie }, body: JSON.stringify({ memberId: "member-a", ...body }) }), env);
  fake.mock.restore();
  assert.equal(result.status, 202, await result.clone().text());
  return html;
}

test("a missed-meeting email names the meeting's local day, west and east of UTC", async (context) => {
  const pacific = await sentEmail(context, "America/Los_Angeles", pacificEvening, { kind: "missed-meeting", meetingId: "meeting-a" });
  assert.match(pacific, /missed <strong>Test Build Night<\/strong> on Oct 16, 2026\./);
  const tokyo = await sentEmail(context, "Asia/Tokyo", tokyoMorning, { kind: "missed-meeting", meetingId: "meeting-a" });
  assert.match(tokyo, /missed <strong>Test Build Night<\/strong> on Oct 17, 2026\./);
});

test("an attendance report email dates each meeting by its local day", async (context) => {
  const pacific = await sentEmail(context, "America/Los_Angeles", pacificEvening, { kind: "individual-report" });
  assert.match(pacific, /<td>Test Build Night<\/td><td>Oct 16, 2026<\/td>/);
  const tokyo = await sentEmail(context, "Asia/Tokyo", tokyoMorning, { kind: "individual-report" });
  assert.match(tokyo, /<td>Test Build Night<\/td><td>Oct 17, 2026<\/td>/);
});

const signedInteraction = (payload: unknown, privateKey: KeyObject) => {
  const body = JSON.stringify(payload); const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex"), "x-signature-timestamp": timestamp }, body });
};

test("the Discord /attendance-report list of missed meetings dates each by its local day", async (context) => {
  const discordUserId = "323456789012345678";
  for (const [timeZone, meeting, expected] of [["America/Los_Angeles", pacificEvening, "Oct 16, 2026"], ["Asia/Tokyo", tokyoMorning, "Oct 17, 2026"]] as const) {
    const db = new Database(timeZone, meeting, discordUserId); context.after(() => db.close());
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const encrypted = await encryptIntegration({ applicationId: "1", botToken: "synthetic", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") }, secret);
    db.sqlite.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES('discord-1','primary','discord',?,?,'2026-01-01','2026-01-01')").run(encrypted.ciphertext, encrypted.iv);
    db.sqlite.exec("UPDATE installations SET discord_enabled = 1 WHERE id = 'primary'");
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: origin, SESSION_KEY: secret, INTEGRATION_KEY: secret, DB: db } as unknown as Env;
    const result = await worker.fetch(signedInteraction({ type: 2, guild_id: "123456789012345678", data: { name: "attendance-report" }, member: { user: { id: discordUserId } } }, privateKey), env);
    assert.equal(result.status, 200, await result.clone().text());
    const content = (await result.json() as { data: { content: string } }).data.content;
    assert.match(content, new RegExp(`\\n• ${expected} - Test Build Night \\(`), content);
  }
});

test("a Discord anomaly report header names the meeting's local day", async (context) => {
  const now = Date.now();
  // The latest 02:30 UTC at least three hours ago: the evening before in Los Angeles, whatever the season.
  let startsAt = new Date(now); startsAt.setUTCHours(2, 30, 0, 0);
  if (startsAt.getTime() > now - 3 * 3_600_000) startsAt = new Date(startsAt.getTime() - 86_400_000);
  const meeting = { id: "meeting-a", title: "Test Build Night", startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString() };
  const expected = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "short", day: "numeric" }).format(startsAt);
  assert.notEqual(expected, new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(startsAt));

  const database = new FakeDatabase();
  const discord = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, secret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...discord, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 0 });
  database.rows.set("anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes", { lateScanMinutes: 30, anomalyLateThresholdMinutes: 10, anomalyEarlyThresholdMinutes: 10, enabled: 1, channelId: "323456789012345678", enabledAt: new Date(now - 3 * 86_400_000).toISOString(), timeZone: "America/Los_Angeles" });
  database.lists.set("LEFT JOIN discord_anomaly_reports", [meeting]);
  database.lists.set("SELECT m.external_id AS memberId", [{ memberId: "TEST-A", firstName: "Test Student", lastName: "A", checkedInAt: new Date(startsAt.getTime() + 20 * 60_000).toISOString(), checkedOutAt: meeting.endsAt }]);
  database.lists.set("LEFT JOIN discord_attendance_notifications", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: origin, SESSION_KEY: secret, INTEGRATION_KEY: secret, DB: database } as unknown as Env;
  const messages: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => { if (String(input).endsWith("/channels/323456789012345678/messages")) messages.push(JSON.parse(String(init?.body)).content); return Response.json({ id: "message-1" }); });
  context.mock.method(console, "log", () => {});
  const jobIds = [...registeredCoreSchedulerJobs, ...registeredModuleSchedulerJobs].map((job) => job.id);
  await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: jobIds.indexOf("attendance.discord-anomalies") * 300_000 } as never, env);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, new RegExp(`^\\*\\*Attendance anomalies · Test Build Night\\*\\*\\nMeeting date: ${expected}\\n• Test Student A \\(TEST-A\\) — arrived 20 min late`));
});
