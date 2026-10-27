import type { D1Database, D1Statement } from "./d1-usage.ts";
import { installedApiModule, installedApiModules } from "./installed-api-modules.ts";
import { readRemovedModuleDefinitions } from "./module-catalog.ts";

type DueState = {
  installationId: string;
  moduleId: string;
  generation: number;
  phase: "retained" | "deleting";
  deletionCursor: number;
};

export type ModuleCleanupResult = { status: "idle" | "progress" | "deleted" | "blocked" | "retry-required" };

type DeleteStep = { kind: "delete"; table: string; where?: string; bindings?: readonly unknown[] };
type ResetStep = { kind: "reset"; table: string; pending: string; set: string; bindings: readonly unknown[] };
type AssignmentStep = { kind: "assignments" };
export type CleanupStep = DeleteStep | ResetStep | AssignmentStep;

type ModuleCleanup = { readonly steps: readonly CleanupStep[]; readonly blocker?: { readonly sql: string; readonly bindings: (installationId: string) => readonly unknown[]; readonly recordFailure?: boolean } };

/** Installed modules clean up with their own steps; removed modules use the definition recorded while installed. */
async function cleanupFor(db: D1Database, moduleId: string): Promise<ModuleCleanup> {
  const installed = installedApiModule(moduleId)?.cleanup; if (installed) return installed;
  const recorded = (await readRemovedModuleDefinitions(db, [moduleId])).get(moduleId);
  if (!recorded) throw new Error("Unknown module cleanup binding");
  return { steps: recorded.cleanup };
}

const safeName = /^[a-z][a-z0-9_]*$/;
const maximumAuthority = Number.MAX_SAFE_INTEGER;

function guard(state: DueState, token: string, cursor = state.deletionCursor) {
  return {
    sql: `EXISTS(SELECT 1 FROM platform_modules m
      JOIN platform_module_epochs e ON e.installation_id=m.installation_id AND e.module_id=m.module_id AND e.generation=m.generation
      JOIN platform_module_cleanup_leases l ON l.installation_id=m.installation_id AND l.module_id=m.module_id AND l.generation=m.generation
      JOIN platform_module_administration a ON a.installation_id=m.installation_id
      JOIN platform_module_administration_epochs ae ON ae.installation_id=a.installation_id AND ae.revision=a.revision
      WHERE m.installation_id=? AND m.module_id=? AND m.generation=? AND m.phase='deleting' AND m.deletion_cursor=?
      AND l.token=? AND julianday(l.expires_at)>julianday('now') AND julianday(m.delete_after)<=julianday('now'))`,
    bindings: [state.installationId, state.moduleId, state.generation, cursor, token],
  };
}

async function start(db: D1Database, state: DueState, cleanup: ModuleCleanup, token: string, now: Date) {
  const blocker = cleanup.blocker;
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  const lease = await db.prepare(`INSERT INTO platform_module_cleanup_leases(installation_id,module_id,generation,token,expires_at)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM platform_modules m
      JOIN platform_module_epochs e ON e.installation_id=m.installation_id AND e.module_id=m.module_id AND e.generation=m.generation
      JOIN platform_module_administration a ON a.installation_id=m.installation_id
      JOIN platform_module_administration_epochs ae ON ae.installation_id=a.installation_id AND ae.revision=a.revision
      WHERE m.installation_id=? AND m.module_id=? AND m.generation=? AND m.phase IN ('retained','deleting')
      AND julianday(m.delete_after)<=julianday(?) ${blocker ? `AND NOT (${blocker.sql})` : ""})
    ON CONFLICT(installation_id,module_id) DO UPDATE SET generation=excluded.generation,token=excluded.token,expires_at=excluded.expires_at
    WHERE julianday(platform_module_cleanup_leases.expires_at)<=julianday(?)`)
    .bind(state.installationId, state.moduleId, state.generation, token, expiresAt,
      state.installationId, state.moduleId, state.generation, now.toISOString(),
      ...(blocker?.bindings(state.installationId) ?? []), now.toISOString()).run();
  if (lease.meta?.changes !== 1) return false;
  if (state.phase === "retained") {
    const nextRevisionId = crypto.randomUUID();
    const results = await db.batch([
      db.prepare(`UPDATE platform_modules SET phase='deleting',cleanup_failure=NULL WHERE installation_id=? AND module_id=? AND generation=? AND phase='retained'
        AND EXISTS(SELECT 1 FROM platform_module_cleanup_leases WHERE installation_id=? AND module_id=? AND generation=? AND token=?)`)
        .bind(state.installationId, state.moduleId, state.generation, state.installationId, state.moduleId, state.generation, token),
      db.prepare(`UPDATE platform_module_administration SET revision=revision+1 WHERE installation_id=? AND revision<?
        AND EXISTS(SELECT 1 FROM platform_module_administration_epochs e WHERE e.installation_id=platform_module_administration.installation_id AND e.revision=platform_module_administration.revision)
        AND EXISTS(SELECT 1 FROM platform_modules WHERE installation_id=? AND module_id=? AND generation=? AND phase='deleting')`)
        .bind(state.installationId, maximumAuthority - 1, state.installationId, state.moduleId, state.generation),
      db.prepare(`UPDATE platform_module_administration_epochs SET revision=(SELECT revision FROM platform_module_administration WHERE installation_id=?)
        WHERE installation_id=? AND EXISTS(SELECT 1 FROM platform_module_administration a WHERE a.installation_id=? AND a.revision=platform_module_administration_epochs.revision+1)`)
        .bind(state.installationId, state.installationId, state.installationId),
      db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
        SELECT ?,?,NULL,'module.cleanup_started','platform_module',?,'{}',? WHERE EXISTS(SELECT 1 FROM platform_modules WHERE installation_id=? AND module_id=? AND generation=? AND phase='deleting')`)
        .bind(nextRevisionId, state.installationId, state.moduleId, now.toISOString(), state.installationId, state.moduleId, state.generation),
    ]);
    if (results.some((result) => result.meta?.changes !== 1)) return false;
  }
  return true;
}

function deleteStep(db: D1Database, state: DueState, token: string, step: DeleteStep, limit: number): D1Statement[] {
  if (!safeName.test(step.table)) throw new Error("Invalid cleanup table");
  const condition = `installation_id=?${step.where ? ` AND (${step.where})` : ""}`;
  const conditionBindings = [state.installationId, ...(step.bindings ?? [])];
  const current = guard(state, token);
  return [
    db.prepare(`DELETE FROM ${step.table} WHERE rowid IN (SELECT rowid FROM ${step.table} WHERE ${condition} ORDER BY rowid LIMIT ?)
      AND ${current.sql}`).bind(...conditionBindings, limit, ...current.bindings),
    db.prepare(`UPDATE platform_modules SET deletion_cursor=deletion_cursor+1,cleanup_failure=NULL
      WHERE installation_id=? AND module_id=? AND ${current.sql} AND NOT EXISTS(SELECT 1 FROM ${step.table} WHERE ${condition})`)
      .bind(state.installationId, state.moduleId, ...current.bindings, ...conditionBindings),
  ];
}

function resetStep(db: D1Database, state: DueState, token: string, step: ResetStep, limit: number): D1Statement[] {
  if (!safeName.test(step.table)) throw new Error("Invalid cleanup table");
  const current = guard(state, token);
  return [
    db.prepare(`UPDATE ${step.table} SET ${step.set} WHERE rowid IN (SELECT rowid FROM ${step.table}
      WHERE installation_id=? AND (${step.pending}) ORDER BY rowid LIMIT ?) AND ${current.sql}`)
      .bind(...step.bindings, state.installationId, limit, ...current.bindings),
    db.prepare(`UPDATE platform_modules SET deletion_cursor=deletion_cursor+1,cleanup_failure=NULL
      WHERE installation_id=? AND module_id=? AND ${current.sql}
      AND NOT EXISTS(SELECT 1 FROM ${step.table} WHERE installation_id=? AND (${step.pending}))`)
      .bind(state.installationId, state.moduleId, ...current.bindings, state.installationId, ...step.bindings),
  ];
}

function assignmentStep(db: D1Database, state: DueState, token: string, limit: number): D1Statement[] {
  const current = guard(state, token);
  const selected = `SELECT user_id FROM platform_module_assignments WHERE installation_id=? AND module_id=? ORDER BY rowid LIMIT ?`;
  return [
    db.prepare(`UPDATE platform_module_assignment_revisions SET revision=revision+1 WHERE installation_id=? AND revision<?
      AND user_id IN (${selected}) AND EXISTS(SELECT 1 FROM platform_module_assignment_epochs e
        WHERE e.installation_id=platform_module_assignment_revisions.installation_id AND e.user_id=platform_module_assignment_revisions.user_id
        AND e.revision=platform_module_assignment_revisions.revision) AND ${current.sql}`)
      .bind(state.installationId, maximumAuthority - 1, state.installationId, state.moduleId, limit, ...current.bindings),
    db.prepare(`UPDATE platform_module_assignment_epochs SET revision=(SELECT r.revision FROM platform_module_assignment_revisions r
      WHERE r.installation_id=platform_module_assignment_epochs.installation_id AND r.user_id=platform_module_assignment_epochs.user_id)
      WHERE installation_id=? AND user_id IN (${selected}) AND EXISTS(SELECT 1 FROM platform_module_assignment_revisions r
        WHERE r.installation_id=platform_module_assignment_epochs.installation_id AND r.user_id=platform_module_assignment_epochs.user_id
        AND r.revision=platform_module_assignment_epochs.revision+1) AND ${current.sql}`)
      .bind(state.installationId, state.installationId, state.moduleId, limit, ...current.bindings),
    db.prepare(`DELETE FROM platform_module_assignments WHERE installation_id=? AND module_id=? AND user_id IN (${selected})
      AND EXISTS(SELECT 1 FROM platform_module_assignment_revisions r JOIN platform_module_assignment_epochs e
        ON e.installation_id=r.installation_id AND e.user_id=r.user_id AND e.revision=r.revision
        WHERE r.installation_id=platform_module_assignments.installation_id AND r.user_id=platform_module_assignments.user_id)
      AND ${current.sql}`).bind(state.installationId, state.moduleId, state.installationId, state.moduleId, limit, ...current.bindings),
    db.prepare(`UPDATE platform_modules SET deletion_cursor=deletion_cursor+1,cleanup_failure=NULL
      WHERE installation_id=? AND module_id=? AND ${current.sql}
      AND NOT EXISTS(SELECT 1 FROM platform_module_assignments WHERE installation_id=? AND module_id=?)`)
      .bind(state.installationId, state.moduleId, ...current.bindings, state.installationId, state.moduleId),
  ];
}

async function finish(db: D1Database, state: DueState, token: string, now: Date, stepCount: number): Promise<ModuleCleanupResult> {
  const current = guard(state, token, stepCount);
  const auditId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(`UPDATE platform_modules SET phase='deleted',setup_complete=0,disabled_at=NULL,delete_after=NULL,deletion_cursor=0,cleanup_failure=NULL
      WHERE installation_id=? AND module_id=? AND ${current.sql}`).bind(state.installationId, state.moduleId, ...current.bindings),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,?,NULL,'module.deleted','platform_module',?,'{}',? WHERE changes()=1`)
      .bind(auditId, state.installationId, state.moduleId, now.toISOString()),
    db.prepare(`UPDATE platform_module_administration SET revision=revision+1 WHERE installation_id=? AND revision<?
      AND EXISTS(SELECT 1 FROM audit_log WHERE id=? AND installation_id=?)
      AND EXISTS(SELECT 1 FROM platform_module_administration_epochs e WHERE e.installation_id=platform_module_administration.installation_id AND e.revision=platform_module_administration.revision)`)
      .bind(state.installationId, maximumAuthority - 1, auditId, state.installationId),
    db.prepare(`UPDATE platform_module_administration_epochs SET revision=(SELECT revision FROM platform_module_administration WHERE installation_id=?)
      WHERE installation_id=? AND EXISTS(SELECT 1 FROM audit_log WHERE id=? AND installation_id=?)`)
      .bind(state.installationId, state.installationId, auditId, state.installationId),
  ]);
  if (results.some((result) => result.meta?.changes !== 1)) return { status: "retry-required" };
  return { status: "deleted" };
}

/** Run one bounded retained-data cleanup chunk. No provider or device operation occurs. */
export async function runModuleCleanup(db: D1Database, now = new Date(), limit = 100): Promise<ModuleCleanupResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Cleanup limit must be between 1 and 500");
  const state = await db.prepare(`SELECT installation_id AS installationId,module_id AS moduleId,generation,phase,deletion_cursor AS deletionCursor
    FROM platform_modules WHERE (module_id IN (${installedApiModules.map(() => "?").join(",")}) OR EXISTS(SELECT 1 FROM platform_module_catalog c
      WHERE c.installation_id=platform_modules.installation_id AND c.module_id=platform_modules.module_id AND c.installed=0))
    AND phase IN ('retained','deleting') AND julianday(delete_after)<=julianday(?)
    ORDER BY delete_after,installation_id LIMIT 1`).bind(...installedApiModules.map((module) => module.moduleId), now.toISOString()).first<DueState>();
  if (!state) return { status: "idle" };
  let cleanup: ModuleCleanup;
  try { cleanup = await cleanupFor(db, state.moduleId); }
  catch {
    await db.prepare("UPDATE platform_modules SET cleanup_failure='retry-required' WHERE installation_id=? AND module_id=? AND generation=? AND phase IN ('retained','deleting')")
      .bind(state.installationId, state.moduleId, state.generation).run();
    return { status: "retry-required" };
  }
  const reportedBlocker = cleanup.blocker;
  const blocked = reportedBlocker?.recordFailure ? await db.prepare(`SELECT 1 AS blocked WHERE ${reportedBlocker.sql}`).bind(...reportedBlocker.bindings(state.installationId)).first() : null;
  if (blocked) {
    await db.prepare("UPDATE platform_modules SET cleanup_failure='retry-required' WHERE installation_id=? AND module_id=? AND generation=? AND phase IN ('retained','deleting')")
      .bind(state.installationId, state.moduleId, state.generation).run();
    return { status: "blocked" };
  }
  const token = crypto.randomUUID();
  try {
    if (!await start(db, state, cleanup, token, now)) return { status: "idle" };
    const steps = cleanup.steps;
    if (state.deletionCursor >= steps.length) return await finish(db, state, token, now, steps.length);
    const step = steps[state.deletionCursor]!;
    const statements = step.kind === "delete" ? deleteStep(db, state, token, step, limit)
      : step.kind === "reset" ? resetStep(db, state, token, step, limit)
      : assignmentStep(db, state, token, limit);
    const results = await db.batch(statements);
    if (!results.some((result) => Number(result.meta?.changes ?? 0) > 0)) throw new Error("Cleanup state did not advance");
    return { status: "progress" };
  } catch {
    try {
      await db.prepare("UPDATE platform_modules SET cleanup_failure='retry-required' WHERE installation_id=? AND module_id=? AND generation=? AND phase IN ('retained','deleting')")
        .bind(state.installationId, state.moduleId, state.generation).run();
    } catch { /* The next maintenance pass retries after authority is restored. */ }
    return { status: "retry-required" };
  } finally {
    try { await db.prepare("DELETE FROM platform_module_cleanup_leases WHERE installation_id=? AND module_id=? AND generation=? AND token=?").bind(state.installationId, state.moduleId, state.generation, token).run(); }
    catch { /* The bounded lease expires and a later pass can recover it. */ }
  }
}
