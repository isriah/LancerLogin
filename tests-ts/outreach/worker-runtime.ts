import { omitContestResubmissionFields } from "../fixtures/backup-versions.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import worker, { type Env } from "../../apps/api/src/index.ts";
import { encryptIntegration } from "../../apps/api/src/integration-crypto.ts";
import { defaultReportDefinition } from "../../apps/api/src/report-builder.ts";
import { FakeDatabase, request, seedInstallationBackupFoundation, sessionCookie, sessionSecret, setupCodeHash } from "../fixtures/worker-fake-database.ts";

function seedPolicy(database: FakeDatabase, options: {
  members?: Record<string, unknown>[]; meetings?: Record<string, unknown>[]; labels?: Record<string, unknown>[];
  changes?: Record<string, unknown>[]; targets?: Record<string, unknown>[]; rules?: Record<string, unknown>[]; audience?: Record<string, unknown>[];
  events?: Record<string, unknown>[]; corrections?: Record<string, unknown>[]; baseline?: string | null;
} = {}) {
  database.lists.set("SELECT id, external_id AS memberId, first_name AS firstName", options.members ?? []);
  database.lists.set("SELECT id, name, active, formula_enabled AS formulaEnabled FROM member_labels", options.labels ?? []);
  database.lists.set("SELECT member_id AS memberId, label_id AS labelId, action, effective_date AS effectiveDate", options.changes ?? []);
  database.lists.set("rule_type AS ruleType, threshold_percent AS thresholdPercent", options.rules ?? []);
  database.lists.set("SELECT id, label_id AS labelId, starts_on AS startsOn", options.targets ?? []);
  database.lists.set("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, required, attendance_weight AS attendanceWeight", options.meetings ?? []);
  database.lists.set("SELECT meeting_id AS meetingId, label_id AS labelId FROM meeting_audience_labels", options.audience ?? []);
  database.lists.set("SELECT e.meeting_id AS meetingId, e.member_id AS memberId", options.events ?? []);
  database.lists.set("SELECT c.meeting_id AS meetingId, c.member_id AS memberId", options.corrections ?? []);
  database.rows.set("SELECT time_zone AS timeZone, late_scan_minutes AS lateScanMinutes, attendance_reporting_starts_on AS baseline", { timeZone: "UTC", lateScanMinutes: 30, baseline: options.baseline ?? null });
  database.rows.set("SELECT attendance_reporting_starts_on AS baseline, time_zone AS timeZone", { timeZone: "UTC", baseline: options.baseline ?? null });
}


test("public form privacy is Admin-only and HTTP lookup responses are noncacheable exact projections", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  assert.equal((await worker.fetch(request("/admin/hours/public-form-settings"), env)).status, 401);
  assert.equal((await worker.fetch(request("/admin/hours/public-form-settings", undefined, { cookie: await sessionCookie("operator") }), env)).status, 403);
  database.rows.set("SELECT COALESCE(s.member_validation", { memberValidation: "off", revision: 0 });
  assert.equal((await worker.fetch(request("/admin/hours/public-form-settings", undefined, { cookie: await sessionCookie("admin") }), env)).status, 200);
  const lookup = (origin = "https://dashboard.example.test") => worker.fetch(new Request("https://api.example.test/public/hours/member-validation", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ memberExternalId: "SYN-001" }) }), env);
  let result = await lookup();
  assert.deepEqual(await result.json(), { mode: "off" });
  assert.match(result.headers.get("cache-control") ?? "", /no-store/); assert.equal(result.headers.get("pragma"), "no-cache");
  assert.equal(database.calls.some(call => call.sql.includes("FROM members")), false);
  database.rows.set("FROM hours_public_form_settings WHERE", { memberValidation: "validity", revision: 1 });
  database.rows.set("SELECT generation FROM platform_modules WHERE", { generation: 1 });
  database.lists.set("RETURNING attempts", [{ attempts: 1 }]);
  database.rows.set("SELECT 1 AS valid FROM members", { valid: 1 });
  result = await lookup(); assert.deepEqual(await result.json(), { mode: "validity", valid: true });
  assert.equal(database.calls.some(call => /first_name|last_name/.test(call.sql)), false);
  assert.equal((await lookup("https://other.example.test")).status, 403);
  database.rows.set("FROM hours_public_form_settings WHERE", { memberValidation: "name", revision: 2 });
  database.rows.set("SELECT trim(first_name||' '||last_name) AS name", { name: "Synthetic Avery Member", email: "must-not-leak@example.test", externalId: "must-not-leak" });
  result = await lookup(); assert.deepEqual(await result.json(), { mode: "name", valid: true, name: "Synthetic Avery Member" });
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
});
test("local Worker bootstrap creates a salted Admin and ignores legacy telemetry consent", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", BOOTSTRAP_CODE_HASH: setupCodeHash, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/setup/bootstrap", { organizationName: "Example Arts Club", timeZone: "America/New_York", authMode: "local", localUsername: "director", localPassword: "correct horse battery staple", telemetryAccepted: true }), env);
  assert.equal(result.status, 201);
  assert.equal(database.batches.length, 1);
  // Attendance and official Outreach registration plus the setup-code claim; plugins register here and through
  // reconciliation. Outreach, now a plugin, creates its default settings and labels on first enablement instead
  // (tests-ts/outreach-fresh-installation.test.ts).
  assert.equal(database.batches[0].length, 13);
  assert.ok(database.batches[0].some((statement) => statement.sql.includes("INSERT OR IGNORE INTO bootstrap_code_claims")));
  assert.equal(database.batches[0].filter((statement) => statement.sql.includes("INSERT INTO hours_categories")).length, 0);
  assert.equal(database.batches[0].some((statement) => statement.sql.includes("INSERT INTO hours_publication_settings")), false);
  assert.deepEqual(database.batches[0].filter((statement) => statement.sql.includes("INSERT INTO platform_modules ")).map((statement) => statement.values), [["attendance", 1, 2], ["hour-tracking", 1, 1]]);
  const userInsert = database.batches[0].find((statement) => statement.sql.includes("INSERT INTO users"));
  assert.match(String(userInsert?.values[4]), /^scrypt\$/);
  const installationInsert = database.batches[0].find((statement) => statement.sql.includes("INSERT INTO installations"));
  assert.equal(installationInsert?.values[3], null);
  assert.equal(installationInsert?.values[4], null);
  assert.equal((await result.json() as { telemetryAccepted: boolean }).telemetryAccepted, false);
});

test("shared report visibility does not grant access to an unavailable module dataset", async () => {
  const database = new FakeDatabase(); seedPolicy(database);
  database.lists.set("SELECT id,name,archived FROM hours_labels", [{ id: "private-outreach-label", name: "Private Outreach label", archived: 0 }]);
  const definition = defaultReportDefinition(false, "outreach.activities");
  database.rows.set("SELECT m.generation FROM users u", (_sql, values) => values[0] === "attendance" ? { generation: 1 } : undefined);
  database.lists.set("FROM saved_report_views v", [{ id: "shared-outreach", ownerUserId: "admin-1", scope: "shared", name: "Outreach activities", definitionJson: JSON.stringify(definition), revision: 1, createdBy: "admin-1", updatedBy: "admin-1", createdAt: "2026-09-28", updatedAt: "2026-09-28", pinnedPosition: null }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("operator");
  const catalog = await (await worker.fetch(request("/reports/catalog", undefined, { cookie }), env)).json() as { datasets: Array<{ id: string; available: boolean }>; reportFilters: Array<{ id: string; options: Array<{ id: string }> }> };
  assert.equal(catalog.datasets.find((dataset) => dataset.id === "outreach.activities")?.available, false);
  assert.equal(catalog.datasets.find((dataset) => dataset.id === "attendance.members")?.available, true);
  assert.deepEqual(catalog.reportFilters.find((filter) => filter.id === "outreach-labels")?.options, []);
  const library = await (await worker.fetch(request("/reports/views", undefined, { cookie }), env)).json() as { reports: Array<{ id: string; definition: { dataset: string } }> };
  assert.deepEqual(library.reports.map((report) => [report.id, report.definition.dataset]), [["shared-outreach", "outreach.activities"]]);
  const result = await worker.fetch(request("/reports/query", { definition }, { cookie }), env);
  assert.equal(result.status, 200);
  const paused = await result.json() as { state: string; pausedReasons: string[]; rows: unknown[] };
  assert.equal(paused.state, "paused");
  assert.match(paused.pausedReasons.join(" "), /Outreach Participation is unavailable/);
  assert.deepEqual(paused.rows, []);
  const exported = await worker.fetch(request("/exports/report.csv", { definition }, { cookie }), env);
  assert.equal(exported.status, 409);
  assert.equal(database.calls.some((call) => call.sql.includes("FROM hours_activities")), false);
});

test("combined member reports mute unavailable measures and pause unavailable controls and exports", async () => {
  const member = { id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", email: null, discordUserId: null, active: 1, attendanceRequiredFrom: "2026-09-01" };
  const meeting = { id: "meeting-1", title: "Build", startsAt: "2026-09-02T20:00:00.000Z", endsAt: "2026-09-02T21:00:00.000Z", attendanceClosesAt: "2026-09-02T21:30:00.000Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 };
  const database = new FakeDatabase(); seedPolicy(database, { members: [member], meetings: [meeting], corrections: [{ meetingId: "meeting-1", memberId: "member-1", disposition: "present", reason: "Synthetic" }] });
  database.rows.set("SELECT m.generation FROM users u", (_sql, values) => values[0] === "attendance" ? { generation: 1 } : undefined);
  database.lists.set("SELECT c.member_id AS memberId, c.label_id AS labelId", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("operator"); const definition = defaultReportDefinition(false, "core.combined-members");
  const result = await worker.fetch(request("/reports/query", { definition }, { cookie }), env);
  assert.equal(result.status, 200);
  const body = await result.json() as { state: string; warnings: string[]; columns: Array<{ key: string; available: boolean }>; rows: Array<{ cells: Record<string, { text: string; unavailable?: boolean }> }> };
  assert.equal(body.state, "ready");
  assert.equal(body.rows[0]?.cells["attendance.member.regular-rate"]?.text, "100%");
  assert.deepEqual(body.rows[0]?.cells["outreach.member.minutes"], { text: "Unavailable", sortValue: null, unavailable: true, explanation: "Outreach Participation is unavailable for your current module access. It will return when access is restored." });
  assert.equal(body.columns.find((column) => column.key === "outreach.member.minutes")?.available, false);
  assert.match(body.warnings.join(" "), /muted without cached or zero values/);
  assert.equal(database.calls.some((call) => call.sql.includes("FROM hours_entries")), false);

  const csv = await worker.fetch(request("/exports/report.csv", { definition }, { cookie }), env);
  assert.equal(csv.status, 200); assert.match(await csv.text(), /Unavailable/);
  const controlled = { ...definition, sort: { column: { key: "outreach.member.minutes" }, direction: "desc" as const } };
  const paused = await worker.fetch(request("/reports/query", { definition: controlled }, { cookie }), env);
  assert.equal(paused.status, 200); assert.equal((await paused.json() as { state: string }).state, "paused");
  assert.equal((await worker.fetch(request("/exports/report.csv", { definition: controlled }, { cookie }), env)).status, 409);
  const historical = { ...definition, membership: "historical" as const };
  const historicalResult = await worker.fetch(request("/reports/query", { definition: historical }, { cookie }), env);
  assert.equal((await historicalResult.json() as { state: string }).state, "ready");
});

test("Members detailed exports preserve cross-module filters, order and period with permission-scoped attendance", async () => {
  const database = new FakeDatabase();
  seedPolicy(database, {
    members: ["Avery", "Blair", "Casey"].map((firstName, index) => ({ id: `member-${index}`, memberId: `M-${index}`, firstName, lastName: "Member", email: null, discordUserId: null, active: 1, attendanceRequiredFrom: "2026-09-01" })),
    meetings: [1, 2].map((day) => ({ id: `meeting-${day}`, title: `Meeting ${day}`, startsAt: `2026-09-0${day}T20:00:00Z`, endsAt: `2026-09-0${day}T21:00:00Z`, required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 })),
  });
  database.lists.set("SELECT c.member_id AS memberId, c.label_id AS labelId", []);
  database.lists.set("FROM hours_entries e JOIN hours_activities", [30, 90, 120].map((durationMinutes, index) => ({ id: `entry-${index}`, memberId: `member-${index}`, activityId: "activity-1", activityTitle: "Community event", serviceDate: "2026-09-02", durationMinutes, channel: "staff", status: "counted", activityMode: "event", teamId: null, activityLabels: "[]" })));
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const definition = { ...defaultReportDefinition(false, "core.combined-members"), period: { type: "fixed", from: "2026-09-02", to: "2026-09-02" }, columnFilters: [{ column: { key: "outreach.member.minutes", unit: "hours" }, operator: "minimum", value: "1" }], sort: { column: { key: "outreach.member.minutes", unit: "hours" }, direction: "desc" } };
  for (const role of ["admin", "operator"] as const) {
    const cookie = await sessionCookie(role);
    const detail = await worker.fetch(request("/exports/report-detail.csv", { definition }, { cookie }), env);
    assert.equal(detail.status, 200, await detail.clone().text());
    const csv = await detail.text();
    assert.equal(csv.trim().split("\r\n").length, 3);
    assert.ok(csv.indexOf("Casey") < csv.indexOf("Blair"));
    assert.doesNotMatch(csv, /Avery|Meeting 1/);
    assert.match(csv, /Meeting 2/);
  }
  const rangeDefinition = { ...definition, columnFilters: [{ column: { key: "outreach.member.minutes", unit: "hours" }, operator: "between", value: "0.5", upperValue: "1.5" }] };
  const rangeExport = await worker.fetch(request("/exports/report-detail.csv", { definition: rangeDefinition }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(rangeExport.status, 200);
  const rangeCsv = await rangeExport.text();
  assert.match(rangeCsv, /Avery/); assert.match(rangeCsv, /Blair/); assert.doesNotMatch(rangeCsv, /Casey/);
  const cookie = await sessionCookie("operator");
  database.rows.set("SELECT m.generation FROM users u", (_sql, values) => values[0] === "hour-tracking" ? { generation: 1 } : undefined);
  const forbidden = await worker.fetch(request("/exports/report-detail.csv", { definition }, { cookie }), env);
  assert.equal(forbidden.status, 403);
  database.rows.set("SELECT m.generation FROM users u", (_sql, values) => values[0] === "attendance" ? { generation: 1 } : undefined);
  assert.equal((await worker.fetch(request("/exports/report-detail.csv", { definition }, { cookie }), env)).status, 409);
  assert.equal((await worker.fetch(request("/exports/report-detail.csv", { definition: defaultReportDefinition(false, "outreach.activities") }, { cookie }), env)).status, 400);
});

test("Admins and Operators can create shared reports with duration units and creation pins the new tab", async () => {
  for (const role of ["admin", "operator"] as const) {
    const definition = defaultReportDefinition(false, "outreach.members");
    definition.columnFilters = [{ column: { key: "outreach.member.minutes", unit: "hours" }, operator: "between", value: "0", upperValue: "2.5" }];
    const database = new FakeDatabase(); seedPolicy(database); database.rows.set("COALESCE(MAX(position)", { position: 2 }); database.rows.set("SELECT id, owner_user_id AS ownerUserId", { id: "report-1", ownerUserId: `${role}-1`, scope: "shared", name: "Outreach ranked members", definitionJson: JSON.stringify(definition), revision: 1, createdBy: `${role}-1`, updatedBy: `${role}-1`, createdAt: "2026-09-25", updatedAt: "2026-09-25" });
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
    const result = await worker.fetch(request("/reports/views", { name: "Outreach ranked members", scope: "shared", definition }, { cookie: await sessionCookie(role) }), env); assert.equal(result.status, 201);
    const reportInsert = database.batches[0].find((call) => call.sql.includes("INSERT INTO saved_report_views"));
    assert.ok(reportInsert?.values.includes("shared"));
    const stored = reportInsert?.values.find((value) => typeof value === "string" && value.startsWith('{"version"'));
    assert.equal((JSON.parse(String(stored)) as { columns: Array<{ key: string; unit?: string }> }).columns.find((column) => column.key === "outreach.member.minutes")?.unit, "hours");
    assert.deepEqual(JSON.parse(String(stored)).columnFilters, definition.columnFilters);
    assert.ok(database.batches[0].some((call) => call.sql.includes("INSERT INTO saved_report_tabs") && call.values.includes(2))); assert.ok(database.calls.some((call) => call.values.includes("report.created")));
  }
});

test("existing Outreach member reports without a unit normalize to hours in the saved library", async () => {
  const database = new FakeDatabase(); seedPolicy(database);
  const definition = defaultReportDefinition(false, "outreach.members");
  delete definition.columns.find((column) => column.key === "outreach.member.minutes")!.unit;
  database.lists.set("FROM saved_report_views v", [{ id: "outreach-ranked", ownerUserId: "admin-1", scope: "shared", name: "Outreach-ranked members", definitionJson: JSON.stringify(definition), revision: 1, createdBy: "admin-1", updatedBy: "admin-1", createdAt: "2026-09-25", updatedAt: "2026-09-25", pinnedPosition: 0 }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/reports/views", undefined, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 200);
  const body = await result.json() as { reports: Array<{ definition: { columns: Array<{ key: string; unit?: string }> } }> };
  assert.equal(body.reports[0]?.definition.columns.find((column) => column.key === "outreach.member.minutes")?.unit, "hours");
});

test("Discord verification reconciles the five managed guild commands before its signed user click", async () => {
  const database = new FakeDatabase(); const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", applicationId: "103456789012345678", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: null });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ input: string; init?: RequestInit }> = []; const guildCommands: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); outbound.push({ input: url, init });
    if (url.endsWith("/users/@me")) return Response.json({ id: "bot-1" });
    if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: "103456789012345678" });
    if (url.endsWith("/guilds/123456789012345678")) return Response.json({ id: "123456789012345678" });
    if (url.endsWith("/channels/223456789012345678")) return Response.json({ guild_id: "123456789012345678", type: 0 });
    if (url.endsWith("/commands")) { if (init?.method === "GET") return Response.json(guildCommands); const command = JSON.parse(String(init?.body)) as Record<string, unknown>; guildCommands.push({ ...command, id: `command-${guildCommands.length + 1}`, application_id: "103456789012345678", guild_id: "123456789012345678" }); return Response.json(guildCommands.at(-1)); }
    if (url.endsWith("/channels/223456789012345678/messages")) return Response.json({ id: "verification-message-1" });
    throw new Error(`Unexpected live request: ${url}`);
  };
  try {
    const started = await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env);
    assert.equal(started.status, 202); assert.match(outbound[0].input, /users\/@me$/); assert.match(outbound[1].input, /oauth2\/applications\/@me$/); assert.match(outbound[2].input, /guilds\/123456789012345678$/); assert.match(outbound[3].input, /channels\/223456789012345678$/); assert.match(outbound[4].input, /applications\/103456789012345678\/guilds\/123456789012345678\/commands$/); assert.equal(outbound[4].init?.method, "GET"); assert.deepEqual(outbound.slice(5, 10).map((call) => call.init?.method), ["POST", "POST", "POST", "POST", "POST"]); assert.match(outbound[11].input, /channels\/223456789012345678\/messages$/);
    assert.equal(outbound.every(({ input }) => input.startsWith("https://discord.com/api/v10/")), true); assert.equal(outbound.some(({ input }) => /\/applications\/103456789012345678\/commands$/.test(input)), false);
    assert.deepEqual(outbound.slice(5, 10).map((call) => JSON.parse(String(call.init?.body))), [{ name: "pair", type: 1, description: "Link your Discord account to your LancerLogin member ID", options: [{ name: "member-id", description: "Your LancerLogin member ID", type: 3, required: true }] }, { name: "attendance-report", type: 1, description: "Privately view your current LancerLogin attendance report" }, { name: "label", type: 1, description: "Associate a Discord role with a matching LancerLogin label", options: [{ name: "role", description: "Discord role to associate", type: 8, required: true }] }, { name: "outreach-submit", type: 1, description: "Record completed Outreach participation for your linked member", options: [{ name: "activity", description: "Dated Outreach activity reference or exact title", type: 3, required: true }, { name: "start", description: "Local start time in HH:MM format", type: 3, required: true }, { name: "end", description: "Local end time in HH:MM format", type: 3, required: true }, { name: "notes", description: "Private task notes for Staff", type: 3 }] }, { name: "outreach-correction", type: 1, description: "Ask Staff to review linked Outreach participation", options: [{ name: "message", description: "What Staff should review", type: 3, required: true }, { name: "receipt", description: "Participation receipt reference", type: 3 }, { name: "date", description: "Service date in YYYY-MM-DD format", type: 3 }] }]);
    const payload = JSON.parse(String(outbound[11].init?.body)); const customId = payload.components[0].components[0].custom_id as string; const token = customId.slice("lancerlogin-verify:".length);
    const challengeWrite = database.calls.find((call) => call.sql.includes("INSERT INTO integration_verification_challenges")); assert.ok(challengeWrite); assert.equal(challengeWrite.values[0], createHash("sha256").update(token).digest("base64url")); assert.equal(challengeWrite.values.includes(token), false);
    database.rows.set("FROM integration_verification_challenges", { challengeHash: challengeWrite.values[0], target: "123456789012345678", externalId: "verification-message-1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const body = JSON.stringify({ type: 3, guild_id: "123456789012345678", data: { custom_id: customId }, member: { user: { id: "323456789012345678" } }, message: { id: "verification-message-1" } }); const timestamp = String(Math.floor(Date.now() / 1000)); const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
    const interaction = new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, body });
    const verified = await worker.fetch(interaction, env); assert.equal(verified.status, 200); assert.match(JSON.stringify(await verified.json()), /LancerLogin is verified/); assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("UPDATE encrypted_integrations SET verified_at")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord command setup is repeat-safe across reruns and credential rotation", async () => {
  const database = new FakeDatabase(); const config = { botToken: "discord-secret", applicationId: "103456789012345678", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) };
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration(config, sessionSecret), verifiedAt: null });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const commandBodies: unknown[] = []; const guildCommands: Record<string, unknown>[] = []; const authorizations: string[] = [];
  globalThis.fetch = async (input, init) => { const url = String(input); authorizations.push(String((init?.headers as Record<string, string>).authorization)); if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: config.applicationId }); if (url.endsWith(`/guilds/${config.guildId}`)) return Response.json({ id: config.guildId }); if (url.endsWith(`/channels/${config.channelId}`)) return Response.json({ guild_id: config.guildId, type: 0 }); if (url.endsWith("/commands")) { if (init?.method === "GET") return Response.json(guildCommands); const body = JSON.parse(String(init?.body)) as Record<string, unknown>; commandBodies.push(body); const command = { ...body, id: `command-${guildCommands.length}`, application_id: config.applicationId, guild_id: config.guildId }; guildCommands.push(command); return Response.json(command); } if (url.includes("/channels/")) return Response.json({ id: crypto.randomUUID() }); return Response.json({ id: "bot-1" }); };
  try {
    assert.equal((await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env)).status, 202);
    assert.equal((await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env)).status, 202);
    const rotated = { ...config, botToken: "rotated-discord-secret" }; database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration(rotated, sessionSecret), verifiedAt: null });
    assert.equal((await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env)).status, 202);
    assert.equal(commandBodies.length, 5); assert.deepEqual(commandBodies.map((item) => (item as { name: string }).name), ["pair", "attendance-report", "label", "outreach-submit", "outreach-correction"]); assert.ok(authorizations.includes("Bot rotated-discord-secret"));
  } finally { globalThis.fetch = originalFetch; }
});

test("configured Discord integrations reconcile commands without resetting legacy or operational state", async () => {
  const applicationId = "103456789012345678"; const guildId = "123456789012345678"; const channelId = "223456789012345678";
  const run = async (savedApplicationId?: string) => {
    const database = new FakeDatabase(); const config = { botToken: "discord-secret", guildId, channelId, publicKey: "a".repeat(64), ...(savedApplicationId ? { applicationId: savedApplicationId } : {}) };
    database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration(config, sessionSecret), verifiedAt: "2026-09-04T00:01:00Z", enabled: 1 });
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const originalFetch = globalThis.fetch; const outbound: Array<{ input: string; init?: RequestInit }> = []; const guildCommands: Record<string, unknown>[] = [{ name: "unrelated", type: 1, description: "Preserve me", application_id: applicationId, guild_id: guildId }];
    globalThis.fetch = async (input, init) => {
      const url = String(input); outbound.push({ input: url, init });
      if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: applicationId });
      if (url.endsWith(`/guilds/${guildId}`)) return Response.json({ id: guildId });
      if (url.endsWith(`/channels/${channelId}`)) return Response.json({ guild_id: guildId, type: 0 });
      if (url.endsWith("/commands")) { if (init?.method === "GET") return Response.json(guildCommands); const command = JSON.parse(String(init?.body)) as Record<string, unknown>; const saved = { ...command, id: `command-${guildCommands.length}`, application_id: applicationId, guild_id: guildId }; guildCommands.push(saved); return Response.json(saved); }
      throw new Error(`Unexpected live request: ${url}`);
    };
    try {
      assert.equal((await worker.fetch(request("/admin/integrations/discord/commands/reconcile", {}, { method: "POST", cookie: await sessionCookie("operator") }), env)).status, 403);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await worker.fetch(request("/admin/integrations/discord/commands/reconcile", {}, { method: "POST", cookie: await sessionCookie("admin") }), env);
        assert.equal(result.status, 200); assert.deepEqual(await result.json(), { provider: "discord", reconciled: true, commands: ["pair", "attendance-report", "label", "outreach-submit", "outreach-correction"] });
      }
      assert.equal(outbound.filter(({ input }) => input.endsWith("/commands")).length, 9);
      assert.equal(outbound.filter(({ input, init }) => input.endsWith("/commands") && init?.method === "POST").length, 5);
      assert.equal(guildCommands[0].name, "unrelated");
      assert.ok(outbound.filter(({ input }) => input.endsWith("/commands")).every(({ input }) => input.endsWith(`/applications/${applicationId}/guilds/${guildId}/commands`)));
      assert.equal(database.batches.length, 2);
      assert.equal(database.calls.some((call) => /UPDATE encrypted_integrations|integration_verification_challenges|discord_calendar_|UPDATE organization_settings/.test(call.sql)), false);
      assert.equal(database.calls.filter((call) => call.values.includes("discord.commands_reconciled")).length, 2);
    } finally { globalThis.fetch = originalFetch; }
  };
  await run();
  await run(applicationId);
});

test("verified Discord commands register automatically once for each command definition", async () => {
  const applicationId = "103456789012345678", guildId = "123456789012345678", channelId = "223456789012345678";
  const database = new FakeDatabase();
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration({ botToken: "discord-secret", applicationId, guildId, channelId }, sessionSecret), verifiedAt: "2026-09-04T00:01:00Z", enabled: 1 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: string[] = []; const guildCommands: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); outbound.push(url);
    if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: applicationId });
    if (url.endsWith(`/guilds/${guildId}`)) return Response.json({ id: guildId });
    if (url.endsWith(`/channels/${channelId}`)) return Response.json({ guild_id: guildId, type: 0 });
    if (url.endsWith("/commands")) { if (init?.method === "GET") return Response.json(guildCommands); const command = { ...(JSON.parse(String(init?.body)) as Record<string, unknown>), application_id: applicationId, guild_id: guildId }; guildCommands.push(command); return Response.json(command); }
    throw new Error(`Unexpected Discord request: ${url}`);
  };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.filter((url) => url.endsWith("/commands")).length, 7);
    const saved = database.batches.flat().find((item) => item.sql.includes("'managed-commands'"));
    assert.ok(saved);
    database.rows.set("SELECT content_hash AS fingerprint FROM integration_state", { fingerprint: saved.values[1] });
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.filter((url) => url.endsWith("/commands")).length, 7);
  } finally { globalThis.fetch = originalFetch; }
});

test("opening Integrations runs the guarded Discord command reconcile only while commands are pending", async () => {
  const applicationId = "103456789012345678", guildId = "123456789012345678", channelId = "223456789012345678";
  const setup = async (claimHeld = false) => {
    const database = new FakeDatabase();
    database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration({ botToken: "discord-secret", applicationId, guildId, channelId }, sessionSecret), verifiedAt: "2026-09-04T00:01:00Z", enabled: 1 });
    // The status query reads back whatever success row the reconcile saved, as D1 would.
    database.lists.set("state_key IN ('managed-commands', 'managed-commands-error')", () => { const saved = database.batches.flat().find((item) => item.sql.startsWith("INSERT INTO integration_state") && item.sql.includes("'managed-commands'")); return saved ? [{ stateKey: "managed-commands", externalId: saved.values[0], contentHash: saved.values[1], updatedAt: saved.values[2] }] : []; });
    // A maintenance pass already holding the attempt claim makes the conditional upsert change no rows.
    if (claimHeld) database.runChangeHandler = (sql) => sql.includes("'managed-commands-attempt'") ? 0 : 1;
    return { database, env: { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env };
  };
  const originalFetch = globalThis.fetch; const outbound: string[] = []; const guildCommands: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); outbound.push(url);
    if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: applicationId });
    if (url.endsWith(`/guilds/${guildId}`)) return Response.json({ id: guildId });
    if (url.endsWith(`/channels/${channelId}`)) return Response.json({ guild_id: guildId, type: 0 });
    if (url.endsWith("/commands")) { if (init?.method === "GET") return Response.json(guildCommands); const command = { ...(JSON.parse(String(init?.body)) as Record<string, unknown>), application_id: applicationId, guild_id: guildId }; guildCommands.push(command); return Response.json(command); }
    throw new Error(`Unexpected Discord request: ${url}`);
  };
  const check = async (env: Env, role: "admin" | "operator" = "admin") => worker.fetch(request("/admin/integrations/discord/commands/check", {}, { method: "POST", cookie: await sessionCookie(role) }), env);
  try {
    const pending = await setup();
    assert.equal((await check(pending.env, "operator")).status, 403);
    assert.equal(outbound.length, 0);
    const first = await check(pending.env);
    assert.equal(first.status, 200);
    const body = await first.json() as { commandStatus: string; commandsUpdatedAt?: string };
    assert.equal(body.commandStatus, "ready"); assert.ok(body.commandsUpdatedAt);
    assert.equal(outbound.filter((url) => url.endsWith("/commands")).length, 7);
    assert.equal(pending.database.calls.filter((call) => call.sql.includes("discord.commands_auto_reconciled")).length, 1);
    // Ready commands are not reconciled again when the page is opened later.
    assert.deepEqual(await (await check(pending.env)).json(), body);
    assert.equal(outbound.filter((url) => url.endsWith("/commands")).length, 7);

    const overlapping = await setup(true); outbound.length = 0;
    assert.deepEqual(await (await check(overlapping.env)).json(), { commandStatus: "pending" });
    assert.equal(outbound.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("installation restore validates ownership before writes and replaces transient authority", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedInstallationBackupFoundation(database);
  database.lists.set("FROM pairing_codes WHERE", [{ id: "pairing-1", installation_id: "primary", code_hash: "old-code-hash", expires_at: "2026-10-01T00:00:00Z", redeemed_at: "2026-09-01T00:00:00Z", created_by: "admin-1", created_at: "2026-09-01T00:00:00Z", purpose: "hardware", kiosk_kind: "pi", kiosk_name: null }]);
  database.lists.set("FROM kiosks WHERE", [{ id: "kiosk-1", installation_id: "primary", pairing_code_id: "pairing-1", name: "Front desk", token_hash: "old-token-hash", active: 1, last_seen_at: "2026-09-27T12:00:00Z", created_at: "2026-09-01T00:00:00Z", reader_online: 1, release_version: "1.2.4", pending_events: 2, last_sync_at: "2026-09-27T12:00:00Z", error_category: null, pairing_bound: 1, authentication_method: "fingerprint", configured_authentication_method: "qr", kind: "pi", member_lookup: "entry", require_pin: 0 }]);
  database.lists.set("FROM integration_deliveries WHERE", [{ id: "delivery-1", installation_id: "primary", provider: "resend", delivery_key: "report:one", status: "pending", external_id: null, created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T00:00:00Z" }]);
  database.lists.set("FROM google_calendar_operations WHERE", [{ installation_id: "primary", meeting_id: "meeting-1", event_id: "event-1", action: "upsert", starts_at: "2026-10-01T20:00:00Z", ends_at: "2026-10-01T21:00:00Z", status: "pending", attempts: 0, next_attempt_at: "2026-09-28T00:00:00Z", last_error: null, updated_at: "2026-09-27T00:00:00Z" }]);
  database.lists.set("FROM discord_calendar_operations WHERE", [{ installation_id: "primary", meeting_id: "meeting-1", generation: 1, action: "upsert", event_id: null, status: "processing", attempts: 1, revision: 1, next_attempt_at: "2026-09-28T00:00:00Z", lease_token: "old-lease", lease_expires_at: "2026-09-28T00:05:00Z", last_error: null, actor_user_id: "admin-1", updated_at: "2026-09-27T00:00:00Z" }]);
  database.lists.set("FROM hours_publication_operations WHERE", [
    { installation_id: "primary", activity_id: "activity-1", publication_revision: 1, provider: "discord", status: "pending", attempts: 0, next_attempt_at: "2026-09-28T00:00:00Z", external_id: null, last_error: null, lease_token: null, lease_expires_at: null, created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T00:00:00Z", action: "publish", event_snapshot_json: null },
    { installation_id: "primary", activity_id: "activity-complete", publication_revision: 1, provider: "discord", status: "succeeded", attempts: 1, next_attempt_at: null, external_id: "message-1", last_error: null, lease_token: null, lease_expires_at: null, created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:01:00Z", action: "publish", event_snapshot_json: null },
  ]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const backup = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Record<string, any>;
  const attendanceOwnership = backup.ownership.modules.find((module: Record<string, unknown>) => module.id === "attendance");
  assert.ok(attendanceOwnership.sharedFields.some((field: { table: string }) => field.table === "members")); assert.ok(attendanceOwnership.transientAuthority.some((field: { table: string }) => field.table === "kiosks"));

  const wrongOwnership = structuredClone(backup); wrongOwnership.ownership.modules[0].tables = [];
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: wrongOwnership }, { cookie }), env)).status, 400);
  const oldModular = structuredClone(backup); oldModular.schemaVersion = 27; omitContestResubmissionFields(oldModular); oldModular.tables.platform_module_configuration = [];
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: oldModular }, { cookie }), env)).status, 400);
  const invalidLifecycle = structuredClone(backup); invalidLifecycle.tables.platform_modules.find((row: Record<string, unknown>) => row.module_id === "hour-tracking").delete_after = "2026-10-01T00:00:00Z";
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: invalidLifecycle }, { cookie }), env)).status, 400);
  const exhaustedAuthority = structuredClone(backup); exhaustedAuthority.tables.platform_module_administration[0].revision = Number.MAX_SAFE_INTEGER - 1; exhaustedAuthority.tables.platform_module_administration_epochs[0].revision = Number.MAX_SAFE_INTEGER - 1;
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: exhaustedAuthority }, { cookie }), env)).status, 400);
  assert.equal(database.batches.length, 0, "invalid archives must fail before destructive statements");

  const restored = await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  assert.equal(restored.status, 200, await restored.clone().text());
  const body = await restored.json() as { recovery: { revokedKiosks: number; invalidatedPairingCodes: number; pausedProviderOperations: number } };
  assert.deepEqual(body.recovery, { revokedKiosks: 1, invalidatedPairingCodes: 1, pausedProviderOperations: 4 });
  const batch = database.batches.at(-1) ?? [];
  const kiosk = batch.find((item) => item.sql.startsWith("INSERT INTO kiosks")); assert.equal(kiosk?.values[5], 0); assert.notEqual(kiosk?.values[4], "old-token-hash");
  const pairing = batch.find((item) => item.sql.startsWith("INSERT INTO pairing_codes")); assert.notEqual(pairing?.values[2], "old-code-hash");
  const google = batch.find((item) => item.sql.startsWith("INSERT INTO google_calendar_operations")); assert.equal(google?.values[6], "failed"); assert.equal(google?.values[8], null);
  const discord = batch.find((item) => item.sql.startsWith("INSERT INTO discord_calendar_operations")); assert.equal(discord?.values[5], "failed"); assert.equal(discord?.values[9], null); assert.equal(discord?.values[10], null);
  const publication = batch.find((item) => item.sql.startsWith("INSERT INTO hours_publication_operations")); assert.equal(publication?.values[4], "failed"); assert.equal(publication?.values[9], null);
  const completedPublication = batch.find((item) => item.sql.startsWith("INSERT INTO hours_publication_operations") && item.values[1] === "activity-complete"); assert.equal(completedPublication?.values[4], "succeeded"); assert.equal(completedPublication?.values[7], "message-1");
  assert.ok(batch.some((item) => item.sql.includes("ON CONFLICT(installation_id,module_id) DO UPDATE SET generation")));
  assert.ok(batch.some((item) => item.sql.includes("SELECT 'primary',?,?,generation") && item.sql.includes("FROM platform_module_epochs")));
});

test("Community 1.2.5 backups and previous Modular archives preserve explicit format boundaries", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedInstallationBackupFoundation(database);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const current = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Record<string, any>;
  const restore = (backup: unknown) => worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  const previous = structuredClone(current); previous.schemaVersion = 31; omitContestResubmissionFields(previous); for (const row of previous.tables.kiosks) delete row.configured_authentication_method;
  delete previous.tables.hours_public_form_settings;
  previous.ownership.modules.find((module: Record<string, unknown>) => module.id === "hour-tracking").tables = previous.ownership.modules.find((module: Record<string, unknown>) => module.id === "hour-tracking").tables.filter((table: string) => table !== "hours_public_form_settings");
  for (const row of previous.tables.hours_correction_requests) delete row.activity_id;
  for (const name of ["discord_attendance_notifications", "discord_attendance_recipients"]) for (const row of previous.tables[name]) delete row.delivery_id;
  const wrongOwner = structuredClone(previous); wrongOwner.ownership.modules[0].tables = [];
  assert.equal((await restore(wrongOwner)).status, 400);
  const extraColumn = structuredClone(previous); extraColumn.tables.installations[0].unexpected = "no";
  assert.equal((await restore(extraColumn)).status, 400);
  assert.equal(database.batches.length, 0);
  assert.equal((await restore(previous)).status, 200);
  const community = structuredClone(current); community.schemaVersion = 22; omitContestResubmissionFields(community);
  delete community.format; delete community.formatVersion; delete community.ownership;
  for (const name of Object.keys(community.tables)) if (/^(platform_module|hours_)/.test(name) || name === "user_preferences") delete community.tables[name];
  for (const row of community.tables.organization_settings) delete row.kiosk_authentication_method;
  for (const row of community.tables.kiosks) { delete row.pairing_bound; delete row.authentication_method; delete row.configured_authentication_method; }
  const malformed = structuredClone(community); malformed.tables.platform_modules = [];
  const before = database.batches.length;
  assert.equal((await restore(malformed)).status, 400);
  assert.equal(database.batches.length, before);
  const result = await restore(community);
  assert.equal(result.status, 200, await result.clone().text());
  const batch = database.batches.at(-1)!;
  assert.ok(batch.some(item => item.sql.includes("platform_modules") && item.values.includes("attendance")), "Community restore initializes Attendance authority");
});
