import { preserveDatabaseIdentity, type D1Database, type D1Result, type D1Statement } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

type Predicate = { sql: string; bindings: readonly unknown[] };
const denialMarker = "module-authority-denied";

function requireGeneration(generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation >= Number.MAX_SAFE_INTEGER) throw new HttpError(409, "Module generation is invalid");
}

/**
 * Recheck captured module authority in the same D1 transaction as every read or
 * write. The deliberately invalid JSON path aborts the batch only when the
 * predicate is false, including when authority changes during a long request.
 */
function scopedDatabase(db: D1Database, predicate: Predicate): D1Database {
  const statements = new WeakMap<D1Statement, D1Statement>();
  const guard = () => db.prepare(`SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE json_extract('{}','${denialMarker}') END AS module_authority`).bind(...predicate.bindings);
  async function execute(input: D1Statement[]): Promise<D1Result[]> {
    const originals = input.map((statement) => {
      const original = statements.get(statement);
      if (!original) throw new HttpError(500, "Database statement does not belong to the captured module request");
      return original;
    });
    try {
      const results = await db.batch([guard(), ...originals, guard()]);
      return results.slice(1, -1);
    } catch (error) {
      if (error instanceof Error && error.message.includes(denialMarker)) throw new HttpError(403, "Module authority changed; reload current state");
      throw error;
    }
  }
  function wrap(original: D1Statement): D1Statement {
    const statement: D1Statement = {
      bind: (...values) => wrap(original.bind(...values)),
      async first<T>() { return ((await execute([statement]))[0]?.results?.[0] as T | undefined) ?? null; },
      async all<T>() { return (await execute([statement]))[0] as D1Result<T>; },
      async run() { return (await execute([statement]))[0] as D1Result; },
    };
    statements.set(statement, original);
    return Object.freeze(statement);
  }
  return preserveDatabaseIdentity(Object.freeze({ prepare: (query: string) => wrap(db.prepare(query)), batch: execute }), db);
}

function moduleStatePredicate(moduleId: string, generation: number, requireSetup: boolean): Predicate {
  requireGeneration(generation);
  return {
    sql: `EXISTS(SELECT 1 FROM platform_modules m
      JOIN platform_module_epochs me ON me.installation_id=m.installation_id AND me.module_id=m.module_id AND me.generation=m.generation
      JOIN platform_module_administration a ON a.installation_id=m.installation_id AND a.selection_completed=1
      JOIN platform_module_administration_epochs ae ON ae.installation_id=a.installation_id AND ae.revision=a.revision
      WHERE m.installation_id='primary' AND m.module_id=? AND m.generation=? AND m.phase='enabled'${requireSetup ? " AND m.setup_complete=1" : ""})`,
    bindings: [moduleId, generation],
  };
}

export function captureModuleServiceDatabase(db: D1Database, moduleId: string, generation: number) {
  return scopedDatabase(db, moduleStatePredicate(moduleId, generation, true));
}

export function captureModuleSetupDatabase(db: D1Database, moduleId: string, generation: number, userId: string) {
  const state = moduleStatePredicate(moduleId, generation, false);
  return scopedDatabase(db, {
    sql: `${state.sql} AND EXISTS(SELECT 1 FROM users u WHERE u.installation_id='primary' AND u.id=? AND u.active=1 AND u.role='admin')`,
    bindings: [...state.bindings, userId],
  });
}

/** The authority one interface call runs under: an Admin's standing grant to the consumer, or the signed-in user. */
export type ModuleInterfaceAuthority =
  | { readonly grantId: string; readonly operation: string }
  | { readonly userId: string; readonly capability: string };

/**
 * The provider's database for one interface call, composed over the consumer's captured database so both guards run.
 * Every batch also rechecks the provider's and consumer's lifecycle at their captured generations and the call's
 * authority, so disabling either module or revoking the grant stops the next statement of a running call.
 */
export function captureModuleInterfaceDatabase(db: D1Database, call: {
  readonly provider: { readonly moduleId: string; readonly generation: number };
  readonly consumer: { readonly moduleId: string; readonly generation: number };
  readonly interfaceId: string;
  readonly version: number;
  readonly authority: ModuleInterfaceAuthority;
}) {
  const provider = moduleStatePredicate(call.provider.moduleId, call.provider.generation, true);
  requireGeneration(call.consumer.generation);
  const consumer = `EXISTS(SELECT 1 FROM platform_modules c JOIN platform_module_epochs ce ON ce.installation_id=c.installation_id AND ce.module_id=c.module_id AND ce.generation=c.generation
    WHERE c.installation_id='primary' AND c.module_id=? AND c.generation=? AND c.phase='enabled')`;
  const authority = "grantId" in call.authority
    ? { sql: `EXISTS(SELECT 1 FROM platform_module_interface_grants g, json_each(g.operations_json) o WHERE g.installation_id='primary' AND g.id=?
        AND g.consumer_module_id=? AND g.provider_module_id=? AND g.interface_id=? AND g.interface_version=? AND g.revoked_at IS NULL AND o.type='text' AND o.value=?)`,
      bindings: [call.authority.grantId, call.consumer.moduleId, call.provider.moduleId, call.interfaceId, call.version, call.authority.operation] }
    : { sql: `EXISTS(SELECT 1 FROM users u WHERE u.installation_id='primary' AND u.id=? AND u.active=1
        AND (u.role='admin' OR (u.role='operator' AND EXISTS(SELECT 1 FROM platform_module_assignments g
          JOIN platform_module_assignment_revisions r ON r.installation_id=g.installation_id AND r.user_id=g.user_id
          JOIN platform_module_assignment_epochs e ON e.installation_id=r.installation_id AND e.user_id=r.user_id AND e.revision=r.revision,
          json_each(g.capabilities_json) c WHERE g.installation_id=u.installation_id AND g.user_id=u.id AND g.module_id=?
          AND c.type='text' AND c.value=?))))`,
      bindings: [call.authority.userId, call.provider.moduleId, call.authority.capability] };
  return scopedDatabase(db, {
    sql: `${provider.sql} AND ${consumer} AND ${authority.sql}`,
    bindings: [...provider.bindings, call.consumer.moduleId, call.consumer.generation, ...authority.bindings],
  });
}

export function captureModuleWorkspaceDatabase(db: D1Database, moduleId: string, generation: number, userId: string, capability: string) {
  const state = moduleStatePredicate(moduleId, generation, true);
  return scopedDatabase(db, {
    sql: `${state.sql} AND EXISTS(SELECT 1 FROM users u WHERE u.installation_id='primary' AND u.id=? AND u.active=1
      AND (u.role='admin' OR (u.role='operator' AND EXISTS(SELECT 1 FROM platform_module_assignments g
        JOIN platform_module_assignment_revisions r ON r.installation_id=g.installation_id AND r.user_id=g.user_id
        JOIN platform_module_assignment_epochs e ON e.installation_id=r.installation_id AND e.user_id=r.user_id AND e.revision=r.revision,
        json_each(g.capabilities_json) c WHERE g.installation_id=u.installation_id AND g.user_id=u.id AND g.module_id=?
        AND c.type='text' AND c.value=?))))`,
    bindings: [...state.bindings, userId, moduleId, capability],
  });
}
