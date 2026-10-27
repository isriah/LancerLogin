// Per-module migrations applied after Core migrations and recorded in platform_module_migrations.
// Pure functions plus injected IO so the same rules run in the Worker, Node scripts and tests.
import type { D1Database } from "./d1-usage.ts";

export const moduleMigrationLedgerTable = "platform_module_migrations";
export const adoptedBaselineName = "adopted-baseline";
/**
 * Core identity rows an external module may reference by foreign key. They are Core-owned, keyed by stable
 * text IDs and outlive every module lifecycle: the installation tenant, roster people, dashboard accounts and
 * roster labels. Module data such as meetings, kiosks, credentials and provider state is deliberately absent.
 * References must use ON DELETE CASCADE or ON DELETE SET NULL so a module never blocks Core deletion.
 */
export const coreIdentityTables: readonly string[] = Object.freeze(["installations", "members", "users", "member_labels"]);
/** Names Core keeps for its own or SQLite's schema; a module prefix may not claim or contain them. */
export const reservedTablePrefixes: readonly string[] = Object.freeze(["sqlite_", "d1_", "cf_", "platform_", "core_"]);

const moduleIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const tablePrefixPattern = /^[a-z][a-z0-9_]*_$/;
const migrationNamePattern = /^(\d{4})_[a-z0-9][a-z0-9_]*\.sql$/;
const coreMigrationNamePattern = /^\d{4}_[a-z0-9][a-z0-9_]*\.sql$/;
const shaPattern = /^[0-9a-f]{64}$/;
const tableNamePattern = /^[a-z][a-z0-9_]*$/;

export type ModuleMigrationErrorCode =
  | "module_migration_invalid"
  | "module_migration_hash_review_required"
  | "module_migration_path_review_required"
  | "module_migration_downgrade_refused"
  | "module_migration_ownership_violation"
  | "module_migration_baseline_unavailable"
  | "module_migration_failed";

export class ModuleMigrationError extends Error {
  readonly code: ModuleMigrationErrorCode;
  constructor(code: ModuleMigrationErrorCode, message: string) { super(message); this.name = "ModuleMigrationError"; this.code = code; }
}

export type MigrationFile = { readonly name: string; readonly content: string };
export type ReviewedModuleMigration = { readonly name: string; readonly sha256: string };
export type ModuleMigration = { readonly sequence: number; readonly name: string; readonly sha256: string; readonly statements: readonly string[] };
export type AdoptedBaseline = { readonly migrations: readonly ReviewedModuleMigration[]; readonly sha256: string };
export type ModuleMigrationPackage = { readonly moduleId: string; readonly tablePrefix: string; readonly migrations: readonly ModuleMigration[]; readonly baseline?: AdoptedBaseline };
export type ModuleMigrationLedgerEntry = { readonly sequence: number; readonly name: string; readonly sha256: string };
export type PendingModuleMigration =
  | { readonly kind: "baseline"; readonly sequence: 0; readonly name: string; readonly sha256: string; readonly statements: readonly []; readonly adopted: readonly string[] }
  | ({ readonly kind: "migration" } & ModuleMigration);
export type ModuleMigrationPlan = { readonly moduleId: string; readonly applied: readonly ModuleMigrationLedgerEntry[]; readonly pending: readonly PendingModuleMigration[] };
export type ModuleMigrationStatement = { readonly sql: string; readonly bindings: readonly unknown[] };
/** Database access for the runner. `batch` must be atomic, as a D1 batch is. */
export type ModuleMigrationExecutor = {
  all(sql: string, bindings: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  batch(statements: readonly ModuleMigrationStatement[]): Promise<void>;
};
export type MigrationDirectoryReader = {
  list(directory: string): Promise<readonly string[]>;
  read(path: string): Promise<string>;
};

const fail = (code: ModuleMigrationErrorCode, message: string): never => { throw new ModuleMigrationError(code, message); };

/** SHA-256 of migration text with CRLF normalized to LF, the same rule Core applies to its reviewed migrations. */
export async function migrationSha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content.replaceAll("\r\n", "\n")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateTablePrefix(prefix: unknown): string {
  if (typeof prefix !== "string" || !tablePrefixPattern.test(prefix) || prefix.length > 40) return fail("module_migration_invalid", `Invalid module table prefix ${JSON.stringify(prefix)}`);
  if (reservedTablePrefixes.some((reserved) => reserved.startsWith(prefix) || prefix.startsWith(reserved))) return fail("module_migration_invalid", `Module table prefix ${prefix} overlaps a reserved Core prefix`);
  return prefix;
}

/** Reject a prefix that would claim Core tables, except tables the module adopted from historical Core migrations. */
export function assertPrefixClearOfCoreTables(prefix: string, coreTables: Iterable<string>, adoptedTables: Iterable<string> = []) {
  const adopted = new Set(adoptedTables);
  const claimed = [...coreTables].filter((table) => table.startsWith(prefix) && !adopted.has(table)).sort();
  if (claimed.length) fail("module_migration_ownership_violation", `Module table prefix ${prefix} would claim Core tables: ${claimed.join(", ")}`);
}

// SQL tokenizer and statement splitter. Unknown syntax fails closed.
type Token = { readonly kind: "word" | "quoted" | "string" | "number" | "blob" | "param" | "punct"; readonly text: string; readonly value: string; readonly start: number; readonly end: number };
const operators = ["->>", "->", "||", "<=", ">=", "<>", "!=", "==", "<<", ">>"];
const wordPattern = /[A-Za-z_][A-Za-z0-9_$]*/y;
const numberPattern = /0[xX][0-9A-Fa-f]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/y;
const paramPattern = /[?:@$][A-Za-z0-9_]*/y;
const match = (pattern: RegExp, text: string, index: number) => { pattern.lastIndex = index; return pattern.exec(text)?.[0]; };

function tokenize(sql: string, label: string): Token[] {
  const tokens: Token[] = []; let index = 0;
  const push = (kind: Token["kind"], start: number, end: number, value = sql.slice(start, end)) => { tokens.push({ kind, text: sql.slice(start, end), value, start, end }); index = end; };
  const closing = (start: number, quote: string) => {
    let cursor = start + 1;
    for (;;) {
      const next = sql.indexOf(quote, cursor);
      if (next < 0) return fail("module_migration_invalid", `${label}: unterminated quoted text`);
      if (quote !== "]" && sql[next + 1] === quote) { cursor = next + 2; continue; }
      return next + 1;
    }
  };
  while (index < sql.length) {
    const char = sql[index]!; const next = sql[index + 1];
    if (/\s/.test(char)) { index++; continue; }
    if (char === "-" && next === "-") { const end = sql.indexOf("\n", index); index = end < 0 ? sql.length : end + 1; continue; }
    if (char === "/" && next === "*") { const end = sql.indexOf("*/", index + 2); if (end < 0) fail("module_migration_invalid", `${label}: unterminated comment`); index = end + 2; continue; }
    if (char === "'") { const end = closing(index, "'"); push("string", index, end); continue; }
    if ((char === "x" || char === "X") && next === "'") { const end = closing(index + 1, "'"); push("blob", index, end); continue; }
    if (char === "\"" || char === "`") { const end = closing(index, char); push("quoted", index, end, sql.slice(index + 1, end - 1).replaceAll(char + char, char).toLowerCase()); continue; }
    if (char === "[") { const end = closing(index, "]"); push("quoted", index, end, sql.slice(index + 1, end - 1).toLowerCase()); continue; }
    const word = match(wordPattern, sql, index);
    if (word) { push("word", index, index + word.length, word.toLowerCase()); continue; }
    const number = match(numberPattern, sql, index);
    if (number) { push("number", index, index + number.length); continue; }
    if ("?:@$".includes(char)) { push("param", index, index + match(paramPattern, sql, index)!.length); continue; }
    const operator = operators.find((candidate) => sql.startsWith(candidate, index));
    if (operator) { push("punct", index, index + operator.length); continue; }
    if ("();,.=<>+-*/%&|~!".includes(char)) { push("punct", index, index + 1); continue; }
    fail("module_migration_invalid", `${label}: unsupported character ${JSON.stringify(char)}`);
  }
  return tokens;
}

type Statement = { readonly sql: string; readonly tokens: readonly Token[] };
const isWord = (token: Token | undefined, ...values: string[]) => token?.kind === "word" && values.includes(token.value);
const isPunct = (token: Token | undefined, value: string) => token?.kind === "punct" && token.text === value;

/** Split statements on top-level semicolons, keeping trigger bodies and CASE expressions intact. */
function splitTokens(sql: string, tokens: readonly Token[], label: string): Statement[] {
  const statements: Statement[] = []; let current: Token[] = []; let depth = 0; let trigger = false;
  const finish = () => { if (current.length) statements.push({ sql: sql.slice(current[0]!.start, current.at(-1)!.end), tokens: current }); current = []; trigger = false; };
  for (const token of tokens) {
    if (isPunct(token, ";") && depth === 0) { finish(); continue; }
    current.push(token);
    if (token.kind !== "word") continue;
    if (token.value === "trigger" && current.length <= 3 && isWord(current[0], "create")) trigger = true;
    if (token.value === "case" || token.value === "begin" && trigger) depth++;
    else if (token.value === "end" && depth > 0) depth--;
  }
  if (depth !== 0) fail("module_migration_invalid", `${label}: unbalanced BEGIN, CASE or END`);
  finish();
  return statements;
}

/** Split migration SQL into the individual statements a D1 batch executes. */
export function splitSqlStatements(sql: string, label = "migration"): string[] {
  return splitTokens(sql, tokenize(sql, label), label).map((statement) => statement.sql);
}

type OwnershipContext = { readonly label: string; readonly prefix: string; readonly identity: ReadonlySet<string> };
const aliasStops = new Set(["where", "join", "inner", "left", "right", "full", "outer", "cross", "natural", "on", "using", "group", "order", "limit", "union", "except", "intersect", "window", "having", "returning", "set", "values", "select", "from", "indexed", "not", "end", "when", "then", "else", "do", "as"]);
const tableFunctions = new Set(["json_each", "json_tree"]);

class OwnershipChecker {
  readonly tokens: readonly Token[];
  readonly context: OwnershipContext;
  position = 0;
  constructor(tokens: readonly Token[], context: OwnershipContext) { this.tokens = tokens; this.context = context; }
  reject(message: string): never { return fail("module_migration_ownership_violation", `${this.context.label}: ${message}`); }
  peek(offset = 0) { return this.tokens[this.position + offset]; }
  next() { const token = this.tokens[this.position++]; if (!token) this.reject("statement ended unexpectedly"); return token!; }
  word(...values: string[]) { const token = this.next(); if (!isWord(token, ...values)) this.reject(`expected ${values.map((value) => value.toUpperCase()).join(" or ")} but found ${JSON.stringify(token.text)}`); return token.value; }
  optional(...sequence: string[]) { if (sequence.every((value, offset) => isWord(this.peek(offset), value))) { this.position += sequence.length; return true; } return false; }
  atEnd() { return this.position >= this.tokens.length; }
  end() { if (!this.atEnd()) this.reject(`unexpected ${JSON.stringify(this.peek()!.text)}`); }
  owned(name: string) { return name.startsWith(this.context.prefix) && name.length > this.context.prefix.length && tableNamePattern.test(name); }
  name(): string {
    const token = this.next();
    if (token.kind !== "word" && token.kind !== "quoted" || !tableNamePattern.test(token.value)) this.reject(`expected a plain schema name but found ${JSON.stringify(token.text)}`);
    if (isPunct(this.peek(), ".")) this.reject(`schema-qualified name ${token.text}.${this.peek(1)?.text ?? ""} is not allowed`);
    return token.value;
  }
  ownedName(kind: string) { const name = this.name(); if (!this.owned(name)) this.reject(`${kind} ${name} is outside the module table prefix ${this.context.prefix}`); return name; }

  check() {
    for (const token of this.tokens) {
      if (token.kind === "param") this.reject("bound parameters are not allowed in migrations");
      if (isWord(token, "with", "recursive", "attach", "detach", "pragma", "vacuum", "load_extension")) this.reject(`${token.text.toUpperCase()} is not allowed`);
    }
    const first = this.peek();
    if (isWord(first, "create")) return this.create();
    if (isWord(first, "alter")) return this.alter();
    if (isWord(first, "drop")) return this.drop();
    if (isWord(first, "insert", "replace", "update", "delete")) return this.dml(false);
    return this.reject(`${first ? JSON.stringify(first.text.toUpperCase()) : "an empty statement"} is not an allowed migration statement`);
  }

  create() {
    this.word("create");
    if (isWord(this.peek(), "temp", "temporary", "virtual", "view")) this.reject(`CREATE ${this.peek()!.text.toUpperCase()} is not allowed`);
    const unique = this.optional("unique");
    const kind = this.word(...(unique ? ["index"] : ["table", "index", "trigger"]));
    this.optional("if", "not", "exists");
    if (kind === "table") {
      this.ownedName("table");
      if (!isPunct(this.peek(), "(")) this.reject("CREATE TABLE must declare columns; CREATE TABLE AS is not allowed");
      return this.definitionBody(this.position);
    }
    if (kind === "index") {
      this.ownedName("index");
      this.word("on"); this.ownedName("indexed table");
      return this.definitionBody(this.position);
    }
    return this.trigger();
  }

  /** Column, constraint and index definitions: no subqueries, and every REFERENCES target is owned or Core identity. */
  definitionBody(from: number) {
    for (let index = from; index < this.tokens.length; index++) {
      const token = this.tokens[index]!;
      if (isWord(token, "select", "from")) this.reject(`${token.text.toUpperCase()} is not allowed in a schema definition`);
      if (isWord(token, "references")) this.reference(index);
    }
  }

  reference(index: number) {
    const target = this.tokens[index + 1];
    if (!target || target.kind !== "word" && target.kind !== "quoted" || !tableNamePattern.test(target.value) || isPunct(this.tokens[index + 2], ".")) this.reject("REFERENCES must name a plain table");
    if (this.owned(target!.value)) return;
    if (!this.context.identity.has(target!.value)) this.reject(`foreign key references ${target!.value}, which is neither module owned nor a Core identity table (${[...this.context.identity].join(", ")})`);
    // The clause runs to the next comma or closing parenthesis at its own depth, after an optional column list.
    let cursor = index + 2; let depth = 0; const clause: Token[] = [];
    if (isPunct(this.tokens[cursor], "(")) { while (cursor < this.tokens.length && !isPunct(this.tokens[cursor], ")")) cursor++; cursor++; }
    for (; cursor < this.tokens.length; cursor++) {
      const token = this.tokens[cursor]!;
      if (isPunct(token, "(")) depth++;
      else if (isPunct(token, ")")) { if (depth === 0) break; depth--; }
      else if (isPunct(token, ",") && depth === 0) break;
      clause.push(token);
    }
    const onDelete = clause.findIndex((token, position) => isWord(token, "on") && isWord(clause[position + 1], "delete"));
    const deletes = onDelete >= 0 && (isWord(clause[onDelete + 2], "cascade") || isWord(clause[onDelete + 2], "set") && isWord(clause[onDelete + 3], "null"));
    if (!deletes) this.reject(`foreign key to Core table ${target!.value} must use ON DELETE CASCADE or ON DELETE SET NULL`);
  }

  trigger() {
    this.ownedName("trigger");
    if (this.optional("instead", "of")) this.reject("INSTEAD OF triggers are not allowed");
    if (!this.optional("before")) this.optional("after");
    const event = this.word("delete", "insert", "update");
    if (event === "update" && this.optional("of")) { this.name(); while (isPunct(this.peek(), ",")) { this.next(); this.name(); } }
    this.word("on"); this.ownedName("trigger table");
    this.optional("for", "each", "row");
    const begin = this.tokens.findIndex((token, index) => index >= this.position && isWord(token, "begin"));
    if (begin < 0 || !isWord(this.tokens.at(-1), "end")) this.reject("trigger body must be BEGIN ... END");
    if (this.position < begin) { if (!isWord(this.peek(), "when")) this.reject(`unexpected ${JSON.stringify(this.peek()!.text)} before BEGIN`); this.reads(this.position + 1, begin); }
    const body = this.tokens.slice(begin + 1, -1);
    let statement: Token[] = []; let depth = 0; const statements: Token[][] = [];
    for (const token of body) {
      if (isPunct(token, ";") && depth === 0) { if (statement.length) statements.push(statement); statement = []; continue; }
      statement.push(token);
      if (isWord(token, "case")) depth++; else if (isWord(token, "end") && depth > 0) depth--;
    }
    if (statement.length) this.reject("trigger body statements must end with a semicolon");
    if (!statements.length) this.reject("trigger body is empty");
    for (const tokens of statements) new OwnershipChecker(tokens, this.context).dml(true);
  }

  alter() {
    this.word("alter"); this.word("table"); this.ownedName("table");
    const action = this.word("rename", "add", "drop");
    if (action === "rename") {
      if (this.optional("to")) { this.ownedName("renamed table"); return this.end(); }
      this.optional("column"); this.name(); this.word("to"); this.name(); return this.end();
    }
    if (action === "drop") { this.optional("column"); this.name(); return this.end(); }
    this.optional("column"); this.name();
    return this.definitionBody(this.position);
  }

  drop() {
    this.word("drop");
    const kind = this.word("table", "index", "trigger");
    this.optional("if", "exists"); this.ownedName(kind); this.end();
  }

  dml(trigger: boolean) {
    const verb = this.word("insert", "replace", "update", "delete", ...(trigger ? ["select"] : []));
    if (verb === "select") return this.reads(this.position, this.tokens.length);
    if (verb === "insert" || verb === "update") { if (this.optional("or")) this.word("rollback", "abort", "replace", "fail", "ignore"); }
    if (verb === "insert" || verb === "replace") this.word("into");
    if (verb === "delete") this.word("from");
    this.ownedName(`${verb.toUpperCase()} target`);
    return this.reads(this.position, this.tokens.length);
  }

  /** Every FROM or JOIN source in the range must be module owned or a Core identity table. */
  reads(from: number, to: number) {
    for (let index = from; index < to; index++) {
      if (!isWord(this.tokens[index], "from", "join")) continue;
      let cursor = index + 1;
      for (;;) {
        const source = this.tokens[cursor];
        if (isPunct(source, "(")) break;
        if (!source || source.kind !== "word" && source.kind !== "quoted" || !tableNamePattern.test(source.value)) this.reject(`unrecognized ${this.tokens[index]!.text.toUpperCase()} source`);
        if (isPunct(this.tokens[cursor + 1], ".")) this.reject(`schema-qualified source ${source!.text} is not allowed`);
        if (isPunct(this.tokens[cursor + 1], "(")) { if (!tableFunctions.has(source!.value)) this.reject(`table function ${source!.text} is not allowed`); break; }
        if (!this.owned(source!.value) && !this.context.identity.has(source!.value)) this.reject(`reads ${source!.value}, which is neither module owned nor a Core identity table`);
        cursor++;
        if (isWord(this.tokens[cursor], "as")) cursor++;
        const alias = this.tokens[cursor];
        if (alias && (alias.kind === "quoted" || alias.kind === "word" && !aliasStops.has(alias.value))) cursor++;
        if (!isPunct(this.tokens[cursor], ",")) break;
        cursor++;
      }
    }
  }
}

/**
 * Statically check module migration SQL. Statements may create, alter, drop and write only tables, indexes and
 * triggers named with the module prefix, read only owned or Core identity tables, and reference Core identity
 * tables by foreign key with a delete action. Everything else, including PRAGMA, ATTACH and VACUUM, is refused.
 * Returns the statements a D1 batch executes.
 */
export function checkModuleMigrationSql(input: { readonly sql: string; readonly tablePrefix: string; readonly label: string; readonly identityTables?: readonly string[] }): string[] {
  const prefix = validateTablePrefix(input.tablePrefix);
  const statements = splitTokens(input.sql, tokenize(input.sql, input.label), input.label);
  if (!statements.length) fail("module_migration_invalid", `${input.label}: migration contains no statements`);
  const context: OwnershipContext = { label: input.label, prefix, identity: new Set(input.identityTables ?? coreIdentityTables) };
  for (const statement of statements) new OwnershipChecker(statement.tokens, context).check();
  return statements.map((statement) => statement.sql);
}

/**
 * Tables a historical Core migration creates, alters, indexes or drops, and indexes and triggers it drops by name. Used for
 * baseline adoption and Core table discovery.
 */
export function schemaTargets(sql: string, label = "migration"): { readonly created: readonly string[]; readonly targets: readonly string[]; readonly droppedObjects: readonly string[] } {
  const created = new Set<string>(); const targets = new Set<string>(); const droppedObjects = new Set<string>();
  for (const { tokens } of splitTokens(sql, tokenize(sql, label), label)) {
    const words = tokens.map((token) => token.kind === "word" || token.kind === "quoted" ? token.value : token.text);
    let index = 0; const at = (value: string) => words[index] === value && ++index;
    if (at("create")) {
      at("unique"); at("temp") || at("temporary"); at("virtual");
      const kind = words[index++];
      if (at("if")) { at("not"); at("exists"); }
      const name = words[index++]!;
      if (kind === "table") { created.add(name); targets.add(name); }
      else if (kind === "index") { while (index < words.length && words[index] !== "on") index++; if (words[index + 1]) targets.add(words[index + 1]!); }
      else if (kind === "trigger") { while (index < words.length && words[index] !== "on") index++; if (words[index + 1]) targets.add(words[index + 1]!); }
    } else if (at("alter") && at("table")) {
      const name = words[index++]!; targets.add(name);
      if (words[index] === "rename" && words[index + 1] === "to" && words[index + 2]) { created.add(words[index + 2]!); targets.add(words[index + 2]!); }
    } else if (at("drop")) {
      const kind = words[index++];
      if (at("if")) at("exists");
      if (kind === "table") targets.add(words[index]!);
      else if ((kind === "index" || kind === "trigger") && words[index]) droppedObjects.add(words[index]!);
    }
  }
  return { created: [...created], targets: [...targets], droppedObjects: [...droppedObjects] };
}

function parseReviewed(value: unknown, label: string): ReviewedModuleMigration[] {
  if (!Array.isArray(value)) return fail("module_migration_invalid", `${label}: reviewed.json must be an array`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("module_migration_invalid", `${label}: reviewed entry ${index + 1} must be an object`);
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "sha256") return fail("module_migration_invalid", `${label}: reviewed entry ${index + 1} must contain exactly name and sha256`);
    const { name, sha256 } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof sha256 !== "string" || !shaPattern.test(sha256)) return fail("module_migration_invalid", `${label}: reviewed entry ${index + 1} is invalid`);
    return { name, sha256 };
  });
}

/**
 * Validate a module's migration files against its reviewed list: NNNN_name.sql numbered contiguously from 0001,
 * exactly the reviewed names in order, LF-normalized SHA-256 hashes, and ownership-checked SQL.
 */
export async function validateModuleMigrationFiles(input: { readonly moduleId: string; readonly tablePrefix: string; readonly files: readonly MigrationFile[]; readonly reviewed: unknown; readonly identityTables?: readonly string[] }): Promise<ModuleMigration[]> {
  if (!moduleIdPattern.test(input.moduleId)) fail("module_migration_invalid", `Invalid module ID ${JSON.stringify(input.moduleId)}`);
  const label = `Module ${input.moduleId}`;
  const reviewed = parseReviewed(input.reviewed, label);
  const files = [...input.files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(files.map((file) => file.name)).size !== files.length) fail("module_migration_invalid", `${label}: duplicate migration file names`);
  if (files.length > 9999) fail("module_migration_invalid", `${label}: too many migrations`);
  for (const [index, file] of files.entries()) {
    const parsed = migrationNamePattern.exec(file.name);
    if (!parsed || file.name.length > 128) fail("module_migration_invalid", `${label}: migration file ${file.name} must be named NNNN_name.sql with lowercase letters, digits and underscores`);
    if (Number(parsed![1]) !== index + 1) fail("module_migration_path_review_required", `${label}: migrations must be numbered contiguously from 0001; found ${file.name} at position ${index + 1}`);
  }
  if (reviewed.length !== files.length || reviewed.some((entry, index) => entry.name !== files[index]!.name)) fail("module_migration_path_review_required", `${label}: reviewed.json must list exactly the migration files in order`);
  const migrations: ModuleMigration[] = [];
  for (const [index, file] of files.entries()) {
    if (await migrationSha256(file.content) !== reviewed[index]!.sha256) fail("module_migration_hash_review_required", `${label}: ${file.name} does not match its reviewed hash`);
    const statements = checkModuleMigrationSql({ sql: file.content, tablePrefix: input.tablePrefix, label: `${label} ${file.name}`, identityTables: input.identityTables });
    migrations.push({ sequence: index + 1, name: file.name, sha256: reviewed[index]!.sha256, statements });
  }
  return migrations;
}

/** Read and validate a module's migrations/ directory through an injected reader (Node fs in scripts and tests). */
export async function readModuleMigrationDirectory(reader: MigrationDirectoryReader, input: { readonly moduleId: string; readonly tablePrefix: string; readonly directory: string; readonly identityTables?: readonly string[] }): Promise<ModuleMigration[]> {
  const entries = await reader.list(input.directory);
  const unexpected = entries.filter((name) => name !== "reviewed.json" && !name.endsWith(".sql"));
  if (unexpected.length) fail("module_migration_invalid", `Module ${input.moduleId}: unexpected entries in migrations directory: ${unexpected.sort().join(", ")}`);
  if (!entries.includes("reviewed.json")) fail("module_migration_invalid", `Module ${input.moduleId}: migrations/reviewed.json is required`);
  let reviewed: unknown;
  try { reviewed = JSON.parse(await reader.read(`${input.directory}/reviewed.json`)); } catch { fail("module_migration_invalid", `Module ${input.moduleId}: migrations/reviewed.json is not valid JSON`); }
  const files = await Promise.all(entries.filter((name) => name.endsWith(".sql")).map(async (name) => ({ name, content: await reader.read(`${input.directory}/${name}`) })));
  return validateModuleMigrationFiles({ moduleId: input.moduleId, tablePrefix: input.tablePrefix, files, reviewed, identityTables: input.identityTables });
}

/**
 * Describe a module's adopted baseline: historical Core migrations that created its schema and stay in the Core
 * sequence. Each must exist in Core, appear once in ascending order, and change only tables with the module prefix.
 */
export async function createAdoptedBaseline(input: { readonly moduleId: string; readonly tablePrefix: string; readonly adopted: readonly string[]; readonly coreMigrations: readonly MigrationFile[] }): Promise<AdoptedBaseline> {
  const label = `Module ${input.moduleId}`; const prefix = validateTablePrefix(input.tablePrefix);
  if (!Array.isArray(input.adopted) || !input.adopted.length) fail("module_migration_invalid", `${label}: an adopted baseline must list at least one Core migration`);
  const core = new Map(input.coreMigrations.map((file) => [file.name, file.content]));
  const migrations: ReviewedModuleMigration[] = [];
  for (const [index, name] of input.adopted.entries()) {
    if (typeof name !== "string" || !coreMigrationNamePattern.test(name) || !core.has(name)) fail("module_migration_baseline_unavailable", `${label}: adopted Core migration ${JSON.stringify(name)} is not part of this Core release`);
    if (index > 0 && !(input.adopted[index - 1]! < name)) fail("module_migration_invalid", `${label}: adopted Core migrations must be unique and in ascending order`);
    // A migration that only drops one of the module's own indexes or triggers still changes only the module's schema.
    const { targets, droppedObjects } = schemaTargets(core.get(name)!, `${label} adopted ${name}`);
    const changed = [...targets, ...droppedObjects];
    if (!changed.length || changed.some((table) => !table.startsWith(prefix))) fail("module_migration_ownership_violation", `${label}: adopted Core migration ${name} must change only ${prefix} tables`);
    migrations.push({ name, sha256: await migrationSha256(core.get(name)!) });
  }
  return { migrations, sha256: await migrationSha256(migrations.map((migration) => `${migration.name} ${migration.sha256}\n`).join("")) };
}

/**
 * Build a module's migration package from its declarations: an optional migrations directory and optional adopted
 * Core migrations. Also refuses a prefix that would claim Core tables the module did not adopt.
 */
export async function loadModuleMigrationPackage(reader: MigrationDirectoryReader, input: { readonly moduleId: string; readonly tablePrefix: string; readonly directory?: string; readonly adoptedCoreMigrations?: readonly string[]; readonly coreMigrations: readonly MigrationFile[]; readonly identityTables?: readonly string[] }): Promise<ModuleMigrationPackage> {
  const tablePrefix = validateTablePrefix(input.tablePrefix);
  const baseline = input.adoptedCoreMigrations?.length ? await createAdoptedBaseline({ moduleId: input.moduleId, tablePrefix, adopted: input.adoptedCoreMigrations, coreMigrations: input.coreMigrations }) : undefined;
  const adoptedTables = input.coreMigrations.filter((file) => input.adoptedCoreMigrations?.includes(file.name)).flatMap((file) => schemaTargets(file.content, `Core ${file.name}`).created);
  assertPrefixClearOfCoreTables(tablePrefix, coreMigrationTables(input.coreMigrations), adoptedTables);
  const migrations = input.directory === undefined ? [] : await readModuleMigrationDirectory(reader, { moduleId: input.moduleId, tablePrefix, directory: input.directory, identityTables: input.identityTables });
  return { moduleId: input.moduleId, tablePrefix, migrations, ...baseline ? { baseline } : {} };
}

/** The set of tables that exists after applying statements in order, following CREATE, DROP and RENAME. */
export function tablesAfterStatements(statements: readonly string[], initialTables: Iterable<string> = [], label = "migration"): string[] {
  const tables = new Set(initialTables);
  for (const statement of statements) for (const { tokens } of splitTokens(statement, tokenize(statement, label), label)) {
    const words = tokens.map((token) => token.kind === "word" || token.kind === "quoted" ? token.value : token.text);
    let index = 0; const at = (value: string) => words[index] === value && ++index > 0;
    if (at("create")) {
      if (!at("temp")) at("temporary");
      if (!at("table")) continue;
      if (at("if")) { at("not"); at("exists"); }
      tables.add(words[index]!);
    } else if (at("drop") && at("table")) {
      if (at("if")) at("exists");
      tables.delete(words[index]!);
    } else if (at("alter") && at("table")) {
      const name = words[index++]!;
      if (at("rename") && at("to")) { tables.delete(name); tables.add(words[index]!); }
    }
  }
  return [...tables].sort();
}

/** Tables created by Core migrations, for prefix conflict checks. */
export function coreMigrationTables(coreMigrations: readonly MigrationFile[]): string[] {
  const tables = new Set<string>();
  for (const file of coreMigrations) for (const table of schemaTargets(file.content, `Core ${file.name}`).created) tables.add(table);
  return [...tables].sort();
}

function expectedLedger(pkg: ModuleMigrationPackage): PendingModuleMigration[] {
  return [
    ...pkg.baseline ? [{ kind: "baseline" as const, sequence: 0 as const, name: adoptedBaselineName, sha256: pkg.baseline.sha256, statements: [] as [], adopted: pkg.baseline.migrations.map((migration) => migration.name) }] : [],
    ...pkg.migrations.map((migration) => ({ kind: "migration" as const, ...migration })),
  ];
}

/**
 * Validate the applied ledger as an exact prefix of the package's expected list and return the pending entries.
 * Applied entries the package does not know are a downgrade and are refused. A pending baseline requires every
 * adopted Core migration to be applied already.
 */
export function planModuleMigrations(pkg: ModuleMigrationPackage, ledger: readonly ModuleMigrationLedgerEntry[], coreAppliedMigrations: readonly string[]): ModuleMigrationPlan {
  const label = `Module ${pkg.moduleId}`; const expected = expectedLedger(pkg);
  const applied = [...ledger].sort((a, b) => a.sequence - b.sequence);
  for (const [index, entry] of applied.entries()) {
    const wanted = expected[index];
    if (!wanted) fail("module_migration_downgrade_refused", `${label}: applied migration ${entry.name} is unknown to this package version; a downgrade is refused`);
    if (wanted!.sequence !== entry.sequence || wanted!.name !== entry.name) {
      const known = expected.some((candidate) => candidate.name === entry.name);
      fail(known ? "module_migration_path_review_required" : "module_migration_downgrade_refused", `${label}: applied migrations are not an exact prefix of the package's reviewed list at ${entry.name}`);
    }
    if (wanted!.sha256 !== entry.sha256) fail("module_migration_hash_review_required", `${label}: applied ${entry.name} has a different hash than the package's reviewed migration`);
  }
  const pending = expected.slice(applied.length);
  const baseline = pending.find((entry) => entry.kind === "baseline");
  if (baseline?.kind === "baseline") {
    const missing = baseline.adopted.filter((name) => !coreAppliedMigrations.includes(name));
    if (missing.length) fail("module_migration_baseline_unavailable", `${label}: adopted Core migrations are not applied: ${missing.join(", ")}`);
  }
  return { moduleId: pkg.moduleId, applied, pending };
}

export async function readModuleMigrationLedger(executor: ModuleMigrationExecutor, moduleId: string): Promise<ModuleMigrationLedgerEntry[]> {
  const rows = await executor.all(`SELECT sequence, name, sha256 FROM ${moduleMigrationLedgerTable} WHERE module_id = ? ORDER BY sequence`, [moduleId]);
  return rows.map((row) => {
    if (!Number.isSafeInteger(row.sequence) || typeof row.name !== "string" || typeof row.sha256 !== "string") return fail("module_migration_invalid", `Module ${moduleId}: unreadable migration ledger row`);
    return { sequence: row.sequence as number, name: row.name, sha256: row.sha256 };
  });
}

/**
 * Apply pending module migrations in order. Each migration's statements and its ledger row run in one atomic
 * batch, so a failure records nothing for that migration; earlier migrations stay applied and recorded.
 * An adopted baseline records its ledger row without running any SQL.
 */
export async function applyModuleMigrations(executor: ModuleMigrationExecutor, pkg: ModuleMigrationPackage, options: { readonly coreAppliedMigrations: readonly string[]; readonly now?: () => string }): Promise<{ readonly applied: readonly string[]; readonly plan: ModuleMigrationPlan }> {
  const plan = planModuleMigrations(pkg, await readModuleMigrationLedger(executor, pkg.moduleId), options.coreAppliedMigrations);
  const applied: string[] = [];
  for (const migration of plan.pending) {
    const record = { sql: `INSERT INTO ${moduleMigrationLedgerTable} (module_id, sequence, name, sha256, applied_at) VALUES (?, ?, ?, ?, ?)`, bindings: [pkg.moduleId, migration.sequence, migration.name, migration.sha256, options.now?.() ?? new Date().toISOString()] };
    try {
      await executor.batch([...migration.statements.map((sql) => ({ sql, bindings: [] })), record]);
    } catch (error) {
      throw new ModuleMigrationError("module_migration_failed", `Module ${pkg.moduleId}: migration ${migration.name} failed and was not recorded${error instanceof Error && error.message ? `: ${error.message}` : ""}`);
    }
    applied.push(migration.name);
  }
  return { applied, plan };
}

/** Executor over a D1 binding. D1 batches are transactions. */
export function d1ModuleMigrationExecutor(db: D1Database): ModuleMigrationExecutor {
  return {
    async all(sql, bindings) { return (await db.prepare(sql).bind(...bindings).all<Record<string, unknown>>()).results ?? []; },
    async batch(statements) { await db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.bindings))); },
  };
}
