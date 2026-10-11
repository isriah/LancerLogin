import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readUpdateChannel, changeUpdateChannel } from "../apps/api/src/update-channel.ts";
import { prepareWebUpdate, recordUpdateBackup, startWebUpdate, latestUpdate, type WebUpdateEnv } from "../apps/api/src/web-updates.ts";
import { resolveOfficialRelease, createReleaseDiscovery } from "../apps/api/src/release-discovery.ts";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { createHash } from "node:crypto";
class Database {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    for (const name of readdirSync("apps/api/migrations").sort()) this.sqlite.exec(readFileSync(join("apps/api/migrations", name), "utf8"));
    this.sqlite.exec("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'); INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-01-01'),('operator','primary','operator','operator','2026-01-01'); INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');");
  }
  prepare(sql: string) { let values: unknown[] = []; const database = this.sqlite; return {
    bind(...params: unknown[]) { values = params; return this; },
    async first<T = unknown>() { return (database.prepare(sql).get(...values as []) ?? null) as T | null; },
    async all<T = unknown>() { return { results: database.prepare(sql).all(...values as []) as T[] }; },
    async run() { const result = database.prepare(sql).run(...values as []); return { meta: { changes: Number(result.changes) } }; },
  }; }
  async batch(statements: Array<{ run(): Promise<unknown> }>) { this.sqlite.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec("COMMIT"); return results; } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; } }
}
const sha = "b".repeat(40); const tag = "v2.0.0-beta.1";
const release = (name = tag) => ({ tag_name: name, draft: false, prerelease: name.includes("-beta."), immutable: true, assets: ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => { const archive = `lancerlogin-kiosk-${name.slice(1)}-linux-${arch}.tar.gz`; return [archive, `${archive}.sha256`]; })].map((name) => ({ name })) });
function env(): WebUpdateEnv { return { DB: new Database(), ALLOWED_ORIGIN: "https://sample-dashboard.pages.dev", RELEASE_VERSION: "1.2.6", UPDATE_REPOSITORY: "sample/private-install", WEB_UPDATE_TOKEN: "synthetic-token", WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(Date.now() + 3 * 86_400_000).toISOString() }; }
test("track defaults stable, requires explicit confirmation and audits only successful CAS changes", async () => {
  const environment = env(); assert.deepEqual(await readUpdateChannel(environment), { channel: "stable", revision: 0 });
  await assert.rejects(changeUpdateChannel(environment, { channel: "beta", revision: 0 }, "admin"), /Confirm/);
  await assert.rejects(changeUpdateChannel(environment, { channel: "beta", revision: 0, betaConfirmed: true, url: "https://evil.test" }, "admin"), /Choose/);
  assert.deepEqual(await changeUpdateChannel(environment, { channel: "beta", revision: 0, betaConfirmed: true }, "admin"), { channel: "beta", revision: 1 });
  await assert.rejects(changeUpdateChannel(environment, { channel: "stable", revision: 0 }, "admin"), /another session/);
  assert.equal((await environment.DB!.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'update_channel.changed'").first<{ n: number }>())?.n, 1);
  assert.deepEqual(await changeUpdateChannel(environment, { channel: "stable", revision: 1 }, "admin"), { channel: "stable", revision: 2 });
});
test("Admin role and exact origin are required and no browser-selected release is accepted", async () => {
  const environment = { ...env(), APP_MODE: "configured", SESSION_KEY: "A".repeat(43) } as unknown as Env;
  for (const [user, role, origin, status] of [["operator", "operator", environment.ALLOWED_ORIGIN, 403], ["admin", "admin", "https://evil.test", 403], ["admin", "admin", environment.ALLOWED_ORIGIN, 200]] as const) {
    const token = await createSessionCodec(environment.SESSION_KEY!).issue({ userId: user, role }, Date.now() + 60_000);
    const result = await worker.fetch(new Request("https://worker.example/admin/update-channel", { method: "PUT", headers: { origin, cookie: `lancerlogin_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ channel: "beta", revision: 0, betaConfirmed: true }) }), environment);
    assert.equal(result.status, status);
  }
});
test("beta discovery orders complete releases, separates caches, and refuses a truncated feed", async () => {
  const feeds = [release("v2.0.0-beta.9"), release("v2.0.0-beta.10"), release("v1.2.6")];
  assert.equal((await resolveOfficialRelease("beta", async () => Response.json(feeds)))?.tag, "v2.0.0-beta.10");
  assert.equal((await resolveOfficialRelease("beta", async () => Response.json([...feeds, release("v2.0.0")])))?.tag, "v2.0.0");
  let count = 0; assert.equal(await resolveOfficialRelease("beta", async () => { count++; return Response.json(Array(100).fill(release("v1.2.6"))); }), undefined); assert.equal(count, 5);
  const stable = createReleaseDiscovery({ fetcher: async () => Response.json(release("v1.2.6")) });
  const beta = createReleaseDiscovery({ channel: "beta", fetcher: async () => Response.json(feeds) });
  assert.equal((await stable.check()).release?.tag_name, "v1.2.6"); assert.equal((await beta.check()).release?.tag_name, "v2.0.0-beta.10");
});
test("channel changes expire prepared consent, started updates lock track, and opt-out never downgrades", async () => {
  const environment = env(); const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes("/releases?")) return Response.json([release()]);
    if (path.includes("/releases/latest")) return Response.json(release("v1.2.6"));
    if (path.includes("/commits/")) return Response.json({ sha });
    if (path.includes("/dispatches")) return Response.json({ workflow_run_id: 123 });
    if (path.includes("/workflows/")) return Response.json({ state: "active", path: ".github/workflows/upgrade-web.yml", name: "Upgrade LancerLogin web (update channels v2)" });
    return Response.json({ private: true });
  };
  try {
    await changeUpdateChannel(environment, { channel: "beta", revision: 0, betaConfirmed: true }, "admin");
    let result = await prepareWebUpdate(environment, "admin"); assert.equal(result.request?.targetTag, tag); assert.equal(result.request?.channel, "beta");
    const previousId = result.request!.requestId;
    await changeUpdateChannel(environment, { channel: "stable", revision: 1 }, "admin");
    assert.equal((await latestUpdate(environment))?.state, "expired");
    assert.equal((await startWebUpdate(environment, { requestId: previousId, backupSaved: true }, "admin")).request?.state, "expired");
    await assert.rejects(prepareWebUpdate({ ...environment, RELEASE_VERSION: "2.0.0-beta.1" }, "admin"), /never downgrades/);
    await changeUpdateChannel(environment, { channel: "beta", revision: 2, betaConfirmed: true }, "admin");
    result = await prepareWebUpdate(environment, "admin"); await recordUpdateBackup(environment, result.request!.requestId);
    await startWebUpdate(environment, { requestId: result.request!.requestId, backupSaved: true }, "admin");
    await assert.rejects(changeUpdateChannel(environment, { channel: "stable", revision: 3 }, "admin"), /Finish the active update/);
  } finally { globalThis.fetch = originalFetch; }
});

test("beta requires the reviewed controller and a track change during lookup cannot prepare", async () => {
  const environment = env(); const originalFetch = globalThis.fetch; let capable = false; let switchDuringPin = false;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes("/releases?")) return Response.json([release()]);
    if (path.includes("/commits/")) { if (switchDuringPin) await changeUpdateChannel(environment, { channel: "stable", revision: 1 }, "admin"); return Response.json({ sha }); }
    if (path.includes("/workflows/")) return Response.json({ state: "active", path: ".github/workflows/upgrade-web.yml", name: capable ? "Upgrade LancerLogin web (update channels v2)" : "Upgrade LancerLogin web" });
    return Response.json({ private: true });
  };
  try {
    await changeUpdateChannel(environment, { channel: "beta", revision: 0, betaConfirmed: true }, "admin");
    await assert.rejects(prepareWebUpdate(environment, "admin"), /maintainer must install/);
    assert.equal(await latestUpdate(environment), null);
    capable = true; switchDuringPin = true;
    await assert.rejects(prepareWebUpdate(environment, "admin"), /track changed during/);
    assert.equal(await latestUpdate(environment), null);
  } finally { globalThis.fetch = originalFetch; }
});

test("kiosk commands pin official targets, require the installed helper and lock duplicate dispatch", async () => {
  const database = new Database(); const now = new Date().toISOString();
  database.sqlite.prepare("INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at) VALUES('pair','primary','synthetic-code',?,'admin',?)").run(now, now);
  database.sqlite.prepare("INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,created_at,release_version) VALUES('kiosk-1','primary','pair','Synthetic kiosk',?,?, '1.2.6')").run(createHash("sha256").update("synthetic-kiosk-token").digest("base64url"), now);
  const environment = { ...env(), DB: database, APP_MODE: "configured", SESSION_KEY: "A".repeat(43) } as unknown as Env;
  const token = await createSessionCodec(environment.SESSION_KEY!).issue({ userId: "admin", role: "admin" }, Date.now() + 60_000);
  const command = (body: unknown, origin = environment.ALLOWED_ORIGIN) => worker.fetch(new Request("https://worker.example/admin/kiosks/kiosk-1/commands", { method: "POST", headers: { origin, cookie: `lancerlogin_session=${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), environment);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { assert.equal(init?.redirect, "manual"); return Response.json(String(url).includes("/commits/") ? { sha } : [release()]); };
  try {
    await changeUpdateChannel(environment, { channel: "beta", revision: 0, betaConfirmed: true }, "admin");
    assert.equal((await command({ command: "install_latest" }, "https://evil.test")).status, 403);
    assert.equal((await command({ command: "install_latest", targetTag: "v99.0.0", url: "https://evil.test" })).status, 400);
    assert.equal((await command({ command: "install_latest" })).status, 409);
    database.sqlite.exec("UPDATE kiosks SET update_policy_version = 2");
    assert.equal((await command({ command: "install_latest" })).status, 202);
    const pinned = database.sqlite.prepare("SELECT requested_release_version, requested_release_sha, update_channel FROM kiosk_commands").get();
    assert.deepEqual({ ...pinned }, { requested_release_version: tag, requested_release_sha: sha, update_channel: "beta" });
    assert.equal((await command({ command: "install_latest" })).status, 409);
    await assert.rejects(changeUpdateChannel(environment, { channel: "stable", revision: 1 }, "admin"), /Finish the active update/);
    const pending = await worker.fetch(new Request("https://worker.example/kiosk/commands", { headers: { authorization: "Bearer synthetic-kiosk-token" } }), environment);
    assert.equal(pending.status, 200);
    const proof = (await pending.json() as { command: { targetTag: string; targetCommit: string; channel: string } }).command;
    assert.deepEqual({ targetTag: proof.targetTag, targetCommit: proof.targetCommit, channel: proof.channel }, { targetTag: tag, targetCommit: sha, channel: "beta" });
    database.sqlite.exec("UPDATE kiosk_commands SET completed_at = created_at, success = 0");
    await changeUpdateChannel(environment, { channel: "stable", revision: 1 }, "admin");
  } finally { globalThis.fetch = originalFetch; }
});
