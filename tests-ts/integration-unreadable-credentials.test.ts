// quick-check: covers apps/api/migrations/**
// Saved integration credentials that can no longer be read: the integration key was replaced, the stored value was
// damaged or cut short, or the key itself is unusable. Through the real Worker and real SQLite, Settings > Integrations
// must still load and say so, every route that needs the credentials must answer in plain words instead of failing with
// a 500, and saving the credentials again must recover. Nothing here may log or return credential material.
// Every person, address and credential is synthetic.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import type { D1Database } from "../apps/api/src/d1-usage.ts";
import { TestD1Database } from "./fixtures/d1-database.ts";

class Database extends TestD1Database {
  constructor() {
    super({ seed: `INSERT INTO installations(id,created_at,auth_mode,google_calendar_enabled) VALUES('primary','2026-10-18','both',1);
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO users(id,installation_id,email,local_username,role,created_at) VALUES('admin','primary','test.admin.a@example.test','admin','admin','2026-10-18');
      INSERT INTO platform_module_administration VALUES('primary',0,1); INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES('primary','attendance',1,1,'enabled',2,1,0);` });
  }
  value<T>(sql: string, ...values: unknown[]) { return this.sqlite.prepare(sql).get(...values as []) as T | undefined; }
}

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const otherKey = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const origin = "https://dashboard.example.test";
const environment = (db: D1Database, integrationKey: string | undefined = key) => ({ APP_MODE: "configured", ALLOWED_ORIGIN: origin, SESSION_KEY: key, INTEGRATION_KEY: integrationKey, DB: db }) as Env;
const admin = async () => `lancerlogin_session=${await createSessionCodec(key).issue({ userId: "admin", role: "admin" })}`;
async function call(env: Env, path: string, options: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin, cookie: await admin() };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return worker.fetch(new Request(`https://api.example.test${path}`, { method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }), env);
}
const discordSecret = { applicationId: "3".repeat(18), botToken: "synthetic-bot-token-do-not-leak", publicKey: "0".repeat(64), guildId: "1".repeat(18), channelId: "2".repeat(18) };
const secrets = { discord: discordSecret, google: { clientId: "synthetic-client-id", clientSecret: "synthetic-client-secret-do-not-leak" }, resend: { apiKey: "synthetic-resend-key-do-not-leak", fromEmail: "attendance@example.test" } } as const;
const calendarSecret = { clientId: "synthetic-calendar-client", clientSecret: "synthetic-calendar-secret-do-not-leak", refreshToken: "synthetic-refresh-do-not-leak", calendarId: "test-calendar@example.test", calendarLabel: "Test Calendar A" };
const leaks = ["do-not-leak", "synthetic-client-id", "synthetic-calendar-client"];
async function save(db: Database, provider: keyof typeof secrets, withKey = key) {
  const encrypted = await encryptIntegration(secrets[provider], withKey);
  db.sqlite.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES(?, 'primary', ?, ?, ?, '2026-10-18', '2026-10-18')").run(`${provider}-1`, provider, encrypted.ciphertext, encrypted.iv);
  db.sqlite.exec(`UPDATE installations SET ${provider}_enabled = 1 WHERE id = 'primary'`);
}
async function saveCalendar(db: Database, withKey = key) {
  const encrypted = await encryptIntegration(calendarSecret, withKey);
  db.sqlite.prepare("INSERT INTO google_calendar_authorizations(installation_id,ciphertext,iv,authorized_at,verified_at,updated_at) VALUES('primary',?,?,'2026-10-18','2026-10-18','2026-10-18')").run(encrypted.ciphertext, encrypted.iv);
}
/** GET /admin/integrations, which must always load, and must never carry credential material or stored ciphertext. */
async function status(env: Env, db: Database) {
  const result = await call(env, "/admin/integrations"); const text = await result.text();
  assert.equal(result.status, 200, text);
  for (const leak of leaks) assert.equal(text.includes(leak), false, `status leaks ${leak}`);
  for (const row of db.sqlite.prepare("SELECT ciphertext, iv FROM encrypted_integrations UNION ALL SELECT ciphertext, iv FROM google_calendar_authorizations").all() as { ciphertext: string; iv: string }[]) for (const stored of [row.ciphertext, row.iv]) assert.equal(stored.length > 8 && text.includes(stored), false, "status returns stored ciphertext");
  return Object.fromEntries((JSON.parse(text) as { integrations: Array<Record<string, unknown>> }).integrations.map((item) => [item.provider as string, item]));
}
/** Fails the test on any console.error or console.log that mentions credential material; returns what was logged. */
function watchLogs(context: TestContext) {
  const logged: string[] = [];
  for (const method of ["error", "log", "warn"] as const) context.mock.method(console, method, (...values: unknown[]) => { logged.push(values.map(String).join(" ")); });
  return { logged, clean: () => { for (const line of logged) for (const leak of leaks) assert.equal(line.includes(leak), false, `a log line leaks ${leak}`); } };
}
const unreadableMessage = (title: string) => `The saved ${title} credentials can't be read. Enter them again under Settings > Integrations.`;
async function refusal(result: Response) { return { status: result.status, ...(await result.json() as { error?: string; code?: string; errorId?: string }) }; }

/** Ways the stored Discord credentials stop being readable. Each returns the environment to use afterwards. */
const damage: Record<string, (db: Database) => Promise<Env> | Env> = {
  "a wrong key (the integration key was replaced)": (db) => environment(db, otherKey),
  "a corrupt stored value": (db) => { const stored = db.value<{ ciphertext: string }>("SELECT ciphertext FROM encrypted_integrations WHERE provider = 'discord'")!.ciphertext; db.sqlite.prepare("UPDATE encrypted_integrations SET ciphertext = ? WHERE provider = 'discord'").run(`${stored.slice(0, 10)}${stored[10] === "A" ? "B" : "A"}${stored.slice(11)}`); return environment(db); },
  "a truncated stored value": (db) => { db.sqlite.exec("UPDATE encrypted_integrations SET ciphertext = substr(ciphertext, 1, 12) WHERE provider = 'discord'"); return environment(db); },
  "a stored value that is not base64": (db) => { db.sqlite.exec("UPDATE encrypted_integrations SET ciphertext = '!!not base64!!' WHERE provider = 'discord'"); return environment(db); },
  "an empty stored value": (db) => { db.sqlite.exec("UPDATE encrypted_integrations SET ciphertext = '' WHERE provider = 'discord'"); return environment(db); },
  "a damaged nonce": (db) => { db.sqlite.exec("UPDATE encrypted_integrations SET iv = 'AAAA' WHERE provider = 'discord'"); return environment(db); },
  "a value that decrypts to something that is not credentials": async (db) => { const { webcrypto } = await import("node:crypto"); const raw = Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/") + "="), (c) => c.charCodeAt(0)); const k = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]); const iv = webcrypto.getRandomValues(new Uint8Array(12)); const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); db.sqlite.prepare("UPDATE encrypted_integrations SET ciphertext = ?, iv = ? WHERE provider = 'discord'").run(b64(new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode("not json")))), b64(iv)); return environment(db); },
};

for (const [name, apply] of Object.entries(damage)) {
  test(`Integrations loads and the Discord card says the credentials can't be read: ${name}`, async (context) => {
    const db = new Database(); context.after(() => db.close()); await save(db, "discord");
    const healthy = await status(environment(db), db);
    assert.deepEqual([healthy.discord!.configured, healthy.discord!.state, "unreadable" in healthy.discord!], [true, "configured", false]);
    const env = await apply(db); const logs = watchLogs(context);
    const card = (await status(env, db)).discord!;
    assert.deepEqual({ saved: card.saved, enabled: card.enabled, configured: card.configured, state: card.state, unreadable: card.unreadable, commandStatus: card.commandStatus }, { saved: true, enabled: true, configured: false, state: "unreadable", unreadable: true, commandStatus: "unavailable" });
    // Every route that needs the credentials refuses in plain words, with a stable code, and logs nothing as unexpected.
    for (const [path, options] of [["/admin/integrations/discord/verify/start", { method: "POST" }], ["/admin/integrations/discord/commands/reconcile", { method: "POST" }], ["/admin/integrations/discord/roles", {}], ["/discord/interactions", { body: { type: 1 } }]] as const) {
      const refused = await refusal(await call(env, path, options));
      assert.deepEqual(refused, { status: 503, error: unreadableMessage("Discord"), code: "integration_unreadable" }, path);
    }
    assert.deepEqual(await (await call(env, "/admin/integrations/discord/commands/check", { method: "POST" })).json(), { commandStatus: "unavailable" });
    assert.deepEqual(logs.logged.filter((line) => line.includes("api_error")), [], "an unreadable credential is not an unexpected error");
    // An Admin recovers from the dashboard: saving the credentials again replaces the unreadable value.
    const saved = await call(env, "/admin/integrations/discord", { method: "PUT", body: discordSecret });
    assert.equal(saved.status, 200, await saved.clone().text());
    const after = (await status(env, db)).discord!;
    assert.deepEqual([after.saved, after.state, "unreadable" in after], [true, "verification_required", false]);
    logs.clean();
  });
}

test("credentials saved under another key read as unreadable on every card, and each provider's routes refuse in plain words", async (context) => {
  const db = new Database(); context.after(() => db.close());
  for (const provider of ["google", "resend", "discord"] as const) await save(db, provider, otherKey);
  await saveCalendar(db, otherKey);
  const env = environment(db); const logs = watchLogs(context);
  const originalFetch = globalThis.fetch; context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => { throw new Error(`Unexpected request: ${String(input instanceof Request ? input.url : input)}`); };
  const cards = await status(env, db);
  for (const provider of ["google", "resend", "discord", "google_calendar"]) assert.deepEqual({ saved: cards[provider]!.saved, configured: cards[provider]!.configured, state: cards[provider]!.state, unreadable: cards[provider]!.unreadable }, { saved: true, configured: false, state: "unreadable", unreadable: true }, provider);
  const expected = (title: string) => ({ status: 503, error: unreadableMessage(title), code: "integration_unreadable" });
  assert.deepEqual(await refusal(await call(env, "/auth/google/start")), expected("Google OAuth"));
  assert.deepEqual(await refusal(await call(env, "/admin/integrations/resend/verify/start", { body: { email: "test.admin.a@example.test" } })), expected("Resend"));
  for (const [path, options] of [["/admin/integrations/google-calendar/calendars", {}], ["/admin/integrations/google-calendar/authorize", {}], ["/admin/integrations/google-calendar/retry", { method: "POST" }], ["/admin/integrations/google-calendar/sync-all", { method: "POST" }]] as const) assert.deepEqual(await refusal(await call(env, path, options)), expected("Google Calendar"), path);
  assert.deepEqual(logs.logged.filter((line) => line.includes("api_error")), []);
  // Saving each again recovers it.
  assert.equal((await call(env, "/admin/integrations/google", { method: "PUT", body: secrets.google })).status, 200);
  assert.equal((await call(env, "/admin/integrations/resend", { method: "PUT", body: secrets.resend })).status, 200);
  assert.equal((await call(env, "/admin/integrations/google-calendar", { method: "PUT", body: { clientId: calendarSecret.clientId, clientSecret: calendarSecret.clientSecret } })).status, 200);
  const recovered = await status(env, db);
  for (const provider of ["google", "resend", "google_calendar"]) assert.deepEqual([recovered[provider]!.state, "unreadable" in recovered[provider]!], ["verification_required", false], provider);
  assert.equal(recovered.discord!.state, "unreadable", "the card that was not saved again still says so");
  logs.clean();
});

test("an integration key of the wrong size is reported as a configuration problem, not as unreadable credentials or a 500", async (context) => {
  const db = new Database(); context.after(() => db.close()); await save(db, "discord");
  const env = environment(db, "too-short"); const logs = watchLogs(context);
  const card = (await status(env, db)).discord!;
  assert.deepEqual([card.saved, "unreadable" in card, card.commandStatus], [true, false, "unavailable"], "re-entering credentials would not help, so the card does not ask for it");
  const message = "Integration encryption is not configured correctly: INTEGRATION_KEY must be 32 random bytes";
  assert.deepEqual(await refusal(await call(env, "/admin/integrations/discord/verify/start", { method: "POST" })), { status: 503, error: message });
  assert.deepEqual(await refusal(await call(env, "/admin/integrations/discord", { method: "PUT", body: discordSecret })), { status: 503, error: message });
  assert.deepEqual(logs.logged.filter((line) => line.includes("api_error")), []); logs.clean();
});

test("a scheduled pass with unreadable Discord credentials throws nothing, sends nothing and logs no credential", async (context) => {
  const db = new Database(); context.after(() => db.close()); await save(db, "discord", otherKey);
  const env = environment(db); const logs = watchLogs(context);
  const originalFetch = globalThis.fetch; context.after(() => { globalThis.fetch = originalFetch; });
  const requests: string[] = []; globalThis.fetch = async (input) => { requests.push(String(input instanceof Request ? input.url : input)); return Response.json({}); };
  await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: 0 } as never, env as never);
  assert.deepEqual(requests.filter((url) => url.includes("discord.com")), [], "nothing is sent to Discord without readable credentials");
  assert.equal((await status(env, db)).discord!.state, "unreadable");
  logs.clean();
});
