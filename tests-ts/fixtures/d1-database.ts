// quick-check: covers apps/api/migrations/**
// The canonical in-memory D1 for TypeScript tests: every Core migration, optionally the d1_migrations ledger D1 keeps and a
// seeded installation (InstallationSeed), then optional module migrations through the module migration runner. Other
// fixture databases (backup-database.ts, lifecycle-database.ts) are seeds over TestD1Database; tests that need their own
// database subclass it rather than copying a D1 statement adapter.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { D1Database, D1Result, D1Statement } from "../../apps/api/src/d1-usage.ts";
import { adoptedBaselineName, applyModuleMigrations, d1ModuleMigrationExecutor, loadModuleMigrationPackage, moduleMigrationLedgerTable, planModuleMigrations, type MigrationDirectoryReader, type MigrationFile, type ModuleMigrationLedgerEntry, type ModuleMigrationPackage } from "../../apps/api/src/module-migrations.ts";

export const coreMigrationDirectory = fileURLToPath(new URL("../../apps/api/migrations/", import.meta.url));
export const nodeMigrationDirectoryReader: MigrationDirectoryReader = { list: (directory) => readdir(directory), read: (path) => readFile(path, "utf8") };

let coreMigrationFiles: readonly MigrationFile[] | undefined;
/** Every Core migration in order, read once per process. */
export function readCoreMigrations(): MigrationFile[] {
  coreMigrationFiles ??= readdirSync(coreMigrationDirectory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort().map((name) => Object.freeze({ name, content: readFileSync(`${coreMigrationDirectory}/${name}`, "utf8") }));
  return [...coreMigrationFiles];
}

/** Run every Core migration on a synchronous SQLite database, as D1 does when an installation is created. */
export function applyCoreMigrations(sqlite: DatabaseSync, migrations: readonly MigrationFile[] = readCoreMigrations()) {
  for (const file of migrations) sqlite.exec(file.content);
}

/** Record Core migrations in d1_migrations, as D1 does once it has applied them, so adopted baselines can be checked. */
export function recordCoreMigrations(sqlite: DatabaseSync, names: readonly string[] = readCoreMigrations().map((file) => file.name)) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const insert = sqlite.prepare("INSERT OR IGNORE INTO d1_migrations(name) VALUES (?)");
  for (const name of names) insert.run(name);
}

/**
 * Apply composed modules' migration packages to a synchronous fixture database right after Core migrations, as the Worker's
 * module reconciliation does on an installation's first request: the runner's plan against the ledger, then each pending
 * migration's statements and its ledger row in one transaction (an adopted baseline records its row without SQL). Pass the
 * composed build's packages (`externalModuleMigrations`); an empty list, as in a Core build without plugins, changes nothing.
 * Returns the ledger the packages expect, for assertions that follow the composed plugin rather than a hard-coded list.
 */
export function applyComposedModuleMigrations(sqlite: DatabaseSync, packages: readonly ModuleMigrationPackage[], options: { readonly coreAppliedMigrations?: readonly string[]; readonly now?: string } = {}) {
  const coreApplied = options.coreAppliedMigrations ?? readCoreMigrations().map((file) => file.name);
  const now = options.now ?? new Date().toISOString();
  for (const pkg of packages) {
    const ledger = sqlite.prepare(`SELECT sequence, name, sha256 FROM ${moduleMigrationLedgerTable} WHERE module_id = ? ORDER BY sequence`).all(pkg.moduleId) as ModuleMigrationLedgerEntry[];
    for (const migration of planModuleMigrations(pkg, ledger, coreApplied).pending) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of migration.statements) sqlite.exec(statement);
        sqlite.prepare(`INSERT INTO ${moduleMigrationLedgerTable} (module_id, sequence, name, sha256, applied_at) VALUES (?, ?, ?, ?, ?)`).run(pkg.moduleId, migration.sequence, migration.name, migration.sha256, now);
        sqlite.exec("COMMIT");
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    }
  }
}

/** The ledger rows (sequence and name, in order) a module's migration package records once fully applied. */
export function expectedModuleLedger(pkg: ModuleMigrationPackage | undefined): { sequence: number; name: string }[] {
  if (!pkg) return [];
  return [...pkg.baseline ? [{ sequence: 0, name: adoptedBaselineName }] : [], ...pkg.migrations.map(({ sequence, name }) => ({ sequence, name }))];
}

/** A module whose migrations the runner applies after Core migrations. */
export type TestModuleMigrations = { readonly moduleId: string; readonly tablePrefix: string; readonly directory?: string; readonly adoptedCoreMigrations?: readonly string[] };

/**
 * A D1 prepared statement over node:sqlite. As in D1, a statement that returns columns (SELECT, WITH, a PRAGMA read,
 * RETURNING) gives its rows in a batch or from run(); any other statement gives its change count. `onRead` is called for
 * each first() and all(), for tests that count reads.
 */
export class Statement implements D1Statement {
  readonly database: DatabaseSync;
  readonly sql: string;
  values: unknown[];
  readonly onRead: (() => void) | undefined;
  constructor(database: DatabaseSync, sql: string, values: unknown[] = [], onRead?: () => void) { this.database = database; this.sql = sql; this.values = values; this.onRead = onRead; }
  bind(...values: unknown[]) { return new Statement(this.database, this.sql, values, this.onRead); }
  native(): StatementSync { return this.database.prepare(this.sql); }
  async first<T>() { this.onRead?.(); return (this.native().get(...this.values as []) as T | undefined) ?? null; }
  async all<T>() { this.onRead?.(); return { results: this.native().all(...this.values as []) as T[], meta: { changes: 0 } } as D1Result<T>; }
  async run() { return this.batchResult(); }
  batchResult(): D1Result {
    const statement = this.native();
    if (statement.columns().length) return { success: true, results: statement.all(...this.values as []), meta: { changes: 0 } } as D1Result;
    const result = statement.run(...this.values as []);
    return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
  }
}

export type TestD1Options = {
  readonly coreMigrations?: readonly MigrationFile[];
  /** Record every Core migration in d1_migrations, as D1 does once it has applied them (module baselines read the ledger). */
  readonly recordMigrations?: boolean;
  /** Rows to insert after migrations: an InstallationSeed or plain SQL. */
  readonly seed?: InstallationSeed | string;
};

export class TestD1Database implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly coreMigrations: readonly MigrationFile[];
  /** first() and all() calls made through this database's statements. */
  reads = 0;
  constructor(options: TestD1Options = {}) {
    this.coreMigrations = options.coreMigrations ?? readCoreMigrations();
    applyCoreMigrations(this.sqlite, this.coreMigrations);
    if (options.recordMigrations) recordCoreMigrations(this.sqlite, this.coreMigrations.map((file) => file.name));
    if (options.seed) this.sqlite.exec(typeof options.seed === "string" ? options.seed : options.seed.sql());
  }
  prepare(sql: string) { return new Statement(this.sqlite, sql, [], () => { this.reads += 1; }); }
  /** Atomic like a D1 batch: every statement commits or none does. */
  async batch(statements: D1Statement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof Statement)) throw new Error("Unexpected test statement");
        return statement.batchResult();
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close() { this.sqlite.close(); }
  /** Apply module migrations in order through the module migration runner. */
  async applyModuleMigrations(modules: readonly TestModuleMigrations[], now?: () => string) {
    const executor = d1ModuleMigrationExecutor(this);
    const applied: Record<string, readonly string[]> = {};
    for (const module of modules) {
      const pkg = await loadModuleMigrationPackage(nodeMigrationDirectoryReader, { ...module, coreMigrations: this.coreMigrations });
      applied[module.moduleId] = (await applyModuleMigrations(executor, pkg, { coreAppliedMigrations: this.coreMigrations.map((file) => file.name), now })).applied;
    }
    return applied;
  }
}

/** Build a Core database. Module migrations run only when `modules` is given explicitly. */
export async function createTestD1Database(options: TestD1Options & { readonly modules?: readonly TestModuleMigrations[]; readonly now?: () => string } = {}) {
  const database = new TestD1Database(options);
  if (options.modules?.length) await database.applyModuleMigrations(options.modules, options.now);
  return database;
}

const quote = (value: string | number | null) => value === null ? "NULL" : typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
const row = (values: readonly (string | number | null)[]) => `(${values.map(quote).join(",")})`;
type SeedModule = { readonly id: string; readonly phase: "enabled" | "disabled"; readonly setupVersion: number; readonly setupComplete: boolean; readonly generation?: number };
type SeedMember = { readonly id: string; readonly externalId: string; readonly firstName: string; readonly lastName: string; readonly createdAt?: string; readonly attendanceRequiredFrom?: string };

/**
 * A synthetic installation, built up step by step, as SQL for TestD1Database's `seed`: the `primary` installation, its
 * settings, users, platform modules and members. Each step appends rows in call order, so foreign keys follow the calls.
 */
export class InstallationSeed {
  private readonly statements: string[] = [];
  private readonly userIds: string[] = [];
  readonly installationId = "primary";
  /** When users and members were created; the installation's own time by default. */
  readonly rowsCreatedAt: string;
  readonly createdAt: string;
  constructor(createdAt: string, installation: { readonly googleCalendarEnabled?: boolean; readonly rowsCreatedAt?: string } = {}) {
    this.createdAt = createdAt;
    this.rowsCreatedAt = installation.rowsCreatedAt ?? createdAt;
    this.statements.push(installation.googleCalendarEnabled === undefined
      ? `INSERT INTO installations(id,created_at,auth_mode) VALUES ${row([this.installationId, createdAt, "local"])};`
      : `INSERT INTO installations(id,created_at,auth_mode,google_calendar_enabled) VALUES ${row([this.installationId, createdAt, "local", installation.googleCalendarEnabled ? 1 : 0])};`);
  }
  /** Local users whose IDs, usernames and roles are the same word ("admin", "operator"). */
  users(...roles: readonly ("admin" | "operator")[]) {
    this.userIds.push(...roles);
    return this.add(`INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ${roles.map((role) => row([role, this.installationId, role, role, this.rowsCreatedAt])).join(",")};`);
  }
  organization(timeZone = "UTC") { return this.add(`INSERT INTO organization_settings(installation_id,time_zone) VALUES ${row([this.installationId, timeZone])};`); }
  hoursEntrySettings() { return this.add(`INSERT INTO hours_entry_settings(installation_id) VALUES ${row([this.installationId])};`); }
  members(...members: readonly SeedMember[]) {
    return this.add(`INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,attendance_required_from) VALUES ${members.map((member) => row([member.id, this.installationId, member.externalId, member.firstName, member.lastName, member.createdAt ?? this.rowsCreatedAt, member.attendanceRequiredFrom ?? this.rowsCreatedAt])).join(",")};`);
  }
  /**
   * Module administration at revision 0 with module selection complete, the given platform modules, and assignment epochs
   * and revisions for every user added so far.
   */
  modules(...modules: readonly SeedModule[]) {
    const id = this.installationId;
    this.add(`INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ${row([id, 0, 1])};`);
    this.add(`INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ${row([id, 0])};`);
    if (this.userIds.length) {
      this.add(`INSERT INTO platform_module_assignment_epochs(installation_id,user_id,revision) VALUES ${this.userIds.map((user) => row([id, user, 0])).join(",")};`);
      this.add(`INSERT INTO platform_module_assignment_revisions(installation_id,user_id,revision) VALUES ${this.userIds.map((user) => row([id, user, 0])).join(",")};`);
    }
    this.add(`INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ${modules.map((module) => row([id, module.id, module.generation ?? 1])).join(",")};`);
    return this.add(`INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ${modules.map((module) => row([id, module.id, 1, module.generation ?? 1, module.phase, module.setupVersion, module.setupComplete ? 1 : 0])).join(",")};`);
  }
  assign(userId: string, moduleId: string, capabilities: readonly string[]) { return this.add(`INSERT INTO platform_module_assignments(installation_id,user_id,module_id,capabilities_json) VALUES ${row([this.installationId, userId, moduleId, JSON.stringify(capabilities)])};`); }
  /** Completed setup steps for a module, completed by a user at a time. */
  setupProgress(moduleId: string, setupVersion: number, steps: readonly string[], completedAt: string, completedBy: string) {
    return this.add(`INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) VALUES ${steps.map((step) => row([this.installationId, moduleId, step, setupVersion, "completed", completedAt, completedBy])).join(",")};`);
  }
  /** Further rows as plain SQL. */
  add(sql: string) { this.statements.push(sql); return this; }
  sql() { return this.statements.join("\n"); }
}

/** The Attendance and Outreach platform modules most Worker fixtures start from: Attendance enabled at setup version 2, Outreach disabled. */
export const attendanceWithOutreachDisabled = (attendanceSetupComplete: boolean): SeedModule[] => [
  { id: "attendance", phase: "enabled", setupVersion: 2, setupComplete: attendanceSetupComplete },
  { id: "hour-tracking", phase: "disabled", setupVersion: 1, setupComplete: false },
];
