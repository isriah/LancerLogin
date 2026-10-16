import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateFingerprintIdentity, fingerprintPublicIdentity, fingerprintIdentityId } from "../apps/kiosk/src/fingerprint-envelope.mjs";

test("real D1 idle cost stays within a bounded two-kiosk daily budget with a full reader catalog", async () => {
  const bundled = await build({ stdin: { contents: `import worker from './apps/api/src/index.ts'; import {preserveDatabaseIdentity} from './apps/api/src/d1-usage.ts';
    export default { async fetch(request, env) {
      let reads=0,writes=0;const statements=new WeakMap();
      const record=r=>{reads+=r.meta?.rows_read??0;writes+=r.meta?.rows_written??0;return r;};
      const wrap=s=>{const w={bind:(...v)=>wrap(s.bind(...v)),first:async()=>record(await s.all()).results?.[0]??null,all:async()=>record(await s.all()),run:async()=>record(await s.run())};statements.set(w,s);return w;};
      const db={prepare:q=>wrap(env.DB.prepare(q)),batch:async ss=>(await env.DB.batch(ss.map(s=>statements.get(s)))).map(record)};
      preserveDatabaseIdentity(db,env.DB);
      const result=await worker.fetch(request,{...env,DB:db});const response=new Response(result.body,result);
      response.headers.set('x-test-reads',String(reads));response.headers.set('x-test-writes',String(writes));return response;
    }};`, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser" });
  const secret = "A".repeat(43);
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-08-01", d1Databases: ["DB"], bindings: { APP_MODE: "configured", ALLOWED_ORIGIN: "https://example.test", SESSION_KEY: secret, UPDATE_REPOSITORY: "example/installation", FINGERPRINT_VAULT_KEY: Buffer.alloc(32, 7).toString("base64url") } }));
  try {
    const db = await runtime.getD1Database("DB");
    for (const name of (await readdir("apps/api/migrations")).filter(n => n.endsWith(".sql")).sort()) await db.exec((await readFile(`apps/api/migrations/${name}`, "utf8")).replace(/^\s*--.*$/gm, "").replace(/\r?\n/g, " "));
    await db.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO platform_module_administration VALUES('primary',0,1);
      INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES('primary','attendance',1,1,'enabled',2,1);
      WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<128) INSERT INTO members(id,installation_id,external_id,first_name,last_name,active,created_at) SELECT 'member-'||x,'primary','synthetic-'||x,'Synthetic','Member',CASE WHEN x<=106 THEN 1 ELSE 0 END,'2026-01-01' FROM n;`.replace(/\n/g, " "));
    for (const device of ["one", "two"]) {
      await db.prepare("INSERT INTO pairing_codes(id,installation_id,code_hash,purpose,expires_at,created_by,created_at) VALUES(?,'primary',?,'hardware','2099-01-01','admin','2026-01-01')").bind(device, device).run();
      await db.prepare("INSERT INTO kiosks(id,installation_id,name,token_hash,pairing_code_id,pairing_bound,created_at) VALUES(?,'primary',?,?,?,1,'2026-01-01')").bind(device, device, createHash("sha256").update(device).digest("base64url"), device).run();
    }
    const payload = Buffer.from(JSON.stringify({ userId: "admin", role: "admin", expiresAt: Date.now() + 60000 })).toString("base64url");
    const cookie = `lancerlogin_session=${payload}.${createHmac("sha256", Buffer.from(secret, "base64url")).update(payload).digest("base64url")}`;
    async function call(path, { device, method = "GET", body, etag } = {}) {
      const result = await runtime.dispatchFetch(`https://example.test${path}`, { method, headers: { ...(device ? { authorization: `Bearer ${device}` } : { cookie }), ...(body ? { "content-type": "application/json" } : {}), ...(etag ? { "if-none-match": etag } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.ok([200, 304].includes(result.status), `${path}: ${result.status} ${result.status >= 400 ? await result.text() : ""}`);
      return result;
    }
    await (await call("/admin/kiosks/fingerprint-sync", { method: "PATCH", body: { enabled: true } })).text();
    await (await call("/admin/kiosks/fingerprint-vault", { method: "PATCH", body: { enabled: true, confirmation: "ENABLE CLOUD FINGERPRINT STORAGE" } })).text();
    // Opaque synthetic ciphertext is never decrypted by this metadata-only benchmark.
    await db.prepare(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200)
      INSERT INTO kiosk_fingerprint_vault_templates(fingerprint_id,installation_id,vault_id,member_id,template_digest,ciphertext,nonce,format,source_kiosk_id,source_pairing_id,enrollment_id,created_at)
      SELECT printf('%064x',x),'primary',s.vault_id,'member-'||((x-1)%106+1),printf('%064x',x),?,?,'r503-model-1536','one','one','synthetic-enrollment-'||x,1 FROM n,kiosk_fingerprint_vault_settings s WHERE s.installation_id='primary'`).bind("A".repeat(2072), "B".repeat(16)).run();
    // Keep realistic completed update history so maintenance checks are not priced against an empty table.
    for (let i = 0; i < 20; i++) await db.prepare("INSERT INTO web_update_requests(id,installation_id,release_tag,release_sha,release_notes,previous_version,state,stage,maintenance,created_at,expires_at,updated_at) VALUES(?,'primary','v2.0.0-beta.3',?,'Synthetic update','2.0.0-beta.2','succeeded','done',0,'2026-01-01','2026-01-02','2026-01-01')").bind(`update-${i}`, "a".repeat(40)).run();
    let dailyReads = 0, dailyWrites = 0, legacyDailyReads = 0;
    const maintenanceSql = "SELECT id FROM web_update_requests WHERE installation_id = 'primary' AND maintenance = 1 LIMIT 1";
    assert.equal((await db.prepare(maintenanceSql).all()).meta.rows_read, 0);
    const costs = [];
    async function price(path, options, times) {
      const result = await call(path, options);
      const reads = Number(result.headers.get("x-test-reads")), writes = Number(result.headers.get("x-test-writes"));
      dailyReads += reads * times; dailyWrites += writes * times; costs.push({ path, reads, writes, dailyCalls: times });
      return result;
    }
    for (const device of ["one", "two"]) {
      const start = costs.length;
      const identity = fingerprintPublicIdentity(await generateFingerprintIdentity());
      await (await price("/kiosk/fingerprint-sync/identity", { device, method: "PUT", body: { publicIdentity: identity, fingerprint: fingerprintIdentityId(identity) } }, 1)).text();
      await (await price("/kiosk/fingerprint-sync/identity", { device, method: "PUT", body: { publicIdentity: identity, fingerprint: fingerprintIdentityId(identity) } }, 287)).text();
      const first = await price("/kiosk/roster", { device }, 1); const etag = first.headers.get("etag"); await first.text(); assert.ok(etag);
      await (await price("/kiosk/roster", { device, etag }, 5759)).text();
      await (await price("/kiosk/fingerprint-sync", { device }, 1)).text();
      for (const path of ["/kiosk/fingerprint-sync/deliveries", "/kiosk/fingerprint-vault", "/kiosk/fingerprint-vault/templates", "/kiosk/fingerprint-reset/commands"]) await (await price(path, { device }, 5760)).text();
      await (await price("/kiosk/commands", { device }, 17280)).text();
      await (await price("/kiosk/config", { device }, 1440)).text();
      await (await price("/kiosk/heartbeat", { device, method: "POST", body: { readerOnline: true, releaseVersion: "synthetic-budget", authenticationMethod: "fingerprint" } }, 1440)).text();
      // Old clients request two unconditional rosters and re-register every round.
      // Price warm server reuse plus a conservative cold reload per device every five minutes.
      const warmRoster = await call("/kiosk/roster", { device });
      const warmReads = Number(warmRoster.headers.get("x-test-reads")); await warmRoster.text();
      const deviceCosts = costs.slice(start);
      const lookup = path => deviceCosts.find(cost => cost.path === path).reads;
      const rosterCosts = deviceCosts.filter(cost => cost.path === "/kiosk/roster");
      const coldReads = Math.max(...costs.filter(cost => cost.path === "/kiosk/roster").map(cost => cost.reads));
      legacyDailyReads += deviceCosts.reduce((total, cost) => total + cost.reads * cost.dailyCalls, 0)
        - rosterCosts.reduce((total, cost) => total + cost.reads * cost.dailyCalls, 0)
        + warmReads * 11520 + (coldReads - warmReads) * 288
        + lookup("/kiosk/fingerprint-sync/identity") * (5760 - 288)
        + lookup("/kiosk/fingerprint-sync") * (5760 - 1);
    }
    assert.ok(dailyReads < 3500000, JSON.stringify({ dailyReads, costs }));
    assert.ok(dailyWrites < 50000, JSON.stringify({ dailyWrites, costs }));
    assert.ok(legacyDailyReads < 5000000, JSON.stringify({ legacyDailyReads, costs }));
    console.log(JSON.stringify({ benchmark: "two_kiosk_idle_day_projection", dailyReads, dailyWrites, includes: "all first/all/batch queries, current authority guards, command polling, heartbeat and completed update history", costs }));
    console.log(JSON.stringify({ benchmark: "older_client_rollout_projection", legacyDailyReads, cacheAssumption: "one cold reload per device every five minutes; extra isolates or revisions add reloads" }));
    // Price the identical two-device schedule after consolidating reads. Client
    // metadata pages are still replayed through local recovery on every round;
    // only unchanged catalog network reads disappear. Include every cold page,
    // including the empty final page, rather than pricing an immortal edge cache.
    let pollDailyReads = 0, pollDailyWrites = 0, coldCatalogReads = 0;
    const pollCosts = [];
    async function pollPrice(path, options, times) {
      const result = await call(path, options);
      const reads = Number(result.headers.get("x-test-reads")), writes = Number(result.headers.get("x-test-writes"));
      pollDailyReads += reads * times; pollDailyWrites += writes * times;
      pollCosts.push({ path, reads, writes, dailyCalls: times }); return result;
    }
    for (const device of ["one", "two"]) {
      const initial = await pollPrice("/kiosk/poll?v=1&fingerprints=1&config=1", { device }, 1);
      const snapshot = await initial.json(); assert.equal(snapshot.fingerprints.roster.members.length, 106);
      assert.equal(snapshot.fingerprints.vault.catalogRevision, 200);
      const revision = snapshot.fingerprints.roster.revision;
      await (await pollPrice(`/kiosk/poll?v=1&fingerprints=1&config=1&rosterRevision=${revision}`, { device }, 1439)).text();
      await (await pollPrice(`/kiosk/poll?v=1&fingerprints=1&rosterRevision=${revision}`, { device }, 4320)).text();
      await (await pollPrice("/kiosk/poll?v=1", { device }, 11520)).text();
      const existingRegistration = costs.filter(cost => cost.path === "/kiosk/fingerprint-sync/identity");
      for (const registration of existingRegistration.slice(0, 2)) {
        pollDailyReads += registration.reads * registration.dailyCalls; pollDailyWrites += registration.writes * registration.dailyCalls;
      }
      await (await pollPrice("/kiosk/heartbeat", { device, method: "POST", body: { readerOnline: true, releaseVersion: "synthetic-budget", authenticationMethod: "fingerprint" } }, 1440)).text();
      let after = "", pages = 0, entries = 0;
      while (true) {
        const page = await pollPrice(`/kiosk/fingerprint-vault/templates${after ? `?after=${after}` : ""}`, { device }, 1);
        coldCatalogReads += Number(page.headers.get("x-test-reads"));
        const manifest = await page.json(); entries += manifest.fingerprints.length; pages++;
        assert.ok(pages <= 26, "bounded catalog pagination");
        if (!manifest.fingerprints.length) break;
        after = manifest.fingerprints.at(-1).fingerprintId;
      }
      assert.equal(entries, 200); assert.equal(pages, 26);
    }
    assert.ok(pollDailyReads <= 1717494, JSON.stringify({ pollDailyReads, pollCosts }));
    assert.ok(pollDailyReads <= dailyReads / 2, "at least half the unchanged workload's reads");
    assert.ok(pollDailyWrites <= dailyWrites, "read polling adds no periodic writes");
    assert.ok(coldCatalogReads < 6000, "full two-reader cold recovery remains bounded");
    console.log(JSON.stringify({ benchmark: "combined_poll_two_kiosk_idle_day_projection", baselineReads: dailyReads, pollDailyReads, pollDailyWrites, coldCatalogReads,
      reductionPercent: (1 - pollDailyReads / dailyReads) * 100, cacheAssumption: "bounded client metadata pages, fresh authority every fifteen seconds, no server cache reuse; all fifty-two cold catalog pages counted", costs: pollCosts.filter(cost => !cost.path.startsWith("/kiosk/fingerprint-vault/templates")) }));
    await db.exec("UPDATE members SET first_name='Changed' WHERE id='member-1'; DELETE FROM kiosk_fingerprint_vault_templates WHERE fingerprint_id='0000000000000000000000000000000000000000000000000000000000000001'");
    const changed = await call("/kiosk/poll?v=1&fingerprints=1&rosterRevision=0", { device: "one" });
    const churnReads = Number(changed.headers.get("x-test-reads")); const changedSnapshot = await changed.json();
    assert.equal(changedSnapshot.fingerprints.vault.catalogRevision, 201);
    assert.equal(changedSnapshot.fingerprints.roster.members.find(member => member.rosterId === "member-1").firstName, "Changed");
    assert.ok(churnReads < 500, "one revision change has bounded full-roster reload cost");
    console.log(JSON.stringify({ benchmark: "combined_poll_cold_and_revision_churn", churnReads, twoReaderCatalogReloadReads: coldCatalogReads,
      additionalReadsForHourlyTwoKioskRestarts: 23 * (coldCatalogReads + 2 * churnReads) }));
    await db.prepare("UPDATE web_update_requests SET maintenance=1 WHERE id='update-0'").run();
    assert.equal((await db.prepare(maintenanceSql).all()).results.length, 1);
    const blocked = await runtime.dispatchFetch("https://example.test/kiosk/heartbeat", { method: "POST", headers: { authorization: "Bearer one", "content-type": "application/json" }, body: JSON.stringify({ readerOnline: true, releaseVersion: "synthetic-budget" }) });
    assert.equal(blocked.status, 503, "Even a terminal update with a retained lock must fail closed");
  } finally { await runtime.dispose(); }
});
