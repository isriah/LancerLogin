import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// A real Worker and D1 behind loopback HTTP lets independent production kiosk
// processes exercise their ordinary network client without live providers.
export async function createKioskPollCloud() {
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
    for (const name of (await readdir("apps/api/migrations")).filter(name => name.endsWith(".sql")).sort()) await db.exec((await readFile(`apps/api/migrations/${name}`, "utf8")).replace(/^\s*--.*$/gm, "").replace(/\r?\n/g, " "));
    await db.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO platform_module_administration VALUES('primary',0,1);
      INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES('primary','attendance',1,1,'enabled',2,1);
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,active,created_at) VALUES('member','primary','synthetic-member','Synthetic','Member',1,'2026-01-01');`.replace(/\n/g, " "));
    for (const device of ["one", "two"]) {
      await db.prepare("INSERT INTO pairing_codes(id,installation_id,code_hash,purpose,expires_at,created_by,created_at) VALUES(?,'primary',?,'hardware','2099-01-01','admin','2026-01-01')").bind(device, device).run();
      await db.prepare("INSERT INTO kiosks(id,installation_id,name,token_hash,pairing_code_id,pairing_bound,created_at) VALUES(?,'primary',?,?,?,1,'2026-01-01')").bind(device, `Synthetic ${device}`, createHash("sha256").update(device).digest("base64url"), device).run();
    }
    const now = Date.now();
    await db.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES('synthetic-meeting','primary','Synthetic meeting',?,?,0,'admin',?)").bind(new Date(now - 3600000).toISOString(), new Date(now + 3600000).toISOString(), new Date(now).toISOString()).run();
    const payload = Buffer.from(JSON.stringify({ userId: "admin", role: "admin", expiresAt: now + 300000 })).toString("base64url");
    const cookie = `lancerlogin_session=${payload}.${createHmac("sha256", Buffer.from(secret, "base64url")).update(payload).digest("base64url")}`;
    const offline = new Set(), records = [];
    const server = createServer(async (request, response) => {
      const device = request.headers.authorization?.replace(/^Bearer /, "");
      const path = new URL(request.url, "http://127.0.0.1");
      const record = { device, path: path.pathname, fingerprints: path.searchParams.get("fingerprints") === "1", configuration: path.searchParams.get("config") === "1", time: Date.now() }; records.push(record);
      try {
        if (offline.has(device)) { record.status = 503; response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"Synthetic network outage"}'); return; }
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const result = await runtime.dispatchFetch(`https://example.test${request.url}`, { method: request.method, headers: request.headers, ...(body ? { body } : {}) });
        record.status = result.status; record.reads = Number(result.headers.get("x-test-reads")); record.writes = Number(result.headers.get("x-test-writes"));
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
      } catch { response.writeHead(500); response.end('{"error":"Synthetic Worker request failed"}'); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { db, records, offline, apiUrl: `http://127.0.0.1:${server.address().port}`,
      admin: (path, body, method = body === undefined ? "GET" : "POST") => runtime.dispatchFetch(`https://example.test${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }),
      async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await runtime.dispose(); },
    };
  } catch (error) { await runtime.dispose(); throw error; }
}
