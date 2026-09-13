import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REPOSITORY = "example/LancerLogin";
export const DATABASE = "lancerlogin-v2-example-recovery-test";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ACCOUNT = /^[a-f0-9]{32}$/;
const BOOKMARK = /^[a-zA-Z0-9_-]{1,256}$/;
const LIMIT = 1024 * 1024;
const MODES = ["create", "initialize", "interrupt", "resume", "fail-migration", "backup", "damage", "restore", "sql-import", "status"];
export class RecoveryError extends Error {}
const fail = (message) => { throw new RecoveryError(message); };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Every data-changing statement is fixed here. No CLI SQL, table, or URL override.
export const SQL = Object.freeze({
  tables: "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name <> '_cf_KV' ORDER BY name",
  schema: [
    "CREATE TABLE recovery_fixture (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE recovery_job (id INTEGER PRIMARY KEY CHECK(id=1), checkpoint INTEGER NOT NULL, status TEXT NOT NULL, owner TEXT, lease_until INTEGER NOT NULL)",
    "INSERT INTO recovery_job VALUES (1,0,'ready',NULL,0)",
  ],
  claim: "UPDATE recovery_job SET owner=?, lease_until=unixepoch()+15 WHERE id=1 AND lease_until<=unixepoch() RETURNING owner",
  release: "UPDATE recovery_job SET owner=NULL, lease_until=0 WHERE id=1 AND owner=?",
  job: "SELECT checkpoint,status FROM recovery_job WHERE id=1",
  idle: "SELECT id FROM recovery_job WHERE id=1 AND owner IS NULL AND lease_until=0",
  first: "INSERT OR IGNORE INTO recovery_fixture SELECT 'synthetic-1','baseline' WHERE EXISTS (SELECT 1 FROM recovery_job WHERE id=1 AND owner=? AND lease_until>unixepoch())",
  second: "INSERT OR IGNORE INTO recovery_fixture SELECT 'synthetic-2','resumed' WHERE EXISTS (SELECT 1 FROM recovery_job WHERE id=1 AND owner=? AND lease_until>unixepoch())",
  checkpoint: "UPDATE recovery_job SET checkpoint=?,status=? WHERE id=1 AND owner=? AND lease_until>unixepoch() RETURNING checkpoint",
  failure: "CREATE TABLE recovery_invalid (broken THIS IS DELIBERATELY INVALID SQL !!!)",
  data: "SELECT id,value FROM recovery_fixture ORDER BY id",
  damage: "INSERT OR IGNORE INTO recovery_fixture VALUES ('synthetic-damage','restore-must-remove')",
});

export async function boundedBytes(response, limit = LIMIT) {
  if (!response.ok || !response.body) fail("Provider response unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail("Provider response exceeds the synthetic artifact limit");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

function adapter(account, token, fetchImpl) {
  async function request(path, method = "GET", body, timeoutMs = 30_000) {
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const document = JSON.parse((await boundedBytes(response)).toString("utf8"));
      if (document.success !== true) fail("Cloudflare request unsuccessful");
      return document.result;
    } catch { fail("Cloudflare operation failed; inspect the durable stage before retrying"); }
  }
  return {
    verify: () => request("tokens/verify"),
    async list() {
      const entries = [];
      for (let page = 1; page <= 100; page++) {
        const rows = await request(`d1/database?page=${page}&per_page=100`);
        if (!Array.isArray(rows)) fail("Invalid database inventory");
        entries.push(...rows);
        if (rows.length < 100) return entries;
      }
      fail("Database inventory limit exceeded");
    },
    create: () => request("d1/database", "POST", { name: DATABASE }),
    get: (id) => request(`d1/database/${id}`),
    async query(id, sql, params = []) {
      const results = await request(`d1/database/${id}/query`, "POST", { sql, params });
      if (!Array.isArray(results) || results.length !== 1 || results[0].success !== true || !Array.isArray(results[0].results)) fail("D1 query unsuccessful");
      return results[0].results;
    },
    bookmark: (id) => request(`d1/database/${id}/time_travel/bookmark`),
    export: (id, bookmark) => request(`d1/database/${id}/export`, "POST", {
      output_format: "polling", ...(bookmark ? { current_bookmark: bookmark } : {}),
      dump_options: { tables: ["recovery_fixture", "recovery_job"] },
    }),
    restore: (id, bookmark) => request(`d1/database/${id}/time_travel/restore?bookmark=${encodeURIComponent(bookmark)}`, "POST"),
    import: (id, body, timeoutMs) => request(`d1/database/${id}/import`, "POST", body, timeoutMs),
    async upload(value, bytes, etag, timeoutMs = 30_000) {
      const url = importUploadUrl(value);
      try {
        const response = await fetchImpl(url.href, { method: "PUT", body: bytes,
          headers: { "content-length": String(bytes.length) }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
        await response.body?.cancel();
        if (response.status !== 200 || response.headers.get("etag")?.replace(/^"|"$/g, "") !== etag) fail("Upload verification failed");
      } catch { fail("Synthetic import upload failed; retained upload can be retried"); }
    },
    async download(value) {
      let url;
      try { url = new URL(value); } catch { fail("Invalid export URL"); }
      // Provider-returned URL only, never a user-supplied endpoint; no bearer token.
      if (url.protocol !== "https:" || !/^[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname) || url.port || url.username || url.password) fail("Export host requires review");
      try { return await boundedBytes(await fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(30_000) })); }
      catch { fail("Export download failed or exceeded its limit"); }
    },
  };
}

function importUploadUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail("Invalid import upload URL"); }
  // Only the authenticated API can supply this URL. Provider suffix is fixed;
  // a different host family needs code review, never a CLI override.
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname) || url.port || url.username || url.password) fail("Import upload host requires review");
  return url;
}

// Intentionally accepts only this experiment's five fixed SQL statements and
// known dump envelopes. A new provider dump format requires review, not a parser
// fallback. Removing identifier quotes is safe only because the entire result
// must equal a fixed statement below (including every literal fixture value).
export function syntheticImportBytes(bytes) {
  if (!bytes.length || bytes.length > LIMIT) fail("Invalid synthetic export size");
  const statements = bytes.toString("utf8").split(";").map((s) => s.trim()).filter(Boolean);
  const normalize = (s) => s.replace(/"/g, "").replace(/\s+/g, " ").replace(/\s*([(),=])\s*/g, "$1").trim();
  const allowed = [SQL.schema[0], SQL.schema[1],
    "INSERT INTO recovery_fixture VALUES('synthetic-1','baseline')",
    "INSERT INTO recovery_fixture VALUES('synthetic-2','resumed')",
    "INSERT INTO recovery_job VALUES(1,2,'migration-failed-recoverable',NULL,0)"].map(normalize);
  // The observed D1 export lists columns explicitly. Map only the fixed ordered
  // lists to their canonical statement so mixed-form duplicates still fail.
  const explicitColumns = new Map(allowed.slice(2).map((statement) => [
    normalize(statement.replace(' VALUES', statement.startsWith('INSERT INTO recovery_fixture ')
      ? '(id,value) VALUES' : '(id,checkpoint,status,owner,lease_until) VALUES')), statement,
  ]));
  const seen = new Set();
  for (const statement of statements) {
    const form = normalize(statement);
    const normalized = explicitColumns.get(form) ?? form;
    if (["PRAGMA defer_foreign_keys=TRUE", "PRAGMA foreign_keys=OFF", "PRAGMA foreign_keys=ON", "BEGIN TRANSACTION", "COMMIT"].includes(normalized)) continue;
    if (!allowed.includes(normalized) || seen.has(normalized)) fail("Export is not the fixed synthetic schema and records; review dump format");
    seen.add(normalized);
  }
  if (seen.size !== allowed.length) fail("Synthetic export is incomplete");
  // Canonical fixed statements retain the verified export's schema and data;
  // discard transaction envelopes which the D1 import service manages itself.
  return Buffer.from(["DROP TABLE IF EXISTS recovery_fixture", "DROP TABLE IF EXISTS recovery_job", ...allowed].join(";\n") + ";\n");
}

async function sqlImport({ api, query, storage, backup, bytes, id, account, sleep }) {
  const deadline = Date.now() + 120_000;
  const remaining = () => {
    const ms = Math.min(30_000, deadline - Date.now());
    if (ms <= 0) fail("Import time budget exhausted; inspect retained checkpoint");
    return ms;
  };
  if (backup.phase !== "restored" || backup.job?.checkpoint !== 2 || backup.job.status !== "migration-failed-recoverable") fail("SQL import requires the verified Time Travel drill first");
  if (!/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(backup.exportHost ?? "")) fail("Saved export host required for exact import host pin");
  const objects = await query("SELECT type,name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name <> '_cf_KV' ORDER BY name");
  if (JSON.stringify(objects) !== JSON.stringify([{ type: "table", name: "recovery_fixture" }, { type: "table", name: "recovery_job" }])) fail("Unexpected schema objects; synthetic import stopped");
  const currentData = await query(SQL.data);
  assertData(currentData.filter((row) => row.id !== "synthetic-damage"));
  if (currentData.some((row) => row.id === "synthetic-damage" && row.value !== "restore-must-remove")) fail("Unexpected synthetic damage marker");
  if (JSON.stringify((await query(SQL.job))[0]) !== JSON.stringify(backup.job) || (await query(SQL.idle)).length !== 1) fail("SQL import requires the idle synthetic checkpoint");
  const verifySchema = async () => {
    const schema = await query("SELECT sql FROM sqlite_schema WHERE type='table' AND name IN ('recovery_fixture','recovery_job') ORDER BY name");
    if (schema.length !== 2 || schema.some((row, i) => row.sql.replace(/\s+/g, "").replace(/"/g, "") !== SQL.schema[i].replace(/\s+/g, ""))) fail("Imported schema mismatch");
  };
  await verifySchema();
  const payload = syntheticImportBytes(bytes);
  const hash = digest(payload);
  const etag = createHash("md5").update(payload).digest("hex"); // Provider transport requirement only.
  let state = await storage.read("import.json");
  const save = async (next) => { await storage.save("import.json", next); state = next; };
  const verify = async () => {
    assertData(await query(SQL.data));
    if (JSON.stringify((await query(SQL.job))[0]) !== JSON.stringify(backup.job) || (await query(SQL.idle)).length !== 1) fail("Imported checkpoint mismatch");
    await verifySchema();
  };
  if (!state) {
    await verify();
    await save({ databaseId: id, accountId: account, exportSha256: backup.sha256, sha256: hash, etag, phase: "damage-pending" });
  }
  if (state.databaseId !== id || state.accountId !== account || state.exportSha256 !== backup.sha256 || state.sha256 !== hash || state.etag !== etag ||
      !["damage-pending", "ready", "init-pending", "upload", "ingest-pending", "poll", "complete", "failed"].includes(state.phase)) fail("Import checkpoint identity or digest mismatch");
  if (state.phase === "damage-pending") {
    await query(SQL.damage); // Fixed idempotent marker proves restoration actually changed data.
    await save({ ...state, phase: "ready" });
  }
  const accept = async (result) => {
    if (result?.status === "error" || result?.success === false) { await save({ ...state, phase: "failed" }); fail("Provider import failed; retain recovery records for review"); }
    if (result?.status === "complete") { await save({ ...state, phase: "complete" }); return; }
    if (!BOOKMARK.test(result?.at_bookmark ?? "")) fail("Import response has no polling checkpoint; reconcile before retry");
    if (state.phase === "poll" && result.at_bookmark !== state.bookmark) fail("Import polling identity changed; retain saved checkpoint");
    await save({ ...state, phase: "poll", bookmark: result.at_bookmark });
  };
  if (["init-pending", "ingest-pending"].includes(state.phase)) {
    // No API idempotency guarantee and no returned bookmark: never reissue init
    // or ingest. If the marker disappeared with exact schema/data, reconcile.
    try { await verify(); } catch { fail("Import outcome uncertain; read-only reconciliation needs coordinator review"); }
    await save({ ...state, phase: "complete", reconciled: true });
  }
  if (state.phase === "failed") fail("Failed import requires coordinator review; automatic restart prohibited");
  if (state.phase === "ready") {
    await save({ ...state, phase: "init-pending" });
    const result = await api.import(id, { action: "init", etag }, remaining());
    if (result?.status === "error" || result?.success === false) await accept(result);
    if (result?.upload_url !== undefined) {
      if (importUploadUrl(result.upload_url).hostname !== backup.exportHost) fail("Import host differs from observed export host; review required");
      if (typeof result.filename !== "string" || !/^[a-zA-Z0-9_./-]{1,512}$/.test(result.filename) || result.filename.includes("..")) fail("Invalid provider import filename");
      await save({ ...state, phase: "upload", uploadUrl: result.upload_url, filename: result.filename });
    } else await accept(result);
  }
  if (state.phase === "upload") {
    if (importUploadUrl(state.uploadUrl).hostname !== backup.exportHost || typeof state.filename !== "string" || !/^[a-zA-Z0-9_./-]{1,512}$/.test(state.filename) || state.filename.includes("..")) fail("Saved import upload destination mismatch");
    await api.upload(state.uploadUrl, payload, etag, remaining());
    await save({ ...state, phase: "ingest-pending", uploadUrl: undefined });
    await accept(await api.import(id, { action: "ingest", etag, filename: state.filename }, remaining()));
  }
  for (let attempt = 0; state.phase === "poll" && attempt < 30; attempt++) {
    if (!BOOKMARK.test(state.bookmark ?? "")) fail("Invalid saved import bookmark");
    await accept(await api.import(id, { action: "poll", current_bookmark: state.bookmark }, remaining()));
    if (state.phase === "poll") await sleep(1000);
  }
  if (state.phase !== "complete") fail("Import polling limit exceeded; resume the saved bookmark");
  await verify();
  return { stage: "sql-import", status: "imported-and-verified", syntheticRows: 2, bytes: payload.length, sha256: hash, reconciled: state.reconciled === true };
}

function identity(value, expectedAccount, expectedId) {
  if (value?.name !== DATABASE || !UUID.test(value.uuid ?? "") || (expectedId && value.uuid !== expectedId) ||
      [value.account_id, value.account?.id].some((id) => id !== undefined && id !== expectedAccount)) fail("Disposable database identity mismatch");
  return value.uuid;
}

export async function runJob(query, mode, owner = randomUUID()) {
  const claim = await query(SQL.claim, [owner]);
  if (claim.length !== 1 || claim[0].owner !== owner) fail("Concurrent recovery job rejected; lease remains active");
  const mark = async (checkpoint, status) => {
    if ((await query(SQL.checkpoint, [checkpoint, status, owner])).length !== 1) fail("Recovery lease expired before checkpoint");
  };
  let interrupted = false;
  try {
    const [job] = await query(SQL.job);
    if (!job || ![0, 1, 2].includes(job.checkpoint)) fail("Unexpected recovery checkpoint");
    if (mode === "fail-migration") {
      if (job.checkpoint !== 2) fail("Complete the resume drill first");
      await mark(2, "migration-started");
      let rejected = false;
      try { await query(SQL.failure); } catch { rejected = true; }
      if (!rejected) fail("Injected migration unexpectedly succeeded");
      await mark(2, "migration-failed-recoverable");
      return { status: "migration-failed-recoverable", checkpoint: 2 };
    }
    await query(SQL.first, [owner]);
    if (job.checkpoint === 0) await mark(1, "interrupted");
    if (mode === "interrupt") {
      if (job.checkpoint !== 0) fail("Interruption drill requires the fresh initialized checkpoint");
      // Second owner genuinely contends against the persisted lease in D1.
      if ((await query(SQL.claim, [randomUUID()])).length !== 0) fail("Concurrent lock rejection failed");
      interrupted = true; // Deliberately leave lease and checkpoint behind on process exit.
      return { status: "interrupted", checkpoint: 1, concurrentLockRejected: true, resumeAfterSeconds: 16 };
    }
    await query(SQL.second, [owner]);
    await mark(2, "complete");
    const data = await query(SQL.data);
    assertData(data);
    return { status: "complete", checkpoint: 2, syntheticRows: data.length };
  } finally { if (!interrupted) await query(SQL.release, [owner]); }
}

function assertData(data) {
  if (JSON.stringify(data) !== JSON.stringify([{ id: "synthetic-1", value: "baseline" }, { id: "synthetic-2", value: "resumed" }])) fail("Synthetic data verification failed");
}

// storage is injected only by tests. CLI always uses an ignored, fixed local directory.
export async function recoverySpike(options, { env = process.env, fetchImpl = fetch, storage, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { mode, repository, expectedAccountId, expectedDatabaseId } = options;
  if (repository !== REPOSITORY || !MODES.includes(mode)) fail("Approved development repository and explicit recovery stage required");
  if (!ACCOUNT.test(expectedAccountId ?? "") || expectedAccountId !== env.CLOUDFLARE_ACCOUNT_ID || !/^cfat_[A-Za-z0-9_-]+$/.test(env.CLOUDFLARE_API_TOKEN ?? "")) fail("Secure account token and matching approved account required");
  if (mode !== "create" && !UUID.test(expectedDatabaseId ?? "")) fail("Exact disposable database ID required");
  if (!storage) fail("Private artifact storage required");
  const api = adapter(expectedAccountId, env.CLOUDFLARE_API_TOKEN, fetchImpl);
  if ((await api.verify())?.status !== "active") fail("Account token inactive");
  if (mode === "create") {
    if (await storage.read("identity.json")) fail("Local recovery identity already exists");
    if ((await api.list()).some((entry) => entry.name === DATABASE)) fail("Disposable database collision; automatic adoption prohibited");
    const id = identity(await api.create(), expectedAccountId);
    // Save immediately: never recreate after an ambiguous response or local write failure.
    await storage.save("identity.json", { databaseId: id, accountId: expectedAccountId, name: DATABASE }, true);
    identity(await api.get(id), expectedAccountId, id);
    return { stage: mode, database: DATABASE, databaseId: id };
  }
  const saved = await storage.read("identity.json");
  if (saved?.databaseId !== expectedDatabaseId || saved.accountId !== expectedAccountId || saved.name !== DATABASE) fail("Private recovery identity does not match approval");
  identity(await api.get(expectedDatabaseId), expectedAccountId, expectedDatabaseId);
  const query = (sql, params) => api.query(expectedDatabaseId, sql, params);
  if (mode === "initialize") {
    if ((await query(SQL.tables)).length) fail("Initialization requires a completely fresh disposable database");
    for (const sql of SQL.schema) await query(sql);
    return { stage: mode, status: "initialized" };
  }
  const names = (await query(SQL.tables)).map((row) => row.name);
  if (JSON.stringify(names) !== JSON.stringify(["recovery_fixture", "recovery_job"])) fail("Unexpected tables; disposable-only recovery stopped");
  if (["interrupt", "resume", "fail-migration"].includes(mode)) return { stage: mode, ...await runJob(query, mode) };
  if (mode === "status") {
    const [job] = await query(SQL.job);
    return { stage: mode, checkpoint: job?.checkpoint, status: job?.status, syntheticRows: (await query(SQL.data)).length };
  }
  if (mode === "backup") {
    assertData(await query(SQL.data));
    const [job] = await query(SQL.job);
    if (job?.checkpoint !== 2 || job.status !== "migration-failed-recoverable" || (await query(SQL.idle)).length !== 1) fail("Backup requires the completed failure drill and an idle job");
    if (await storage.read("backup.json")) fail("Backup record already exists; overwrite prohibited");
    const { bookmark } = await api.bookmark(expectedDatabaseId);
    if (!BOOKMARK.test(bookmark ?? "")) fail("Invalid Time Travel bookmark");
    let current;
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await api.export(expectedDatabaseId, current);
      if (result?.status === "error" || result?.success === false) fail("D1 export failed");
      if (result?.status === "complete") {
        const bytes = await api.download(result.result?.signed_url);
        if (!bytes.length) fail("Empty export rejected");
        await storage.bytes("backup.sql", bytes);
        const record = { databaseId: expectedDatabaseId, accountId: expectedAccountId, bookmark, sha256: digest(bytes), bytes: bytes.length, exportHost: new URL(result.result.signed_url).hostname, job, phase: "backed-up" };
        await storage.save("backup.json", record, true);
        return { stage: mode, status: "saved", bytes: bytes.length, sha256: record.sha256 };
      }
      if (!BOOKMARK.test(result?.at_bookmark ?? "")) fail("Invalid export polling bookmark");
      current = result.at_bookmark;
      await sleep(1000);
    }
    fail("D1 export polling limit exceeded");
  }
  const backup = await storage.read("backup.json");
  if (backup?.databaseId !== expectedDatabaseId || backup.accountId !== expectedAccountId || !BOOKMARK.test(backup.bookmark ?? "")) fail("Matching durable backup required");
  const bytes = await storage.loadBytes("backup.sql");
  if (!bytes.length || bytes.length !== backup.bytes || bytes.length > LIMIT || digest(bytes) !== backup.sha256) fail("Backup artifact digest mismatch");
  if (mode === "sql-import") return sqlImport({ api, query, storage, backup, bytes, id: expectedDatabaseId, account: expectedAccountId, sleep });
  if (mode === "damage") {
    if (backup.phase !== "backed-up") fail("Damage drill already started");
    await storage.save("backup.json", { ...backup, phase: "damage-pending" });
    await query(SQL.damage);
    await storage.save("backup.json", { ...backup, phase: "damaged" });
    return { stage: mode, status: "synthetic-damage-written" };
  }
  if (!["damaged", "damage-pending", "restore-pending", "restored"].includes(backup.phase)) fail("Run the synthetic damage stage before restore");
  if (backup.phase !== "restored") {
    await storage.save("backup.json", { ...backup, phase: "restore-pending" });
    // A retry uses the same persisted bookmark, never a new point in time.
    const result = await api.restore(expectedDatabaseId, backup.bookmark);
    if (!BOOKMARK.test(result?.previous_bookmark ?? "")) fail("Restore response missing recovery bookmark; retain pending record");
    await storage.save("restore-response.json", { previousBookmark: result.previous_bookmark });
  }
  identity(await api.get(expectedDatabaseId), expectedAccountId, expectedDatabaseId);
  assertData(await query(SQL.data));
  if (JSON.stringify((await query(SQL.job))[0]) !== JSON.stringify(backup.job)) fail("Restored job checkpoint does not match backup");
  await storage.save("backup.json", { ...backup, phase: "restored" });
  return { stage: mode, status: "restored-and-verified", syntheticRows: 2 };
}

export function parseRecoveryArgs(args) {
  const [mode, ...values] = args;
  const result = { mode };
  const keys = { "--repository": "repository", "--expected-account": "expectedAccountId", "--expected-database": "expectedDatabaseId" };
  for (let i = 0; i < values.length; i += 2) {
    const key = keys[values[i]];
    if (!key || result[key] || !values[i + 1] || values[i + 1].startsWith("--")) fail("Unsupported or duplicate recovery argument");
    result[key] = values[i + 1];
  }
  return result;
}

async function privateStorage() {
  const dir = resolve(".provision/recovery-spike");
  const output = execFileSync("git", ["check-ignore", "--", ".provision/recovery-spike/identity.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!output.trim()) fail("Recovery artifact directory must be Git ignored");
  await mkdir(dir, { recursive: true });
  return {
    async read(name) { try { return JSON.parse(await readFile(resolve(dir, name), "utf8")); } catch (error) { if (error.code === "ENOENT") return undefined; fail("Private recovery record unreadable"); } },
    async save(name, value, exclusive = false) {
      const bytes = JSON.stringify(value, null, 2);
      if (exclusive) return writeFile(resolve(dir, name), bytes, { flag: "wx", mode: 0o600 });
      const temporary = resolve(dir, `${name}.${randomUUID()}.tmp`);
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, resolve(dir, name));
    },
    bytes: (name, bytes) => writeFile(resolve(dir, name), bytes, { flag: "wx", mode: 0o600 }),
    async loadBytes(name) {
      const path = resolve(dir, name);
      if ((await stat(path)).size > LIMIT) fail("Local artifact exceeds its bound");
      return readFile(path);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (![`https://github.com/${REPOSITORY}.git`, `git@github.com:${REPOSITORY}.git`].includes(remote)) fail("Unapproved checkout origin");
    console.log(JSON.stringify(await recoverySpike(parseRecoveryArgs(process.argv.slice(2)), { storage: await privateStorage() })));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof RecoveryError ? error.message : "Recovery stage failed; retained private records require inspection" }));
    process.exitCode = 1;
  }
}
