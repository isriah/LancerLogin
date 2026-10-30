// Fake D1 database and request helpers shared by Worker runtime tests. Statements return configured rows by SQL fragment and record
// every call and batch, so tests can assert which statements ran.
import { createHash } from "node:crypto";
import { createSessionCodec } from "../../apps/api/src/runtime-security.ts";

/** The SQL fragment of the Worker's per-request session user lookup (id, role and the /auth/session profile columns). */
export const sessionUserLookup = "SELECT id, role, email, local_username AS localUsername, debug_mode AS debugMode FROM users";

export class FakeStatement {
  values: unknown[] = [];
  readonly sql: string;
  readonly database: FakeDatabase;
  constructor(sql: string, database: FakeDatabase) { this.sql = sql; this.database = database; }
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T>() { this.database.calls.push(this); return (this.database.firstResult(this.sql, this.values) ?? null) as T | null; }
  async all<T>() { this.database.calls.push(this); return { results: (this.database.allResult(this.sql, this.values) ?? []) as T[] }; }
  async run() { this.database.calls.push(this); return { success: true, meta: { changes: this.database.runChanges(this.sql, this.values) } }; }
}

export class FakeDatabase {
  calls: FakeStatement[] = [];
  batches: FakeStatement[][] = [];
  denyProviderPreflight = false;
  user?: { id: string; role: "admin" | "operator"; passwordHash: string | null; failedLoginCount?: number; lockedUntil?: string };
  rows = new Map<string, unknown>();
  lists = new Map<string, unknown[]>();
  runChangeHandler?: (sql: string, values: unknown[]) => number;
  prepare(sql: string) { return new FakeStatement(sql, this); }
  async batch(statements: FakeStatement[]) {
    const product = statements.filter((statement) => !statement.sql.includes("AS module_authority"));
    if (this.denyProviderPreflight && product.some((statement) => statement.sql.trim() === "SELECT 1")) throw new Error("module-authority-denied");
    if (product.length === 1) this.calls.push(product[0]!);
    else if (product.length > 1) this.batches.push(product);
    return statements.map((statement) => {
      const readsRows = /^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/i.test(statement.sql);
      if (readsRows || /\bRETURNING\b/i.test(statement.sql)) {
        const listed = this.allResult(statement.sql, statement.values);
        if (listed !== undefined) return { success: true, results: listed };
      }
      if (readsRows) {
        const first = this.firstResult(statement.sql, statement.values);
        return { success: true, results: first === undefined ? [] : [first] };
      }
      return { success: true, meta: { changes: this.runChanges(statement.sql, statement.values) } };
    });
  }
  firstResult(sql: string, values: unknown[]) {
    for (const [fragment, value] of this.rows) if (sql.includes(fragment)) return typeof value === "function" ? (value as (sql: string, values: unknown[]) => unknown)(sql, values) : value;
    if (sql.includes("AS module_authority")) return { module_authority: 1 };
    if (sql.includes("SELECT m.generation FROM users u") && sql.includes("JOIN platform_module_administration")) return { generation: 1 };
    if (sql.includes("SELECT m.generation FROM platform_modules m") && sql.includes("JOIN platform_module_administration")) return { generation: 1 };
    if (sql.includes("FROM installation_update_settings")) return { channel: "stable", revision: 0 };
    if (sql.includes("SELECT id FROM kiosk_commands") && sql.includes("AND id = ?")) {
      const insert = this.batches.flat().find((call) => call.sql.includes("INSERT INTO kiosk_commands") && call.values[0] === values[0]);
      return insert ? { id: values[0] } : undefined;
    }
    if (sql.includes(sessionUserLookup) && sql.includes("active = 1")) {
      const id = String(values[0]);
      return { id, role: id.startsWith("operator") ? "operator" : "admin" };
    }
    if (sql.includes("FROM users")) return this.user;
    return undefined;
  }
  allResult(sql: string, values: unknown[]) {
    if (/^\s*SELECT\s+SUM\b/i.test(sql)) return undefined;
    for (const [fragment, value] of this.lists) {
      if (fragment === "FROM attendance_events" && sql.includes("kiosk_event_id = ?")) continue;
      if (sql.includes(fragment)) return typeof value === "function" ? (value as (sql: string, values: unknown[]) => unknown[])(sql, values) : value;
    }
    if (sql.includes("JOIN platform_module_administration") && sql.includes("ORDER BY m.module_id")) {
      const userId = String(values[1]); const role = userId.startsWith("operator") ? "operator" : "admin";
      return [{ role, revision: 0, selectionCompleted: 1, administrationEpoch: 0, moduleId: "attendance", contractVersion: 1, generation: 1, moduleEpoch: 1, phase: "enabled", setupVersion: 2, setupComplete: 1, disabledAt: null, deleteAfter: null, deletionCursor: 0, cleanupFailure: null, assignmentRevision: 0, assignmentEpoch: 0, capabilitiesJson: role === "operator" ? '["attendance.manage"]' : null }];
    }
    return undefined;
  }
  runChanges(sql: string, values: unknown[]) { return this.runChangeHandler?.(sql, values) ?? 1; }
}

export function seedInstallationBackupFoundation(database: FakeDatabase, users: Record<string, unknown>[] = [{ id: "admin-1", installation_id: "primary", email: null, local_username: "admin", password_hash: "hash", failed_login_count: 0, locked_until: null, role: "admin", active: 1, created_at: "2026-09-01T00:00:00Z", member_id: null, debug_mode: 0 }]) {
  database.lists.set("FROM installations WHERE", [{ id: "primary", created_at: "2026-09-01T00:00:00Z", auth_mode: "local", telemetry_accepted_at: null, telemetry_install_id: null, google_enabled: 0, resend_enabled: 0, discord_enabled: 0, google_calendar_enabled: 0 }]);
  database.lists.set("FROM platform_module_administration WHERE", [{ installation_id: "primary", revision: 0, selection_completed: 1 }]);
  database.lists.set("FROM platform_module_administration_epochs WHERE", [{ installation_id: "primary", revision: 0 }]);
  database.lists.set("FROM platform_module_epochs WHERE", [{ installation_id: "primary", module_id: "attendance", generation: 1 }, { installation_id: "primary", module_id: "hour-tracking", generation: 1 }]);
  database.lists.set("FROM platform_modules WHERE", [
    { installation_id: "primary", module_id: "attendance", contract_version: 1, generation: 1, phase: "enabled", setup_version: 2, setup_complete: 1, disabled_at: null, delete_after: null, deletion_cursor: 0, cleanup_failure: null },
    { installation_id: "primary", module_id: "hour-tracking", contract_version: 1, generation: 1, phase: "disabled", setup_version: 1, setup_complete: 0, disabled_at: null, delete_after: null, deletion_cursor: 0, cleanup_failure: null },
  ]);
  database.lists.set("FROM users WHERE", users);
  database.lists.set("FROM platform_module_assignment_epochs WHERE", users.map((user) => ({ installation_id: "primary", user_id: user.id, revision: 0 })));
  database.lists.set("FROM platform_module_assignment_revisions WHERE", users.map((user) => ({ installation_id: "primary", user_id: user.id, revision: 0 })));
  database.lists.set("FROM platform_module_assignments WHERE", users.filter((user) => user.role === "operator").map((user) => ({ installation_id: "primary", user_id: user.id, module_id: "attendance", capabilities_json: '["attendance.manage"]' })));
  database.lists.set("FROM platform_module_setup_progress WHERE", ["rules", "meeting", "input", "calendar", "discord"].map((stepId) => ({ installation_id: "primary", module_id: "attendance", step_id: stepId, setup_version: 2, outcome: ["calendar", "discord"].includes(stepId) ? "skipped" : "completed", completed_at: "2026-09-01T00:00:00Z", completed_by: "admin-1" })));
}

export const setupCode = "private setup code 1234";
export const setupCodeHash = createHash("sha256").update(setupCode).digest("base64url");
export const request = (path: string, body?: unknown, options: { method?: string; cookie?: string } = {}) => new Request(`https://api.example.test${path}`, {
  method: options.method ?? (body ? "POST" : "GET"),
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(options.cookie ? { cookie: options.cookie } : {}), ...((/^\/admin\/kiosks\/[^/]+\/commands$/.test(path) || ["/discord/contests/accept", "/discord/contests/reject"].includes(path)) && body ? { origin: "https://dashboard.example.test" } : {}) },
  body: body ? JSON.stringify(path === "/setup/bootstrap" && typeof body === "object" ? { setupCode, ...body } : body) : undefined,
});
export const sessionSecret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const sessionCookie = async (role: "admin" | "operator") => `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: `${role}-1`, role })}`;
