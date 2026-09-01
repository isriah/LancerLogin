#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const workspace = resolve(process.cwd());
const migrationsDirectory = join(workspace, "apps", "api", "migrations");
const temporary = await mkdtemp(join(workspace, ".d1-migration-verify-"));
const stateDirectory = join(temporary, "state");
const configPath = join(temporary, "wrangler.json");
const databaseName = "lancerlogin-migration-verification";
const wranglerEntry = join(workspace, "node_modules", "wrangler", "bin", "wrangler.js");

function insideWorkspace(path) {
  const value = relative(workspace, resolve(path));
  return Boolean(value && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function runWrangler(arguments_, { json = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [wranglerEntry, ...arguments_], {
      cwd: workspace,
      shell: false,
      env: { ...process.env, CI: "true", WRANGLER_LOG_PATH: join(temporary, "wrangler-logs"), WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code !== 0) return rejectRun(new Error(`Wrangler migration verification failed (${code}).\n${stdout}\n${stderr}`));
      if (!json) process.stdout.write(stdout);
      if (stderr && !json) process.stderr.write(stderr);
      resolveRun(stdout);
    });
  });
}

try {
  if (!insideWorkspace(temporary)) throw new Error(`Unsafe migration verification directory: ${temporary}`);
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    name: "lancerlogin-migration-verifier",
    main: "../apps/api/src/index.ts",
    compatibility_date: "2026-08-01",
    d1_databases: [{
      binding: "DB",
      database_name: databaseName,
      database_id: "00000000-0000-4000-8000-000000000003",
      migrations_dir: "../apps/api/migrations",
    }],
  }, null, 2)}\n`, { mode: 0o600 });

  await runWrangler(["d1", "migrations", "apply", databaseName, "--local", "--config", configPath, "--persist-to", stateDirectory]);
  const output = await runWrangler(["d1", "execute", databaseName, "--local", "--config", configPath, "--persist-to", stateDirectory, "--json", "--command", "SELECT name FROM d1_migrations ORDER BY id; SELECT name, sql FROM sqlite_master WHERE name IN ('organization_settings', 'kiosks', 'meetings', 'pairing_codes', 'simulated_kiosk_sessions', 'users', 'idx_one_user_per_member', 'idx_meetings_series', 'attendance_events', 'encrypted_integrations', 'integration_verification_challenges', 'idx_integration_verification_expiry', 'discord_attendance_notifications', 'discord_attendance_recipients') ORDER BY name;"], { json: true });
  const result = JSON.parse(output);
  const applied = result[0]?.results?.map((row) => row.name) ?? [];
  const expected = (await readdir(migrationsDirectory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  if (JSON.stringify(applied) !== JSON.stringify(expected)) throw new Error(`Applied migration list differs from source. Expected ${expected.join(", ")}; received ${applied.join(", ")}`);

  const schema = new Map((result[1]?.results ?? []).map((row) => [row.name, row.sql]));
  const brandingSql = schema.get("organization_settings") ?? "";
  const kioskSql = schema.get("kiosks") ?? "";
  const meetingSql = schema.get("meetings") ?? ""; const meetingSeriesIndexSql = schema.get("idx_meetings_series") ?? ""; const pairingSql = schema.get("pairing_codes") ?? ""; const simulatorSql = schema.get("simulated_kiosk_sessions") ?? "";
  const usersSql = schema.get("users") ?? ""; const memberUserIndexSql = schema.get("idx_one_user_per_member") ?? "";
  if (!brandingSql.includes("'themed'") || !kioskSql.includes("reader_online") || !kioskSql.includes("release_version") || !kioskSql.includes("pending_events") || !kioskSql.includes("last_sync_at")) throw new Error("Final D1 schema is missing themed branding or retained kiosk health fields");
  if (!meetingSql.includes("is_test") || !pairingSql.includes("'simulator'") || !simulatorSql.includes("online")) throw new Error("Final D1 schema is missing isolated browser simulator fields");
  if (!meetingSql.includes("recurrence_frequency") || !meetingSql.includes("series_id") || !meetingSeriesIndexSql.includes("series_id")) throw new Error("Final D1 schema is missing recurring-meeting fields or index");
  if (!usersSql.includes("member_id") || !memberUserIndexSql.includes("member_id")) throw new Error("Final D1 schema is missing the optional one-to-one roster account link");
  const attendanceSql = schema.get("attendance_events") ?? ""; const notificationSql = schema.get("discord_attendance_notifications") ?? ""; const recipientSql = schema.get("discord_attendance_recipients") ?? "";
  if (!brandingSql.includes("late_scan_minutes") || !brandingSql.includes("logo_backdrop") || !attendanceSql.includes("check_out") || !notificationSql.includes("message_id") || !recipientSql.includes("discord_user_id")) throw new Error("Final D1 schema is missing attendance lifecycle or durable Discord notification fields");
  const integrationSql = schema.get("encrypted_integrations") ?? ""; const challengeSql = schema.get("integration_verification_challenges") ?? ""; const challengeIndexSql = schema.get("idx_integration_verification_expiry") ?? "";
  if (!integrationSql.includes("verified_at") || !challengeSql.includes("challenge_hash") || !challengeSql.includes("expires_at") || !challengeIndexSql.includes("expires_at")) throw new Error("Final D1 schema is missing integration verification state or expiry index");
  const migrationText = (await Promise.all(expected.map((name) => readFile(join(migrationsDirectory, name), "utf8")))).join("\n");
  if (/fingerprint_template|raw_fingerprint|biometric_template/i.test(migrationText)) throw new Error("D1 migrations violate the biometric storage boundary");
  console.log(`Verified ${applied.length} D1 migration(s) on a fresh local database: ${applied.join(", ")}`);
} finally {
  if (insideWorkspace(temporary)) await rm(temporary, { recursive: true, force: true });
}
