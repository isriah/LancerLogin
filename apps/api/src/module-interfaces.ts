/**
 * Worker calls between modules. A consumer declares `uses` and calls `services.modules.interface(id, version)`; a provider
 * declares `interfaces` and implements one handler per operation. Each call runs under one authority, an Admin's standing
 * grant to the consumer or the signed-in user's own access to the provider, in the provider's scoped database, where the
 * authority and both modules' lifecycle are rechecked in the same batch as every statement.
 */
import { bundledModuleRegistry, type ModuleDefinition, type ModuleInterfaceDefinition, type ModuleInterfaceUse } from "../../../packages/shared/src/module-platform.ts";
import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { captureModuleInterfaceDatabase, type ModuleInterfaceAuthority } from "./module-database-scope.ts";
import type { CoreModuleServices, ModuleInterfaceCaller, ModuleInterfaceClient, ModuleInterfaceHandler } from "./module-contributions.ts";

/** Largest JSON input or result of one call, in UTF-8 bytes. */
export const moduleInterfaceJsonLimit = 65_536;
type Registry = Pick<typeof bundledModuleRegistry, "modules" | "get" | "interfaceOwner">;
type InterfaceHandlers = (moduleId: string) => Readonly<Record<string, Readonly<Record<string, ModuleInterfaceHandler>>>> | undefined;
type CallState = { providerGeneration: number | null; consumerGeneration: number | null; grantId: string | null; grantOperations: string | null; role: string | null; capabilities: string | null };

function plainJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || Object.getOwnPropertySymbols(value).length) return false;
  if (Array.isArray(value)) return value.every((item) => plainJson(item, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every((item) => plainJson(item, depth + 1));
}

/** Serialize a call's input or result: plain JSON values only (no undefined, functions, dates or class instances), bounded. */
export function moduleInterfaceJson(value: unknown, limit = moduleInterfaceJsonLimit): string | undefined {
  const normalized = value === undefined ? null : value;
  if (!plainJson(normalized)) return undefined;
  const text = JSON.stringify(normalized);
  return new TextEncoder().encode(text).byteLength <= limit ? text : undefined;
}

const stringList = (json: string | null) => {
  try { const value = json ? JSON.parse(json) as unknown : []; return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
};

function readCallState(db: D1Database, consumerId: string, providerId: string, use: ModuleInterfaceUse, userId: string | undefined) {
  return db.prepare(`SELECT
    (SELECT p.generation FROM platform_modules p JOIN platform_module_epochs pe ON pe.installation_id=p.installation_id AND pe.module_id=p.module_id AND pe.generation=p.generation
      JOIN platform_module_administration a ON a.installation_id=p.installation_id AND a.selection_completed=1
      JOIN platform_module_administration_epochs ae ON ae.installation_id=a.installation_id AND ae.revision=a.revision
      WHERE p.installation_id='primary' AND p.module_id=?1 AND p.phase='enabled' AND p.setup_complete=1) AS providerGeneration,
    (SELECT c.generation FROM platform_modules c JOIN platform_module_epochs ce ON ce.installation_id=c.installation_id AND ce.module_id=c.module_id AND ce.generation=c.generation
      WHERE c.installation_id='primary' AND c.module_id=?2 AND c.phase='enabled') AS consumerGeneration,
    (SELECT g.id FROM platform_module_interface_grants g WHERE g.installation_id='primary' AND g.consumer_module_id=?2 AND g.provider_module_id=?1
      AND g.interface_id=?3 AND g.interface_version=?4 AND g.revoked_at IS NULL) AS grantId,
    (SELECT g.operations_json FROM platform_module_interface_grants g WHERE g.installation_id='primary' AND g.consumer_module_id=?2 AND g.provider_module_id=?1
      AND g.interface_id=?3 AND g.interface_version=?4 AND g.revoked_at IS NULL) AS grantOperations,
    (SELECT u.role FROM users u WHERE u.installation_id='primary' AND u.id=?5 AND u.active=1) AS role,
    (SELECT g.capabilities_json FROM platform_module_assignments g
      JOIN platform_module_assignment_revisions r ON r.installation_id=g.installation_id AND r.user_id=g.user_id
      JOIN platform_module_assignment_epochs e ON e.installation_id=r.installation_id AND e.user_id=r.user_id AND e.revision=r.revision
      WHERE g.installation_id='primary' AND g.user_id=?5 AND g.module_id=?1) AS capabilities`)
    .bind(providerId, consumerId, use.interface, use.version, userId ?? null).first<CallState>();
}

/** Grant first, then the signed-in user: an Admin, or an Operator assigned the operation's capability on the provider. */
function authorityFor(state: CallState, definition: ModuleInterfaceDefinition, operationId: string, userId: string | undefined): ModuleInterfaceAuthority | undefined {
  const operation = definition.operations.find((item) => item.id === operationId);
  if (!operation) return undefined;
  if (state.grantId && operation.grantable && stringList(state.grantOperations).includes(operationId)) return { grantId: state.grantId, operation: operationId };
  if (userId && (state.role === "admin" || state.role === "operator" && stringList(state.capabilities).includes(operation.capability))) return { userId, capability: operation.capability };
  return undefined;
}

export type ModuleInterfaceServiceOptions = {
  /** The consumer's captured database: its own guard keeps running under every provider statement. */
  readonly db: D1Database;
  readonly consumerId: string;
  /** The signed-in user of a workspace or setup request. Jobs and public requests have none. */
  readonly userId?: string;
  /** Calls made from inside an interface handler; they never chain into further interfaces. */
  readonly nested?: boolean;
  /** The provider's Core services over its call database. */
  readonly providerServices: (db: D1Database, providerId: string) => CoreModuleServices;
  readonly handlers: InterfaceHandlers;
  readonly registry?: Registry;
};

/** `services.modules` for one module request or job. */
export function moduleInterfaceServices(options: ModuleInterfaceServiceOptions): CoreModuleServices["modules"] {
  const registry = options.registry ?? bundledModuleRegistry;
  async function call(consumer: ModuleDefinition, use: ModuleInterfaceUse, provider: ModuleDefinition, definition: ModuleInterfaceDefinition, operationId: string, input: unknown) {
    const operation = definition.operations.find((item) => item.id === operationId);
    if (typeof operationId !== "string" || !use.operations.includes(operationId) || !operation) throw new HttpError(403, `${consumer.label} did not declare that operation of ${definition.label}`);
    const handler = options.handlers(provider.id)?.[definition.id]?.[operationId];
    if (!handler) throw new HttpError(409, `${provider.label} is unavailable`);
    const serialized = moduleInterfaceJson(input);
    if (serialized === undefined) throw new HttpError(400, `Input to ${definition.label} must be plain JSON of at most 64 KB`);
    const state = await readCallState(options.db, consumer.id, provider.id, use, options.userId);
    if (!state || state.providerGeneration === null || state.consumerGeneration === null) throw new HttpError(409, `${provider.label} is unavailable`);
    const authority = authorityFor(state, definition, operationId, options.userId);
    if (!authority) throw new HttpError(403, `${consumer.label} has no access to ${operation.label}`);
    const db = captureModuleInterfaceDatabase(options.db, { provider: { moduleId: provider.id, generation: state.providerGeneration }, consumer: { moduleId: consumer.id, generation: state.consumerGeneration }, interfaceId: definition.id, version: definition.version, authority });
    const caller: ModuleInterfaceCaller = Object.freeze("grantId" in authority ? { moduleId: consumer.id, grantId: authority.grantId } : { moduleId: consumer.id, userId: authority.userId });
    // Recorded inside the guarded batch, so a call whose authority is already gone is refused before the handler runs.
    await db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      VALUES (?,'primary',?,'module.interface_called','module_interface',?,?,?)`)
      .bind(crypto.randomUUID(), "userId" in authority ? authority.userId : null, definition.id, JSON.stringify({ consumer: consumer.id, provider: provider.id, interface: definition.id, version: definition.version, operation: operationId, ...("grantId" in authority ? { grantId: authority.grantId } : { userId: authority.userId }) }), new Date().toISOString()).run();
    let result: unknown;
    try { result = await handler(Object.freeze({ db, services: options.providerServices(db, provider.id), caller }), JSON.parse(serialized)); }
    catch (error) {
      // The caller receives the provider's own status and message; anything else stays in Worker logs.
      if (error instanceof HttpError) throw new HttpError(error.status >= 400 && error.status <= 599 ? error.status : 500, error.message, error.details, error.code);
      const errorId = crypto.randomUUID();
      console.error(JSON.stringify({ event: "module_interface_error", errorId, provider: provider.id, interface: definition.id, operation: operationId, message: error instanceof Error ? error.message : String(error) }));
      throw new HttpError(500, `${provider.label} could not complete the request (reference ${errorId})`);
    }
    const output = moduleInterfaceJson(result);
    if (output === undefined) throw new HttpError(502, `${provider.label} returned a result that is not plain JSON of at most 64 KB`);
    return JSON.parse(output) as unknown;
  }
  return Object.freeze({
    async interface(id: string, version: number): Promise<ModuleInterfaceClient | undefined> {
      if (options.nested) return undefined;
      const consumer = registry.get(options.consumerId);
      const use = consumer?.uses?.find((item) => item.interface === id && item.version === version);
      const owner = use ? registry.interfaceOwner(id) : undefined;
      // An optional use whose provider is absent, or lacks this version or a declared operation, is simply unavailable.
      if (!consumer || !use || !owner || owner.module.id === consumer.id || owner.definition.version !== version || use.operations.some((operation) => !owner.definition.operations.some((item) => item.id === operation)) || !options.handlers(owner.module.id)?.[id]) return undefined;
      const state = await readCallState(options.db, consumer.id, owner.module.id, use, options.userId);
      if (!state || state.providerGeneration === null || state.consumerGeneration === null || !use.operations.some((operation) => authorityFor(state, owner.definition, operation, options.userId))) return undefined;
      return Object.freeze({ call: (operation: string, input?: unknown) => call(consumer, use, owner.module, owner.definition, operation, input) });
    },
  });
}

type ProviderState = "missing" | "unsupported" | "disabled" | "setup-required" | "ready";
export type ModuleInterfaceUseStatus = {
  readonly consumer: { readonly id: string; readonly label: string; readonly phase: string | null };
  readonly provider: { readonly id: string; readonly label: string | null; readonly state: ProviderState };
  readonly interface: { readonly id: string; readonly version: number; readonly label: string | null };
  readonly required: boolean;
  readonly reason: string;
  readonly operations: readonly { readonly id: string; readonly label: string | null; readonly grantable: boolean }[];
  /** Operations an Admin can grant now: the declared ones the provider marks grantable. */
  readonly grantable: readonly string[];
  readonly grant: { readonly id: string; readonly operations: readonly string[]; readonly grantedAt: string; readonly grantedBy: string | null; readonly current: boolean } | null;
};

/** Every declared use of every installed module, with its provider's state and active grant. */
export async function readModuleInterfaceGrants(db: D1Database, registry: Registry = bundledModuleRegistry): Promise<{ uses: ModuleInterfaceUseStatus[] }> {
  const consumers = registry.modules.filter((module) => module.available && module.uses?.length);
  if (!consumers.length) return { uses: [] };
  const [phases, grants] = await Promise.all([
    db.prepare(`SELECT m.module_id AS moduleId,m.phase,m.setup_complete AS setupComplete,a.selection_completed AS selectionCompleted FROM platform_modules m
      LEFT JOIN platform_module_administration a ON a.installation_id=m.installation_id WHERE m.installation_id='primary'`).all<{ moduleId: string; phase: string; setupComplete: number; selectionCompleted: number | null }>(),
    db.prepare(`SELECT g.id,g.consumer_module_id AS consumerId,g.interface_id AS interfaceId,g.interface_version AS version,g.operations_json AS operationsJson,g.granted_at AS grantedAt,
      COALESCE(u.local_username,u.email) AS grantedBy FROM platform_module_interface_grants g LEFT JOIN users u ON u.installation_id=g.installation_id AND u.id=g.granted_by
      WHERE g.installation_id='primary' AND g.revoked_at IS NULL`).all<{ id: string; consumerId: string; interfaceId: string; version: number; operationsJson: string; grantedAt: string; grantedBy: string | null }>(),
  ]);
  const lifecycle = new Map((phases.results ?? []).map((row) => [row.moduleId, row]));
  return { uses: consumers.flatMap((consumer) => (consumer.uses ?? []).map((use): ModuleInterfaceUseStatus => {
    const owner = registry.interfaceOwner(use.interface);
    const providerId = owner?.module.id ?? use.interface.slice(0, use.interface.indexOf("."));
    const provider = registry.get(providerId);
    const supported = Boolean(owner && owner.definition.version === use.version && use.operations.every((operation) => owner.definition.operations.some((item) => item.id === operation)));
    const row = lifecycle.get(providerId);
    const state: ProviderState = !provider?.available ? "missing" : !supported ? "unsupported" : row?.phase !== "enabled" || row.selectionCompleted !== 1 ? "disabled" : row.setupComplete !== 1 ? "setup-required" : "ready";
    const operations = use.operations.map((id) => { const operation = supported ? owner!.definition.operations.find((item) => item.id === id) : undefined; return { id, label: operation?.label ?? null, grantable: operation?.grantable ?? false }; });
    const grantable = operations.filter((operation) => operation.grantable).map((operation) => operation.id);
    const active = (grants.results ?? []).find((grant) => grant.consumerId === consumer.id && grant.interfaceId === use.interface && grant.version === use.version);
    const granted = active ? stringList(active.operationsJson) : [];
    return {
      consumer: { id: consumer.id, label: consumer.label, phase: lifecycle.get(consumer.id)?.phase ?? null },
      provider: { id: providerId, label: provider?.label ?? null, state },
      interface: { id: use.interface, version: use.version, label: supported ? owner!.definition.label : null },
      required: use.required, reason: use.reason, operations, grantable,
      // A grant covers the operations declared when it was granted; one declared or made grantable since needs a new grant.
      grant: active ? { id: active.id, operations: granted, grantedAt: active.grantedAt, grantedBy: active.grantedBy, current: grantable.length > 0 && grantable.every((operation) => granted.includes(operation)) } : null,
    };
  })) };
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const adminActive = "EXISTS(SELECT 1 FROM users u WHERE u.installation_id='primary' AND u.id=? AND u.active=1 AND u.role='admin')";

/** Grant a consumer's declared, grantable operations of one interface version, replacing any earlier grant for it. */
export async function grantModuleInterface(db: D1Database, actorUserId: string, value: unknown, registry: Registry = bundledModuleRegistry) {
  if (!object(value) || Object.keys(value).some((key) => !["consumer", "interface", "version", "operations"].includes(key)) || typeof value.consumer !== "string" || typeof value.interface !== "string" || !Number.isSafeInteger(value.version) || !Array.isArray(value.operations) || value.operations.some((item) => typeof item !== "string")) throw new HttpError(400, "Provide the module, interface, version and the operations you reviewed");
  const consumer = registry.get(value.consumer);
  const use = consumer?.available ? consumer.uses?.find((item) => item.interface === value.interface && item.version === value.version) : undefined;
  if (!consumer || !use) throw new HttpError(404, "That module does not ask for this access");
  const owner = registry.interfaceOwner(use.interface);
  if (!owner || owner.definition.version !== use.version || use.operations.some((operation) => !owner.definition.operations.some((item) => item.id === operation))) throw new HttpError(409, "The module that provides this access is not installed at a compatible version");
  const grantable = use.operations.filter((operation) => owner.definition.operations.find((item) => item.id === operation)!.grantable);
  if (!grantable.length) throw new HttpError(400, "None of these operations can be granted. They need a signed-in user with access.");
  const reviewed = value.operations as string[];
  if (reviewed.length !== grantable.length || grantable.some((operation) => !reviewed.includes(operation))) throw new HttpError(409, "The access this module asks for changed. Review it again.", undefined, "grant_changed");
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE platform_module_interface_grants SET revoked_at=?,revoked_by=? WHERE installation_id='primary' AND consumer_module_id=? AND interface_id=? AND interface_version=? AND revoked_at IS NULL AND ${adminActive}`)
      .bind(now, actorUserId, consumer.id, use.interface, use.version, actorUserId),
    db.prepare(`INSERT INTO platform_module_interface_grants(installation_id,id,consumer_module_id,provider_module_id,interface_id,interface_version,operations_json,granted_by,granted_at)
      SELECT 'primary',?,?,?,?,?,?,?,? WHERE ${adminActive}`).bind(id, consumer.id, owner.module.id, use.interface, use.version, JSON.stringify(grantable), actorUserId, now, actorUserId),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,'primary',?,'module.interface_granted','module_interface_grant',?,?,? WHERE EXISTS(SELECT 1 FROM platform_module_interface_grants WHERE installation_id='primary' AND id=? AND revoked_at IS NULL)`)
      .bind(crypto.randomUUID(), actorUserId, id, JSON.stringify({ consumer: consumer.id, provider: owner.module.id, interface: use.interface, version: use.version, operations: grantable }), now, id),
  ]);
  if (results[1]?.meta?.changes !== 1 || results[2]?.meta?.changes !== 1) throw new HttpError(409, "Admin access changed; reload before granting");
  return readModuleInterfaceGrants(db, registry);
}

/** Revoke an active grant. The next statement of a call running under it is refused. */
export async function revokeModuleInterfaceGrant(db: D1Database, actorUserId: string, value: unknown, registry: Registry = bundledModuleRegistry) {
  if (!object(value) || Object.keys(value).some((key) => key !== "grantId") || typeof value.grantId !== "string" || !value.grantId || value.grantId.length > 64) throw new HttpError(400, "Provide the grant to revoke");
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE platform_module_interface_grants SET revoked_at=?,revoked_by=? WHERE installation_id='primary' AND id=? AND revoked_at IS NULL AND ${adminActive}`).bind(now, actorUserId, value.grantId, actorUserId),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,'primary',?,'module.interface_revoked','module_interface_grant',g.id,json_object('consumer',g.consumer_module_id,'provider',g.provider_module_id,'interface',g.interface_id,'version',g.interface_version,'operations',json(g.operations_json)),?
      FROM platform_module_interface_grants g WHERE g.installation_id='primary' AND g.id=? AND g.revoked_at=? AND g.revoked_by=?`).bind(crypto.randomUUID(), actorUserId, now, value.grantId, now, actorUserId),
  ]);
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) throw new HttpError(409, "That grant was already revoked, or Admin access changed. Reload and try again.", undefined, "grant_changed");
  return readModuleInterfaceGrants(db, registry);
}
