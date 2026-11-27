// Core's shared Notion connection: `services.notion` for modules and Settings > Integrations > Notion for Admins. Core
// holds one Notion integration token, encrypted with the integration key; module code never sees it. A module declares
// in its manifest the databases it needs ("bindings") and what it may do with each, an Admin chooses the Notion database
// for each binding, and every call names a binding. There is no raw request: Core builds each path and body itself.
//
// What the scoping protects against is mistakes, not malice: a module that calls an operation it did not declare, a
// binding nobody chose, or a page from another database is refused before it can change anything. Plugins are trusted
// code; this keeps one module's bug out of another module's database.
//
// Limits: each Notion request is counted as one provider request by the scheduler (and rechecks the module's authority,
// one D1 read); one invocation sends at most `notionCallsPerInvocation` requests; and after Notion rate limits any
// module, every module's calls wait until the time Notion named. Logs carry the module, operation and status only.
import type { ModuleDefinition, ModuleNotionBindingDefinition, ModuleNotionOperation, ModuleNotionUserOperation } from "../../../packages/shared/src/module-platform.ts";
import { formatNotionId, notionLink, parseNotionId, sameNotionId, validNotionUrl } from "../../../packages/shared/src/notion-ids.ts";
import type { D1Database, D1Statement } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import type { ModuleCredentials } from "./integration-crypto.ts";
import { NotionError, notionDefaultRetryAfterMs, notionRequest, type NotionJson, type NotionRequest } from "./notion-client.ts";

export const notionCapabilities = ["read", "insert", "update", "comment", "users", "email"] as const;
/**
 * What the token has been seen to allow. In Notion's own words: `read` is Read content, `insert` Insert content,
 * `update` Update content, `comment` Insert comments, `users` Read user information and `email` Read user information
 * including email addresses.
 */
export type NotionCapability = (typeof notionCapabilities)[number];
/** `ok` after a call of that kind succeeded, `refused` after Notion answered 403 to one, `unknown` until either. */
export type NotionCapabilityState = "ok" | "refused" | "unknown";
export type NotionCapabilities = Readonly<Record<NotionCapability, NotionCapabilityState>>;

/** Notion requests one invocation (a route request or one scheduler slice of a job) may send. */
export const notionCallsPerInvocation = 8;
/** The only module that may hand Core a Notion token it stored itself. */
export const notionLegacyImportModule = "part-requests";

export type NotionBinding = { readonly id: string; readonly databaseId: string; readonly dataSourceId: string; readonly name: string };
export type NotionServiceStatus = {
  /** A token is saved, turned on and readable. */
  readonly connected: boolean;
  readonly saved: boolean;
  readonly enabled: boolean;
  readonly readable: boolean;
  /** When calls resume after a rate limit, in epoch milliseconds, or null while none is in force. */
  readonly pausedUntilMs: number | null;
  readonly capabilities: NotionCapabilities;
  /** The bindings this module declared, and whether an Admin has chosen a database for each. */
  readonly bindings: readonly { readonly id: string; readonly required: boolean; readonly bound: boolean }[];
};
export type NotionUser = { readonly id: string; readonly type: "person" | "bot"; readonly name: string; readonly email?: string };
export type NotionQuery = { readonly filter?: unknown; readonly sorts?: readonly unknown[]; readonly pageSize?: number; readonly cursor?: string };
export type NotionLegacyConnection = { readonly ciphertext: string; readonly iv: string; readonly bindings?: readonly NotionBinding[] };

/**
 * Notion through Core's one connection (SDK 1.8.0). Every database call names a binding from the module's manifest
 * `notion.bindings`; Core supplies the database and refuses operations the binding did not declare. Failures throw; read
 * them with `providerStatus`, `retryAfterMs`, `uncertain` and `errorCode` rather than by message.
 */
export type NotionService = {
  /** The connection is usable, delivery is not paused, and every required binding has a database. */
  ready(): Promise<boolean>;
  status(): Promise<NotionServiceStatus>;
  /** The database chosen for a declared binding, or undefined until an Admin chooses one. */
  binding(bindingId: string): Promise<NotionBinding | undefined>;
  /**
   * The bound data source with its properties, as Notion returns it. Needs `retrieve`. Like every page and row below,
   * it comes without `person` (the email address) on user objects unless the module declared `email`.
   */
  dataSource(bindingId: string): Promise<NotionJson>;
  /** One page of rows. Needs `query`. Rows carry every property. */
  query(bindingId: string, query?: NotionQuery): Promise<{ readonly results: readonly NotionJson[]; readonly nextCursor?: string }>;
  /** Create a row from properties only. Needs `pages.create`. An uncertain failure may have created it: do not resend. */
  createPage(bindingId: string, input: { readonly properties: Readonly<Record<string, unknown>> }): Promise<{ readonly id: string; readonly url: string | null; readonly page: NotionJson }>;
  /** One row of the bound database. Needs `pages.retrieve`. */
  page(bindingId: string, pageId: string): Promise<NotionJson>;
  /** Change properties of a row of the bound database; nothing else is sent. Needs `pages.update`. */
  updatePage(bindingId: string, pageId: string, input: { readonly properties: Readonly<Record<string, unknown>> }): Promise<NotionJson>;
  /** Move a row of the bound database to Notion's trash. Needs `pages.trash`. */
  trashPage(bindingId: string, pageId: string): Promise<void>;
  /**
   * Comment on a row of the bound database. Needs `comments.create`. An uncertain failure may have posted it. Notion
   * shows the comment under the name an Admin set for this module, else the module's label (SDK 1.9.0).
   */
  createComment(bindingId: string, pageId: string, input: { readonly richText: readonly unknown[] }): Promise<{ readonly id: string | null }>;
  readonly users: {
    /** One page of workspace users, bots included (guests are not listed by Notion). Needs `users: ["list"]`. */
    list(input?: { readonly cursor?: string; readonly pageSize?: number }): Promise<{ readonly users: readonly NotionUser[]; readonly nextCursor?: string }>;
    /** One user by ID. Needs `users: ["retrieve"]`. */
    get(userId: string): Promise<NotionUser>;
  };
  /** Notion's HTTP status for a failed call (429 also while Core holds calls after a rate limit), else undefined. */
  providerStatus(error: unknown): number | undefined;
  /** Milliseconds to wait after a rate limit, else undefined. */
  retryAfterMs(error: unknown): number | undefined;
  /** Whether Notion may have done the work although the call failed. */
  uncertain(error: unknown): boolean;
  /** A stable code such as `notion_403`, `notion_network`, `notion_unbound` or `notion_not_declared`, else undefined. */
  errorCode(error: unknown): string | undefined;
  /**
   * Migration aid, allowlisted to module "part-requests". Fills an empty connection only, and then keeps a given database
   * only when Notion confirms the data source belongs to it. When Core already has a connection nothing is changed
   * (`kept-existing`) and an Admin chooses the databases. Deprecated; removed in SDK 2.
   */
  importLegacyConnection(input: NotionLegacyConnection): Promise<"imported" | "kept-existing" | "unreadable">;
};

export type NotionLogEntry = { readonly module: string; readonly operation: string; readonly status: number | string };
export type NotionDeps = {
  readonly db: D1Database;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly credentials: ModuleCredentials;
  /** Runs before every Notion request: counts it against the scheduler budget and rechecks the module's authority. */
  readonly authority?: () => Promise<void>;
  /** Whether an Admin's Stop, or a restore, is pausing outbound delivery. Writes are refused while it is. */
  readonly deliveryPausedUntil?: () => Promise<number | null>;
  readonly log?: (entry: NotionLogEntry) => void;
};
/** `definition.label` names the module on the comments it posts until an Admin sets a comment name for it. */
export type NotionCaller = { readonly moduleId: string; readonly definition?: Pick<ModuleDefinition, "notion"> & { readonly label?: string } };

const installationId = "primary";
const unknownCapabilities: NotionCapabilities = Object.freeze({ read: "unknown", insert: "unknown", update: "unknown", comment: "unknown", users: "unknown", email: "unknown" });
const bindingIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const moduleIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const maximumBodyBytes = 200_000;
/** The longest comment name an Admin may set for a module, and the most of a module's label a comment carries. */
export const notionCommentNameLength = 100;
/** The name on a comment when neither an Admin's name nor the module's label is usable; Notion refuses an empty one. */
const fallbackCommentName = "LancerLogin";
/** Whether a module declared `comments.create` on any of its Notion databases. */
const commentsDeclared = (notion: ModuleDefinition["notion"]) => Boolean(notion?.bindings.some((binding) => binding.operations.includes("comments.create")));

type ConnectionRow = { ciphertext: string; iv: string; enabled: number; botName: string; workspaceName: string; checkedAt: string; capabilitiesJson: string; pausedUntilMs: number; revision: number };
type BindingRow = { moduleId: string; bindingId: string; databaseId: string; dataSourceId: string; name: string };
const connectionSelect = "SELECT ciphertext,iv,enabled,bot_name AS botName,workspace_name AS workspaceName,checked_at AS checkedAt,capabilities_json AS capabilitiesJson,paused_until_ms AS pausedUntilMs,revision FROM notion_connection WHERE installation_id=?";
const commentNameSelect = "SELECT name FROM notion_comment_names WHERE installation_id=? AND module_id=?";
const bindingSelect = "SELECT module_id AS moduleId,binding_id AS bindingId,database_id AS databaseId,data_source_id AS dataSourceId,name FROM notion_bindings WHERE installation_id=?";

/** The saved capability record, with anything missing or malformed read as unknown. */
export function parseNotionCapabilities(json: string | null | undefined): NotionCapabilities {
  let parsed: unknown;
  try { parsed = JSON.parse(json ?? "{}"); } catch { parsed = undefined; }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  return Object.freeze(Object.fromEntries(notionCapabilities.map((capability) => [capability, record[capability] === "ok" || record[capability] === "refused" ? record[capability] : "unknown"])) as Record<NotionCapability, NotionCapabilityState>);
}

/** The token in the saved connection, or undefined when Core cannot decrypt it, for example after a restore with another key. */
async function tokenOf(credentials: ModuleCredentials, ciphertext: string, iv: string): Promise<string | undefined> {
  if (!credentials.available) return undefined;
  try { const { token } = await credentials.decrypt(ciphertext, iv); return typeof token === "string" && token ? token : undefined; } catch { return undefined; }
}

const refusal = (code: string, status: number, message: string) => new NotionError(message, code, { status });
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const rowsOf = <T>(result: unknown): T[] => (result as { results?: T[] } | undefined)?.results ?? [];
const plainTitle = (value: unknown): string => Array.isArray(value) ? value.map((part) => String((part as NotionJson | null)?.plain_text ?? "")).join("") : "";

/** What Core returns for a Notion user: no avatar, and an email address only for a module that declared `email`. */
function notionUser(user: NotionJson, withEmail: boolean): NotionUser {
  const email = user?.type === "person" ? user.person?.email : undefined;
  return { id: String(user?.id ?? ""), type: user?.type === "bot" ? "bot" : "person", name: String(user?.name ?? ""), ...(withEmail && typeof email === "string" && email ? { email } : {}) };
}
/**
 * A copy of Notion's JSON with `person` (which holds the email address) removed from every user object, wherever it
 * sits: people properties, `created_by`, `last_edited_by`, rollups and formulas. Names and IDs stay.
 */
export function withoutUserEmails<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutUserEmails(item)) as T;
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>; const user = source.object === "user";
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) if (!(user && key === "person")) copy[key] = withoutUserEmails(item);
  return copy as T;
}
/** Whether the people in an answer carried email addresses: `ok`, `refused` (people without one) or undefined (no people). */
function emailSeen(users: readonly NotionJson[]): "ok" | "refused" | undefined {
  const people = users.filter((user) => user?.type === "person");
  if (!people.length) return undefined;
  return people.some((user) => typeof user.person?.email === "string" && user.person.email) ? "ok" : "refused";
}

/**
 * Shared bookkeeping on the connection row: what the token allows, and the pause after a rate limit. Never throws. Each
 * write names the ciphertext of the token the call used, so a call still in flight when an Admin saves another token
 * cannot mark the new token refused or paused. Without a ciphertext (a token not saved yet) nothing is written.
 */
function connectionRecords(deps: NotionDeps, ciphertext: string | undefined) {
  return {
    /** Write a capability only when it changed. */
    async capability(known: Record<NotionCapability, NotionCapabilityState>, capability: NotionCapability | undefined, state: "ok" | "refused" | undefined) {
      if (!capability || !state || known[capability] === state) return;
      known[capability] = state;
      if (ciphertext === undefined) return;
      try {
        await deps.db.prepare(`UPDATE notion_connection SET capabilities_json=json_set(capabilities_json,'$.${capability}',?) WHERE installation_id=? AND ciphertext=? AND json_extract(capabilities_json,'$.${capability}') IS NOT ?`)
          .bind(state, installationId, ciphertext, state).run();
      } catch { /* A record of what worked; the call's own result stands without it. */ }
    },
    /** Hold every module's calls until the time Notion named. A later time never shortens an earlier one. */
    async pause(untilMs: number) {
      if (ciphertext === undefined) return;
      try { await deps.db.prepare("UPDATE notion_connection SET paused_until_ms=? WHERE installation_id=? AND ciphertext=? AND paused_until_ms<?").bind(untilMs, installationId, ciphertext, untilMs).run(); }
      catch { /* This invocation still holds its own calls; the next rate limit writes the pause again. */ }
    },
  };
}

function auditStatement(db: D1Database, action: string, targetId: string, metadata: Record<string, unknown>, at: number): D1Statement {
  return db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,NULL,?,'integration',?,?,?)")
    .bind(crypto.randomUUID(), installationId, action, targetId, JSON.stringify(metadata), new Date(at).toISOString());
}

function propertiesOf(input: unknown): Record<string, unknown> {
  const properties = isObject(input) ? input.properties : undefined;
  if (!isObject(properties) || !Object.keys(properties).length) throw new HttpError(400, "Notion properties must be a non-empty object");
  if (new TextEncoder().encode(JSON.stringify(properties)).byteLength > maximumBodyBytes) throw new HttpError(400, "Notion properties are too large");
  return properties;
}
function pageIdOf(value: unknown): string {
  const id = formatNotionId(value);
  if (!id) throw new HttpError(400, "A Notion page ID is required");
  return id;
}
const cursorOf = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 200) throw new HttpError(400, "The Notion cursor is invalid");
  return value;
};
const pageSizeOf = (value: unknown): number => {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 100) throw new HttpError(400, "A Notion page size is 1 to 100");
  return Number(value);
};

/** `services.notion` for one module in one invocation. */
export function notionService(deps: NotionDeps, caller: NotionCaller): NotionService {
  const declared = caller.definition?.notion;
  /** Bookkeeping for the saved token this invocation loaded; a legacy token under check (`override`) records nothing. */
  const recordsFor = (state: { connection: ConnectionRow | undefined }, override?: string) => connectionRecords(deps, override === undefined ? state.connection?.ciphertext : undefined);
  const withEmail = Boolean(declared?.users?.includes("email"));
  /** What a module receives: Notion's JSON, without email addresses unless the module declared `email`. */
  const shared = <T,>(value: T): T => withEmail ? value : withoutUserEmails(value);
  type Loaded = { connection: ConnectionRow | undefined; token: string | undefined; bindings: Map<string, BindingRow>; capabilities: Record<NotionCapability, NotionCapabilityState>; commentName: string | undefined };
  const comments = commentsDeclared(declared);
  let loading: Promise<Loaded> | undefined;
  let calls = 0;
  let pausedUntil = 0;
  /** Pages Core returned to this module in this invocation, per binding: they are known to be in its database. */
  const knownPages = new Map<string, Set<string>>();
  const remember = (bindingId: string, pageId: unknown) => {
    const id = formatNotionId(pageId); if (!id) return;
    let pages = knownPages.get(bindingId); if (!pages) knownPages.set(bindingId, pages = new Set());
    pages.add(id);
  };

  /**
   * The connection and this module's bindings, read together once per invocation: one D1 query. A module that may
   * comment has its comment name read in the same batch, so naming a comment costs no query of its own.
   */
  const load = (): Promise<Loaded> => loading ??= (async () => {
    const [connections, bindings, names] = await deps.db.batch([
      deps.db.prepare(connectionSelect).bind(installationId),
      deps.db.prepare(`${bindingSelect} AND module_id=?`).bind(installationId, caller.moduleId),
      ...(comments ? [deps.db.prepare(commentNameSelect).bind(installationId, caller.moduleId)] : []),
    ]);
    const connection = rowsOf<ConnectionRow>(connections)[0];
    pausedUntil = Math.max(pausedUntil, Number(connection?.pausedUntilMs ?? 0));
    return {
      connection, token: connection ? await tokenOf(deps.credentials, connection.ciphertext, connection.iv) : undefined,
      bindings: new Map(rowsOf<BindingRow>(bindings).map((row) => [row.bindingId, row])),
      capabilities: { ...parseNotionCapabilities(connection?.capabilitiesJson) },
      commentName: rowsOf<{ name: string }>(names)[0]?.name,
    };
  })().catch((error) => { loading = undefined; throw error; });

  const usable = (state: Loaded) => Boolean(state.connection && state.connection.enabled === 1 && state.token);

  /** One counted request. `token` overrides the saved one only while a legacy connection is being checked. */
  async function send(operation: string, capability: NotionCapability | undefined, request: NotionRequest, token?: string): Promise<NotionJson> {
    const state = await load();
    if (token === undefined) {
      if (!state.connection) throw refusal("notion_not_configured", 503, "Notion is not connected. An Admin can connect it in Settings > Integrations.");
      if (state.connection.enabled !== 1) throw refusal("notion_disabled", 503, "The Notion connection is turned off. An Admin can turn it on in Settings > Integrations.");
      if (!state.token) throw refusal("notion_unreadable", 503, "The saved Notion token can't be read. An Admin needs to save it again in Settings > Integrations.");
    }
    const now = deps.now();
    if (pausedUntil > now) throw new NotionError("Notion is rate limiting requests. Wait a moment before trying again.", "notion_paused", { status: 429, providerStatus: 429, retryAfterMs: pausedUntil - now });
    if (calls >= notionCallsPerInvocation) throw refusal("notion_call_limit", 429, "This request reached its limit of Notion calls. The rest can continue in the next request or run.");
    calls += 1;
    await deps.authority?.();
    const records = recordsFor(state, token);
    const log = (status: number | string) => { try { deps.log?.({ module: caller.moduleId, operation, status }); } catch { /* Logging never fails a call. */ } };
    try {
      const body = await notionRequest(deps.fetch, token ?? state.token!, request);
      log(200);
      if (token === undefined) await records.capability(state.capabilities, capability, "ok");
      return body;
    } catch (error) {
      if (!(error instanceof NotionError)) throw error;
      log(error.providerStatus ?? error.code);
      if (error.providerStatus === 429) { pausedUntil = deps.now() + (error.retryAfterMs ?? notionDefaultRetryAfterMs); await records.pause(pausedUntil); }
      if (error.providerStatus === 403 && token === undefined) await records.capability(state.capabilities, capability, "refused");
      throw error;
    }
  }

  /** Refuse, before anything is read or sent, an operation the manifest did not declare for this binding. */
  function declaredBinding(bindingId: string, operation?: ModuleNotionOperation): ModuleNotionBindingDefinition {
    const binding = typeof bindingId === "string" ? declared?.bindings.find((item) => item.id === bindingId) : undefined;
    if (!binding) throw refusal("notion_not_declared", 403, "This module did not declare that Notion database in its manifest.");
    if (operation && !binding.operations.includes(operation)) throw refusal("notion_not_declared", 403, `This module did not declare the Notion operation "${operation}" for that database.`);
    return binding;
  }
  /** The database an Admin chose for a declared binding. Refused, before any request, until one is chosen. */
  async function bound(bindingId: string, operation: ModuleNotionOperation): Promise<BindingRow> {
    declaredBinding(bindingId, operation);
    const row = (await load()).bindings.get(bindingId);
    if (!row) throw refusal("notion_unbound", 409, "An Admin has not chosen this module's Notion database yet.");
    return row;
  }
  function declaredUsers(operation: ModuleNotionUserOperation) {
    if (!declared?.users?.includes(operation)) throw refusal("notion_not_declared", 403, `This module did not declare Notion user access "${operation}" in its manifest.`);
  }
  async function requireDeliveryRunning() {
    const until = await deps.deliveryPausedUntil?.();
    if (until !== null && until !== undefined) throw new HttpError(409, "Outbound delivery is paused, so nothing was sent to Notion.");
  }
  const inDataSource = (page: NotionJson, row: BindingRow) => page?.object === "page" && page.parent?.type === "data_source_id" && sameNotionId(page.parent.data_source_id, row.dataSourceId);
  async function refuseOutOfScope(bindingId: string, operation: ModuleNotionOperation): Promise<never> {
    try { await auditStatement(deps.db, "integration.notion_refused", "notion", { moduleId: caller.moduleId, binding: bindingId, operation, reason: "page-outside-binding" }, deps.now()).run(); }
    catch { /* The refusal stands whether or not it could be recorded. */ }
    throw refusal("notion_out_of_scope", 403, "That Notion page is not in the database chosen for this module.");
  }
  /**
   * Prove a page belongs to the binding's database before acting on it. A page Core returned earlier in this invocation
   * is already known and costs nothing; any other page costs one read of the page to see its parent.
   */
  async function requirePageInScope(bindingId: string, row: BindingRow, pageId: string, operation: ModuleNotionOperation) {
    if (knownPages.get(bindingId)?.has(pageId)) return;
    const page = await send("pages.scope", "read", { path: `/pages/${pageId}` });
    if (!inDataSource(page, row)) await refuseOutOfScope(bindingId, operation);
    remember(bindingId, pageId);
  }

  const service: NotionService = {
    async ready() {
      const until = await deps.deliveryPausedUntil?.();
      if (until !== null && until !== undefined) return false;
      const state = await load();
      return usable(state) && (declared?.bindings ?? []).every((binding) => !binding.required || state.bindings.has(binding.id));
    },
    async status() {
      const state = await load(); const now = deps.now();
      return {
        connected: usable(state), saved: Boolean(state.connection), enabled: state.connection?.enabled === 1, readable: Boolean(state.token),
        pausedUntilMs: pausedUntil > now ? pausedUntil : null, capabilities: Object.freeze({ ...state.capabilities }),
        bindings: (declared?.bindings ?? []).map((binding) => ({ id: binding.id, required: binding.required, bound: state.bindings.has(binding.id) })),
      };
    },
    async binding(bindingId) {
      declaredBinding(bindingId);
      const row = (await load()).bindings.get(bindingId);
      return row ? { id: row.bindingId, databaseId: row.databaseId, dataSourceId: row.dataSourceId, name: row.name } : undefined;
    },
    async dataSource(bindingId) {
      const row = await bound(bindingId, "retrieve");
      return shared(await send("retrieve", "read", { path: `/data_sources/${row.dataSourceId}` }));
    },
    async query(bindingId, query = {}) {
      const row = await bound(bindingId, "query");
      if (!isObject(query) || Object.keys(query).some((key) => !["filter", "sorts", "pageSize", "cursor"].includes(key))) throw new HttpError(400, "A Notion query takes only filter, sorts, pageSize and cursor");
      if (query.sorts !== undefined && !Array.isArray(query.sorts)) throw new HttpError(400, "Notion sorts must be a list");
      const cursor = cursorOf(query.cursor);
      const body = { page_size: pageSizeOf(query.pageSize), ...(cursor ? { start_cursor: cursor } : {}), ...(query.filter === undefined ? {} : { filter: query.filter }), ...(query.sorts === undefined ? {} : { sorts: query.sorts }) };
      if (new TextEncoder().encode(JSON.stringify(body)).byteLength > maximumBodyBytes) throw new HttpError(400, "The Notion query is too large");
      const page = await send("query", "read", { path: `/data_sources/${row.dataSourceId}/query`, method: "POST", body });
      // A malformed reply must not read as "no rows".
      if (!Array.isArray(page.results)) throw new NotionError("Notion returned an unreadable response.", "notion_response", { providerStatus: 200 });
      for (const result of page.results as NotionJson[]) if (result?.object === "page") remember(bindingId, result.id);
      return { results: shared(page.results as NotionJson[]), ...(page.has_more && page.next_cursor ? { nextCursor: String(page.next_cursor) } : {}) };
    },
    async createPage(bindingId, input) {
      declaredBinding(bindingId, "pages.create");
      const properties = propertiesOf(input);
      await requireDeliveryRunning();
      const row = await bound(bindingId, "pages.create");
      const page = await send("pages.create", "insert", { path: "/pages", method: "POST", body: { parent: { type: "data_source_id", data_source_id: row.dataSourceId }, properties }, creates: true });
      const id = formatNotionId(page.id);
      if (!id) throw new NotionError("Notion accepted the request, but did not return the new page. Check the database.", "notion_response", { providerStatus: 200, uncertain: true });
      remember(bindingId, id);
      return { id, url: validNotionUrl(page.url) ?? null, page: shared(page) };
    },
    async page(bindingId, pageId) {
      const row = await bound(bindingId, "pages.retrieve"); const id = pageIdOf(pageId);
      // The read is its own scope check: the page's parent arrives with it, and nothing is returned for another database's page.
      const page = await send("pages.retrieve", "read", { path: `/pages/${id}` });
      if (!inDataSource(page, row)) await refuseOutOfScope(bindingId, "pages.retrieve");
      remember(bindingId, id);
      return shared(page);
    },
    async updatePage(bindingId, pageId, input) {
      declaredBinding(bindingId, "pages.update");
      const id = pageIdOf(pageId); const properties = propertiesOf(input);
      await requireDeliveryRunning();
      const row = await bound(bindingId, "pages.update");
      await requirePageInScope(bindingId, row, id, "pages.update");
      return shared(await send("pages.update", "update", { path: `/pages/${id}`, method: "PATCH", body: { properties } }));
    },
    async trashPage(bindingId, pageId) {
      declaredBinding(bindingId, "pages.trash");
      const id = pageIdOf(pageId);
      await requireDeliveryRunning();
      const row = await bound(bindingId, "pages.trash");
      await requirePageInScope(bindingId, row, id, "pages.trash");
      await send("pages.trash", "update", { path: `/pages/${id}`, method: "PATCH", body: { in_trash: true } });
    },
    async createComment(bindingId, pageId, input) {
      declaredBinding(bindingId, "comments.create");
      const id = pageIdOf(pageId);
      const richText = isObject(input) ? input.richText : undefined;
      if (!Array.isArray(richText) || !richText.length || richText.length > 100 || new TextEncoder().encode(JSON.stringify(richText)).byteLength > maximumBodyBytes) throw new HttpError(400, "A Notion comment needs 1 to 100 rich text items");
      await requireDeliveryRunning();
      const row = await bound(bindingId, "comments.create");
      await requirePageInScope(bindingId, row, id, "comments.create");
      // Without a display name Notion shows "Unnamed Bot". The name is the one an Admin set for this module, else the
      // module's label; it was read with the bindings above.
      const name = (await load()).commentName?.trim() || (typeof caller.definition?.label === "string" ? caller.definition.label.trim().slice(0, notionCommentNameLength).trim() : "") || fallbackCommentName;
      const comment = await send("comments.create", "comment", { path: "/comments", method: "POST", body: { parent: { page_id: id }, rich_text: richText, display_name: { type: "custom", custom: { name } } }, creates: true });
      return { id: formatNotionId(comment.id) ?? null };
    },
    users: Object.freeze({
      async list(input = {}) {
        declaredUsers("list");
        const cursor = cursorOf(input?.cursor);
        const page = await send("users.list", "users", { path: `/users?page_size=${pageSizeOf(input?.pageSize)}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}` });
        if (!Array.isArray(page.results)) throw new NotionError("Notion returned an unreadable response.", "notion_response", { providerStatus: 200 });
        const state = await load(); await recordsFor(state).capability(state.capabilities, "email", emailSeen(page.results as NotionJson[]));
        return { users: (page.results as NotionJson[]).filter((user) => user?.id).map((user) => notionUser(user, withEmail)), ...(page.has_more && page.next_cursor ? { nextCursor: String(page.next_cursor) } : {}) };
      },
      async get(userId) {
        declaredUsers("retrieve");
        const id = formatNotionId(userId); if (!id) throw new HttpError(400, "A Notion user ID is required");
        const user = await send("users.retrieve", "users", { path: `/users/${id}` });
        const state = await load(); await recordsFor(state).capability(state.capabilities, "email", emailSeen([user]));
        return notionUser(user, withEmail);
      },
    }),
    providerStatus: (error) => error instanceof NotionError ? error.providerStatus : undefined,
    retryAfterMs: (error) => error instanceof NotionError ? error.retryAfterMs : undefined,
    uncertain: (error) => error instanceof NotionError && error.uncertain,
    errorCode: (error) => error instanceof NotionError ? error.code : undefined,
    async importLegacyConnection(input) {
      if (caller.moduleId !== notionLegacyImportModule) throw new HttpError(403, "Only Part Requests can import a Notion connection");
      const incomplete = () => new HttpError(400, "The Notion connection to import is incomplete");
      if (!isObject(input) || typeof input.ciphertext !== "string" || !input.ciphertext || input.ciphertext.length > 4000 || typeof input.iv !== "string" || !input.iv || input.iv.length > 200) throw incomplete();
      if (input.bindings !== undefined && !Array.isArray(input.bindings)) throw incomplete();
      const wanted = (input.bindings ?? []).map((item) => {
        const databaseId = formatNotionId(item?.databaseId), dataSourceId = formatNotionId(item?.dataSourceId);
        const id = typeof item?.id === "string" ? item.id : "";
        if (!declared?.bindings.some((binding) => binding.id === id) || !databaseId || !dataSourceId) throw incomplete();
        return { id, databaseId, dataSourceId, name: typeof item.name === "string" ? item.name.trim().slice(0, 200) : "" };
      });
      if (new Set(wanted.map((item) => item.id)).size !== wanted.length) throw incomplete();
      const token = await tokenOf(deps.credentials, input.ciphertext, input.iv);
      if (!token) return "unreadable";
      const state = await load();
      const at = deps.now(); const iso = new Date(at).toISOString();
      const bind = (item: (typeof wanted)[number]) => deps.db.prepare("INSERT INTO notion_bindings(installation_id,module_id,binding_id,database_id,data_source_id,name,revision,updated_at) VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(installation_id,module_id,binding_id) DO NOTHING")
        .bind(installationId, caller.moduleId, item.id, item.databaseId, item.dataSourceId, item.name, iso);
      let outcome: "imported" | "kept-existing" = "kept-existing"; let boundIds: string[] = [];
      // Core already has a connection: it is kept, and no database is chosen on the plugin's word. An Admin chooses them.
      if (!state.connection) {
        // Core has no connection: prove the plugin's token still works before it becomes everyone's.
        let me: NotionJson;
        try { me = await send("import.verify", undefined, { path: "/users/me" }, token); }
        catch (error) { if (error instanceof NotionError && error.providerStatus === 401) return "unreadable"; throw error; }
        // A database is kept only when Notion confirms the data source belongs to it; anything else is left unchosen.
        const confirmed: typeof wanted = [];
        for (const item of wanted) {
          let source: NotionJson;
          try { source = await send("import.retrieve", undefined, { path: `/data_sources/${item.dataSourceId}` }, token); }
          catch (error) { if (error instanceof NotionError && error.providerStatus !== undefined && error.providerStatus >= 400 && error.providerStatus < 500 && error.providerStatus !== 429) continue; throw error; }
          if (source.parent?.type === "database_id" && sameNotionId(source.parent.database_id, item.databaseId)) confirmed.push(item);
        }
        const encrypted = await deps.credentials.encrypt({ token });
        const inserted = await deps.db.prepare("INSERT INTO notion_connection(installation_id,ciphertext,iv,key_version,enabled,bot_name,workspace_name,checked_at,capabilities_json,paused_until_ms,revision,updated_at) VALUES(?,?,?,1,1,?,?,?,'{}',0,1,?) ON CONFLICT(installation_id) DO NOTHING")
          .bind(installationId, encrypted.ciphertext, encrypted.iv, String(me.name ?? "").slice(0, 200), String(me.bot?.workspace_name ?? "").slice(0, 200), iso, iso).run();
        if (inserted.meta?.changes === 1) {
          outcome = "imported";
          const results = confirmed.length ? await deps.db.batch(confirmed.map(bind)) : [];
          // Only rows this import wrote: a database an Admin had already chosen is left alone and not reported.
          boundIds = confirmed.filter((_, index) => results[index]?.meta?.changes === 1).map((item) => item.id);
        }
      }
      try { await auditStatement(deps.db, "integration.notion_imported", "notion", { moduleId: caller.moduleId, outcome, bindings: boundIds }, at).run(); }
      catch { /* The import stands whether or not it could be recorded. */ }
      loading = undefined;
      return outcome;
    },
  };
  return Object.freeze(service);
}

// Settings > Integrations > Notion. Each function is the body of one Admin route; the Worker checks the role and the
// dashboard origin, and writes the audit entry. The token never returns.

export type NotionBindingStatus = {
  readonly moduleId: string; readonly moduleLabel: string; readonly id: string; readonly label: string; readonly reason: string; readonly required: boolean;
  readonly operations: readonly ModuleNotionOperation[]; readonly bound: boolean; readonly databaseId: string | null; readonly dataSourceId: string | null; readonly name: string; readonly link: string | null;
};
export type NotionIntegrationStatus = {
  readonly saved: boolean; readonly enabled: boolean; readonly readable: boolean; readonly encryption: boolean;
  readonly botName: string; readonly workspaceName: string; readonly checkedAt: string | null; readonly pausedUntil: string | null;
  readonly capabilities: NotionCapabilities; readonly revision: number; readonly bindings: readonly NotionBindingStatus[];
};
type NotionModules = readonly Pick<ModuleDefinition, "id" | "label" | "available" | "notion">[];

/** `GET /admin/integrations/notion`: the connection without its token, and every binding installed modules declared. */
export async function notionIntegrationStatus(deps: NotionDeps, modules: NotionModules): Promise<NotionIntegrationStatus> {
  const [connections, bindings] = await deps.db.batch([deps.db.prepare(connectionSelect).bind(installationId), deps.db.prepare(bindingSelect).bind(installationId)]);
  const connection = rowsOf<ConnectionRow>(connections)[0];
  const rows = new Map(rowsOf<BindingRow>(bindings).map((row) => [`${row.moduleId}:${row.bindingId}`, row]));
  const paused = Number(connection?.pausedUntilMs ?? 0);
  return {
    saved: Boolean(connection), enabled: connection?.enabled === 1, readable: connection ? Boolean(await tokenOf(deps.credentials, connection.ciphertext, connection.iv)) : false, encryption: deps.credentials.available,
    botName: connection?.botName ?? "", workspaceName: connection?.workspaceName ?? "", checkedAt: connection?.checkedAt ?? null, pausedUntil: paused > deps.now() ? new Date(paused).toISOString() : null,
    capabilities: connection ? parseNotionCapabilities(connection.capabilitiesJson) : unknownCapabilities, revision: connection?.revision ?? 0,
    bindings: modules.filter((module) => module.available).flatMap((module) => (module.notion?.bindings ?? []).map((binding): NotionBindingStatus => {
      const row = rows.get(`${module.id}:${binding.id}`);
      return { moduleId: module.id, moduleLabel: module.label, id: binding.id, label: binding.label, reason: binding.reason, required: binding.required, operations: [...binding.operations], bound: Boolean(row), databaseId: row?.databaseId ?? null, dataSourceId: row?.dataSourceId ?? null, name: row?.name ?? "", link: row ? notionLink(row.databaseId) : null };
    })),
  };
}

/**
 * One Admin request with the given token: uncounted, but a rate limit still holds every module's calls. `ciphertext`
 * is the saved row the token came from, or undefined for a token that is not saved yet.
 */
async function adminRequest(deps: NotionDeps, token: string, ciphertext: string | undefined, operation: string, request: NotionRequest): Promise<NotionJson> {
  const log = (status: number | string) => { try { deps.log?.({ module: "core", operation, status }); } catch { /* Logging never fails a call. */ } };
  try { const body = await notionRequest(deps.fetch, token, request); log(200); return body; }
  catch (error) {
    if (error instanceof NotionError) {
      log(error.providerStatus ?? error.code);
      if (error.providerStatus === 429) await connectionRecords(deps, ciphertext).pause(deps.now() + (error.retryAfterMs ?? notionDefaultRetryAfterMs));
    }
    throw error;
  }
}

/**
 * What a token check learns: who the token is (`/users/me`, which also proves the token) and whether it may read users
 * (`/users?page_size=1`). Content capabilities have no endpoint; real calls record them. Throws 400 for a refused token
 * and 502 when Notion did not answer.
 */
async function checkToken(deps: NotionDeps, token: string, ciphertext: string | undefined, refusedMessage: string): Promise<{ botName: string; workspaceName: string; capabilities: Partial<Record<NotionCapability, "ok" | "refused">> }> {
  let me: NotionJson;
  try { me = await adminRequest(deps, token, ciphertext, "check.me", { path: "/users/me" }); }
  catch (error) {
    if (error instanceof NotionError && error.providerStatus === 401) throw new HttpError(400, refusedMessage);
    if (error instanceof NotionError) throw new HttpError(error.providerStatus === 429 ? 429 : 502, error.providerStatus === 429 ? "Notion is rate limiting requests, so the token was not checked. Try again in a minute." : "Notion did not answer the check, so nothing was saved. Try again in a few minutes.");
    throw error;
  }
  const capabilities: Partial<Record<NotionCapability, "ok" | "refused">> = {};
  try {
    const users = await adminRequest(deps, token, ciphertext, "check.users", { path: "/users?page_size=1" });
    capabilities.users = "ok";
    const email = Array.isArray(users.results) ? emailSeen(users.results as NotionJson[]) : undefined;
    if (email) capabilities.email = email;
  } catch (error) {
    if (!(error instanceof NotionError)) throw error;
    // Only a 403 says the capability is missing; anything else leaves it unknown and does not stop the save.
    if (error.providerStatus === 403) capabilities.users = "refused";
  }
  return { botName: String(me.name ?? "").trim().slice(0, 200), workspaceName: String(me.bot?.workspace_name ?? "").trim().slice(0, 200), capabilities };
}

export type NotionConnectionChange = "saved" | "checked" | "enabled" | "disabled";

/**
 * `PUT /admin/integrations/notion`. `{ token }` checks the token with Notion and saves it encrypted; `{ enabled }` turns
 * the saved connection on or off without touching the token; and `{ check: true }` checks the saved token again and
 * refreshes what is known about it. A new connection starts turned on. Saving a token over an existing one keeps the
 * switch as it is in the database at that moment unless the request sends `enabled`, so a save never undoes someone
 * turning the connection off.
 *
 * Every form carries `revision`, the one the Admin's page loaded (0 when nothing is saved). A change made since then
 * answers 409 and nothing is written; the page reloads and the Admin decides again. Bookkeeping from module traffic
 * (capabilities, the rate-limit pause) does not move the revision.
 */
export async function saveNotionConnection(deps: NotionDeps, value: unknown): Promise<NotionConnectionChange> {
  if (!isObject(value)) throw new HttpError(400, "Request body must be an object");
  if (Object.keys(value).some((key) => !["token", "enabled", "check", "revision"].includes(key))) throw new HttpError(400, "Send only token, enabled, check and revision");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
  if (value.check !== undefined && value.check !== true) throw new HttpError(400, "check must be true");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new HttpError(400, "Send the revision this page loaded");
  const revision = Number(value.revision);
  const changed = () => new HttpError(409, "The Notion connection changed since this page loaded. Review it and try again.", undefined, "notion_connection_changed");
  const written = (result: { meta?: { changes?: number } }) => { if (result.meta?.changes !== 1) throw changed(); };
  const now = deps.now(); const at = new Date(now).toISOString();
  const existing = await deps.db.prepare(connectionSelect).bind(installationId).first<ConnectionRow>();
  if (value.token !== undefined) {
    const token = typeof value.token === "string" ? value.token.trim() : "";
    if (token.length < 10 || token.length > 500 || /[^\x21-\x7e]/.test(token)) throw new HttpError(400, "Enter the Notion integration token");
    if (value.check !== undefined) throw new HttpError(400, "Send a token or check, not both");
    if (!deps.credentials.available) throw new HttpError(503, "Integration encryption is not configured");
    if ((existing?.revision ?? 0) !== revision) throw changed();
    const checked = await checkToken(deps, token, undefined, "Notion did not accept this token. Check it and save again.");
    const encrypted = await deps.credentials.encrypt({ token });
    const explicit = value.enabled === undefined ? 0 : 1;
    // A first save writes revision 1, so a second first save racing it finds a row it did not load and is refused. A new
    // token starts with nothing known beyond what the check just showed, and with no pause carried over.
    if (!existing) {
      written(await deps.db.prepare("INSERT INTO notion_connection(installation_id,ciphertext,iv,key_version,enabled,bot_name,workspace_name,checked_at,capabilities_json,paused_until_ms,revision,updated_at) VALUES(?,?,?,1,?,?,?,?,?,0,1,?) ON CONFLICT(installation_id) DO NOTHING")
        .bind(installationId, encrypted.ciphertext, encrypted.iv, value.enabled === false ? 0 : 1, checked.botName, checked.workspaceName, at, JSON.stringify(checked.capabilities), at).run());
    } else {
      written(await deps.db.prepare(`UPDATE notion_connection SET ciphertext=?,iv=?,key_version=key_version+1,enabled=CASE WHEN ?=1 THEN ? ELSE enabled END,bot_name=?,workspace_name=?,checked_at=?,capabilities_json=?,paused_until_ms=0,revision=revision+1,updated_at=?
        WHERE installation_id=? AND revision=?`)
        .bind(encrypted.ciphertext, encrypted.iv, explicit, value.enabled ? 1 : 0, checked.botName, checked.workspaceName, at, JSON.stringify(checked.capabilities), at, installationId, revision).run());
    }
    return "saved";
  }
  if (!existing) throw new HttpError(400, "Save a Notion token first");
  if (existing.revision !== revision) throw changed();
  if (value.check) {
    if (value.enabled !== undefined) throw new HttpError(400, "Send enabled or check, not both");
    const token = await tokenOf(deps.credentials, existing.ciphertext, existing.iv);
    if (!token) throw new HttpError(400, "The saved Notion token can't be read. Save it again.");
    const checked = await checkToken(deps, token, existing.ciphertext, "Notion no longer accepts the saved token. Save a new one.");
    // Only the capabilities the check tested are set, in place, so what module traffic recorded meanwhile is kept.
    const tested = Object.entries(checked.capabilities);
    const capabilities = tested.length ? `json_set(capabilities_json${tested.map(([capability]) => `,'$.${capability}',?`).join("")})` : "capabilities_json";
    written(await deps.db.prepare(`UPDATE notion_connection SET bot_name=?,workspace_name=?,checked_at=?,capabilities_json=${capabilities},revision=revision+1,updated_at=? WHERE installation_id=? AND revision=?`)
      .bind(checked.botName, checked.workspaceName, at, ...tested.map(([, state]) => state), at, installationId, revision).run());
    return "checked";
  }
  if (value.enabled === undefined) throw new HttpError(400, "Send token, enabled or check");
  written(await deps.db.prepare("UPDATE notion_connection SET enabled=?,revision=revision+1,updated_at=? WHERE installation_id=? AND revision=?").bind(value.enabled ? 1 : 0, at, installationId, revision).run());
  return value.enabled ? "enabled" : "disabled";
}

/** `DELETE /admin/integrations/notion`: forget the token. Bindings stay, so a new token picks up where the old one stopped. */
export async function removeNotionConnection(deps: NotionDeps): Promise<void> {
  await deps.db.prepare("DELETE FROM notion_connection WHERE installation_id=?").bind(installationId).run();
}

export type NotionBindingResult = { readonly bound: true } | { readonly bound: false; readonly dataSources: readonly { readonly id: string; readonly name: string }[] };

/**
 * `PUT /admin/integrations/notion/bindings/{moduleId}/{bindingId}` with `{ database, dataSourceId? }`: choose the Notion
 * database for a binding a module declared. `database` is a Notion link or ID. Core reads the database (which the
 * connection must have been added to) and its data source, so a saved binding is one the token can read. A database with
 * several data sources answers with the list until `dataSourceId` names one.
 */
export async function setNotionBinding(deps: NotionDeps, modules: NotionModules, moduleId: string, bindingId: string, value: unknown): Promise<NotionBindingResult> {
  const module = modules.find((item) => item.id === moduleId && item.available);
  const binding = module?.notion?.bindings.find((item) => item.id === bindingId);
  if (!binding) throw new HttpError(404, "That module did not declare this Notion database");
  if (!isObject(value) || Object.keys(value).some((key) => key !== "database" && key !== "dataSourceId")) throw new HttpError(400, "Send only database and dataSourceId");
  const parsed = parseNotionId(value.database);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  const wantedSource = value.dataSourceId === undefined ? undefined : formatNotionId(value.dataSourceId);
  if (value.dataSourceId !== undefined && !wantedSource) throw new HttpError(400, "Choose one of the database's data sources");
  const connection = await deps.db.prepare(connectionSelect).bind(installationId).first<ConnectionRow>();
  if (!connection) throw new HttpError(409, "Connect Notion before choosing a database");
  if (connection.enabled !== 1) throw new HttpError(409, "Turn the Notion connection on before choosing a database");
  const token = await tokenOf(deps.credentials, connection.ciphertext, connection.iv);
  if (!token) throw new HttpError(409, "The saved Notion token can't be read. Save it again before choosing a database.");
  const known = { ...parseNotionCapabilities(connection.capabilitiesJson) };
  const read = async (operation: string, path: string) => {
    try { const body = await adminRequest(deps, token, connection.ciphertext, operation, { path }); await connectionRecords(deps, connection.ciphertext).capability(known, "read", "ok"); return body; }
    catch (error) {
      if (!(error instanceof NotionError)) throw error;
      if (error.providerStatus === 403) await connectionRecords(deps, connection.ciphertext).capability(known, "read", "refused");
      // The client's messages are fixed text an Admin can act on; 4xx answers are about this database or the connection.
      throw new HttpError(error.providerStatus === 429 ? 429 : error.providerStatus !== undefined && error.providerStatus >= 400 && error.providerStatus < 500 ? 400 : 502, error.message);
    }
  };
  const database = await read("bind.database", `/databases/${parsed.id}`);
  const dataSources = (Array.isArray(database.data_sources) ? database.data_sources as NotionJson[] : []).flatMap((source) => { const id = formatNotionId(source?.id); return id ? [{ id, name: String(source?.name ?? "").trim().slice(0, 200) }] : []; });
  if (!dataSources.length) throw new HttpError(400, "No data source was found. Use the original database's link, not a page containing a linked view.");
  const selected = wantedSource ? dataSources.find((source) => source.id === wantedSource) : dataSources.length === 1 ? dataSources[0] : undefined;
  if (wantedSource && !selected) throw new HttpError(400, "Choose one of the database's data sources");
  if (!selected) return { bound: false, dataSources };
  const source = await read("bind.data_source", `/data_sources/${selected.id}`);
  const name = (selected.name || plainTitle(source.title)).trim().slice(0, 200);
  const at = new Date(deps.now()).toISOString();
  await deps.db.prepare(`INSERT INTO notion_bindings(installation_id,module_id,binding_id,database_id,data_source_id,name,revision,updated_at) VALUES(?,?,?,?,?,?,0,?)
    ON CONFLICT(installation_id,module_id,binding_id) DO UPDATE SET database_id=excluded.database_id,data_source_id=excluded.data_source_id,name=excluded.name,revision=notion_bindings.revision+1,updated_at=excluded.updated_at`)
    .bind(installationId, moduleId, bindingId, parsed.id, selected.id, name, at).run();
  return { bound: true };
}

/** `DELETE /admin/integrations/notion/bindings/{moduleId}/{bindingId}`: the module loses that database until one is chosen again. */
export async function removeNotionBinding(deps: NotionDeps, moduleId: string, bindingId: string): Promise<boolean> {
  if (!moduleIdPattern.test(moduleId) || moduleId.length > 64 || !bindingIdPattern.test(bindingId) || bindingId.length > 40) throw new HttpError(404, "That module did not declare this Notion database");
  const result = await deps.db.prepare("DELETE FROM notion_bindings WHERE installation_id=? AND module_id=? AND binding_id=?").bind(installationId, moduleId, bindingId).run();
  return result.meta?.changes === 1;
}

// The name Notion shows on a module's comments, set on that module's settings page (the SDK's NotionCommentNameField).
// It belongs to the module, not to the connection: removing the token or a chosen database keeps it, as the module's
// settings page still shows it; deleting the module's data removes it (module-cleanup.ts).

export type NotionCommentNameStatus = {
  readonly moduleId: string;
  /** The module's label: the name its comments carry while `name` is empty. */
  readonly label: string;
  /** The name an Admin set, or "" when there is none. */
  readonly name: string;
};
function commentingModule(modules: NotionModules, moduleId: string) {
  const module = modules.find((item) => item.id === moduleId && item.available);
  if (!module || !commentsDeclared(module.notion)) throw new HttpError(404, "This module does not comment in Notion");
  return module;
}

/** `GET /admin/modules/{moduleId}/notion-comment-name`, for a module that declared `comments.create`: one query. */
export async function notionCommentName(deps: NotionDeps, modules: NotionModules, moduleId: string): Promise<NotionCommentNameStatus> {
  const module = commentingModule(modules, moduleId);
  const row = await deps.db.prepare(commentNameSelect).bind(installationId, moduleId).first<{ name: string }>();
  return { moduleId, label: module.label, name: row?.name ?? "" };
}

/**
 * `PUT /admin/modules/{moduleId}/notion-comment-name` with `{ name }`: the name Notion shows on that module's comments,
 * trimmed, one line, at most 100 characters. An empty name removes it, and the module's label is used again. Nothing
 * is sent to Notion and the token is not needed. `unchanged` means the stored name was already that.
 */
export async function setNotionCommentName(deps: NotionDeps, modules: NotionModules, moduleId: string, value: unknown): Promise<"set" | "cleared" | "unchanged"> {
  commentingModule(modules, moduleId);
  if (!isObject(value) || Object.keys(value).some((key) => key !== "name")) throw new HttpError(400, "Send only name");
  if (typeof value.name !== "string") throw new HttpError(400, "The name shown on comments must be text");
  const name = value.name.trim();
  if (name.length > notionCommentNameLength) throw new HttpError(400, `The name shown on comments can be at most ${notionCommentNameLength} characters`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, "The name shown on comments must be one line of text");
  if (!name) {
    const removed = await deps.db.prepare("DELETE FROM notion_comment_names WHERE installation_id=? AND module_id=?").bind(installationId, moduleId).run();
    return removed.meta?.changes === 1 ? "cleared" : "unchanged";
  }
  const written = await deps.db.prepare(`INSERT INTO notion_comment_names(installation_id,module_id,name,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(installation_id,module_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at WHERE notion_comment_names.name<>excluded.name`)
    .bind(installationId, moduleId, name, new Date(deps.now()).toISOString()).run();
  return written.meta?.changes === 1 ? "set" : "unchanged";
}
