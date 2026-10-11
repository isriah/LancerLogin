import { bundledModuleRegistry, type ModuleLifecyclePhase, type ModulePlatformSnapshot } from "../../../packages/shared/src/module-platform.ts";
import { attendanceSetupPredicates, attendanceSetupStepValid } from "./attendance-module-setup.ts";
import { outreachSetupPredicates, outreachSetupStepValid } from "./outreach-module-setup.ts";
import { carpoolSetupPredicates, carpoolSetupStepValid } from "./carpool-module-setup.ts";
import { HttpError } from "./http-error.ts";
import type { D1Database } from "./d1-usage.ts";

type ModuleDatabase = D1Database;
const moduleSetupBindings = Object.freeze({
  attendance: { predicates: attendanceSetupPredicates, stepValid: attendanceSetupStepValid },
  "hour-tracking": { predicates: outreachSetupPredicates, stepValid: outreachSetupStepValid },
  carpool: { predicates: carpoolSetupPredicates, stepValid: carpoolSetupStepValid },
} satisfies Record<string, { predicates: Readonly<Record<string, (installationId: string) => { sql: string; bindings: readonly unknown[] }>>; stepValid: (db: D1Database, stepId: string) => Promise<boolean> }>);
type ModuleStateRow = {
  role: "admin" | "operator";
  revision: number;
  selectionCompleted: number;
  administrationEpoch: number;
  moduleId: string;
  contractVersion: number;
  generation: number;
  moduleEpoch: number;
  phase: ModuleLifecyclePhase;
  setupVersion: number;
  setupComplete: number;
  disabledAt: string | null;
  deleteAfter: string | null;
  deletionCursor: number;
  cleanupFailure: string | null;
  assignmentRevision: number | null;
  assignmentEpoch: number | null;
  capabilitiesJson: string | null;
};

const installationId = "primary";
const maximumAuthority = Number.MAX_SAFE_INTEGER;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) < maximumAuthority;

function parseCapabilities(value: string | null): string[] {
  if (value === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new HttpError(409, "Module assignments require recovery reconciliation"); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string") || new Set(parsed).size !== parsed.length) throw new HttpError(409, "Module assignments require recovery reconciliation");
  return parsed;
}

function moduleRows(db: ModuleDatabase, userId: string) {
  return db.prepare(`SELECT u.role,a.revision,a.selection_completed AS selectionCompleted,
    ae.revision AS administrationEpoch,m.module_id AS moduleId,m.contract_version AS contractVersion,
    m.generation,e.generation AS moduleEpoch,m.phase,m.setup_version AS setupVersion,
    m.setup_complete AS setupComplete,m.disabled_at AS disabledAt,m.delete_after AS deleteAfter,
    m.deletion_cursor AS deletionCursor,m.cleanup_failure AS cleanupFailure,
    ar.revision AS assignmentRevision,axe.revision AS assignmentEpoch,g.capabilities_json AS capabilitiesJson
    FROM users u
    JOIN platform_module_administration a ON a.installation_id=u.installation_id
    JOIN platform_module_administration_epochs ae ON ae.installation_id=a.installation_id
    JOIN platform_modules m ON m.installation_id=u.installation_id
    JOIN platform_module_epochs e ON e.installation_id=m.installation_id AND e.module_id=m.module_id
    LEFT JOIN platform_module_assignment_revisions ar ON ar.installation_id=u.installation_id AND ar.user_id=u.id
    LEFT JOIN platform_module_assignment_epochs axe ON axe.installation_id=u.installation_id AND axe.user_id=u.id
    LEFT JOIN platform_module_assignments g ON g.installation_id=u.installation_id AND g.user_id=u.id AND g.module_id=m.module_id
    WHERE u.installation_id=? AND u.id=? AND u.active=1 AND u.role IN ('admin','operator')
    ORDER BY m.module_id`).bind(installationId, userId).all<ModuleStateRow>();
}

export async function readModulePlatformSnapshot(db: ModuleDatabase, userId: string): Promise<ModulePlatformSnapshot> {
  const rows = (await moduleRows(db, userId)).results ?? [];
  if (!rows.length) throw new HttpError(409, "Module registration is unavailable");
  const first = rows[0]!;
  if (!integer(first.revision) || first.revision !== first.administrationEpoch) throw new HttpError(409, "Module configuration requires recovery reconciliation");
  const byId = new Map(rows.map((row) => [row.moduleId, row]));
  const modules = bundledModuleRegistry.modules.filter((module) => module.available).map((module) => {
    const row = byId.get(module.id);
    if (!row || !integer(row.generation, 1) || row.generation !== row.moduleEpoch || row.contractVersion !== module.contractVersion || row.setupVersion !== module.setup.version) throw new HttpError(409, "Module lifecycle requires recovery reconciliation");
    const assigned = parseCapabilities(row.capabilitiesJson);
    const assignmentValid = row.assignmentRevision !== null && row.assignmentRevision === row.assignmentEpoch;
    if (row.role === "operator" && !assignmentValid) throw new HttpError(409, "Module assignments require recovery reconciliation");
    const ready = row.phase === "enabled" && row.setupComplete === 1 && first.selectionCompleted === 1;
    const effectiveCapabilities = ready ? module.capabilities.filter((capability) => row.role === "admin" || capability.operator && assigned.includes(capability.id)).map((capability) => capability.id) : [];
    const retaining = row.phase === "retained" || row.phase === "deleting";
    if (retaining && (!row.disabledAt || !row.deleteAfter || Date.parse(row.deleteAfter) - Date.parse(row.disabledAt) !== 7 * 24 * 60 * 60 * 1000)) throw new HttpError(409, "Module retention requires recovery reconciliation");
    if (!retaining && (row.disabledAt !== null || row.deleteAfter !== null)) throw new HttpError(409, "Module retention requires recovery reconciliation");
    return {
      id: module.id,
      label: module.label,
      description: module.description,
      contractVersion: module.contractVersion,
      enabled: row.phase === "enabled",
      phase: row.phase,
      generation: row.generation,
      dependencies: module.dependencies,
      permissions: module.capabilities,
      effectiveCapabilities,
      workspaceReady: effectiveCapabilities.length > 0,
      navigation: module.navigation,
      settings: module.settings,
      setup: { ...module.setup, ready: row.setupComplete === 1 },
      deletion: { disabledAt: row.disabledAt, deleteAfter: row.deleteAfter, contentStillPresent: retaining, cleanupFailure: row.cleanupFailure, data: module.deletedData },
    };
  });
  return { revision: first.revision, selectionCompleted: first.selectionCompleted === 1, capabilities: modules.flatMap((module) => module.effectiveCapabilities), modules };
}

type ModuleConfiguration = { enabled: string[]; revision: number; confirmDisable: { moduleId: string; generation: number }[] };
export function validateModuleConfiguration(value: unknown): ModuleConfiguration {
  if (!object(value) || Object.keys(value).some((key) => !["enabled", "revision", "confirmDisable"].includes(key)) || !Array.isArray(value.enabled) || value.enabled.some((item) => typeof item !== "string") || !integer(value.revision) || value.confirmDisable !== undefined && !Array.isArray(value.confirmDisable)) throw new HttpError(400, "Provide selected modules and the current configuration revision");
  try { bundledModuleRegistry.validateSelection(value.enabled as string[]); } catch { throw new HttpError(400, "Select available modules and all required dependencies"); }
  const confirmations = value.confirmDisable ?? [];
  if (confirmations.some((item) => !object(item) || Object.keys(item).some((key) => !["moduleId", "generation"].includes(key)) || typeof item.moduleId !== "string" || !integer(item.generation, 1)) || new Set(confirmations.map((item) => item.moduleId)).size !== confirmations.length) throw new HttpError(400, "Provide current module generations for disable confirmation");
  return { enabled: [...value.enabled] as string[], revision: Number(value.revision), confirmDisable: confirmations as ModuleConfiguration["confirmDisable"] };
}

export async function configureModulePlatform(db: ModuleDatabase, actorUserId: string, value: unknown) {
  const input = validateModuleConfiguration(value);
  const current = await readModulePlatformSnapshot(db, actorUserId);
  if (current.revision !== input.revision) throw new HttpError(409, "Module configuration changed; reload before saving");
  const selected = new Set(input.enabled);
  const transitions = current.modules.map((module) => {
    const enable = selected.has(module.id);
    const disabling = module.enabled && !enable;
    const fresh = module.phase === "deleted" && enable;
    if (module.phase === "deleting" && enable) throw new HttpError(409, `${module.label} deletion has started and must finish before fresh setup`);
    if (disabling && !input.confirmDisable.some((item) => item.moduleId === module.id && item.generation === module.generation)) throw new HttpError(409, `Review and confirm the current ${module.label} generation before disabling it`);
    const generation = disabling || fresh ? module.generation + 1 : module.generation;
    if (!integer(generation, 1)) throw new HttpError(409, "Module authority is exhausted");
    const phase: ModuleLifecyclePhase = enable ? "enabled" : disabling ? "retained" : module.phase;
    return { module, enable, disabling, fresh, generation, phase };
  });
  const attendance = transitions.find((item) => item.module.id === "attendance")!;
  const disablingAttendance = attendance.disabling;
  if (disablingAttendance) {
    const blocker = await db.prepare(`SELECT 1 AS blocked WHERE
      EXISTS(SELECT 1 FROM integration_deliveries WHERE installation_id=? AND status='pending')
      OR EXISTS(SELECT 1 FROM google_calendar_operations WHERE installation_id=? AND status='pending')
      OR EXISTS(SELECT 1 FROM discord_calendar_operations WHERE installation_id=? AND (status='processing' OR julianday(lease_expires_at)>julianday('now')))`)
      .bind(installationId, installationId, installationId).first();
    if (blocker) throw new HttpError(409, "Wait for in-flight Attendance delivery work to finish before disabling the module");
  }
  const now = new Date().toISOString();
  const deleteAfter = new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();
  const operationId = crypto.randomUUID();
  const statements = [
    db.prepare(`UPDATE platform_module_administration SET revision=revision+1,selection_completed=1
      WHERE installation_id=? AND revision=? AND revision<?
      AND EXISTS(SELECT 1 FROM platform_module_administration_epochs e WHERE e.installation_id=platform_module_administration.installation_id AND e.revision=platform_module_administration.revision)
      AND EXISTS(SELECT 1 FROM users u WHERE u.installation_id=platform_module_administration.installation_id AND u.id=? AND u.active=1 AND u.role='admin')`)
      .bind(installationId, input.revision, maximumAuthority - 1, actorUserId),
    db.prepare(`UPDATE platform_module_administration_epochs SET revision=? WHERE installation_id=? AND revision=?
      AND EXISTS(SELECT 1 FROM platform_module_administration a WHERE a.installation_id=platform_module_administration_epochs.installation_id AND a.revision=?)`)
      .bind(input.revision + 1, installationId, input.revision, input.revision + 1),
    ...transitions.flatMap(({ module, enable, disabling, fresh, generation, phase }) => [
      db.prepare(`UPDATE platform_modules SET phase=?,generation=?,disabled_at=?,delete_after=?,
        setup_complete=CASE WHEN ? THEN 0 ELSE setup_complete END,
        deletion_cursor=CASE WHEN ? THEN 0 ELSE deletion_cursor END,cleanup_failure=NULL
        WHERE installation_id=? AND module_id=? AND generation=? AND phase=?
        AND ${module.id === "attendance" && disabling ? "NOT EXISTS(SELECT 1 FROM integration_deliveries WHERE installation_id='primary' AND status='pending') AND NOT EXISTS(SELECT 1 FROM google_calendar_operations WHERE installation_id='primary' AND status='pending') AND NOT EXISTS(SELECT 1 FROM discord_calendar_operations WHERE installation_id='primary' AND (status='processing' OR julianday(lease_expires_at)>julianday('now')))" : "1=1"}
        AND EXISTS(SELECT 1 FROM platform_module_administration a JOIN platform_module_administration_epochs e ON e.installation_id=a.installation_id AND e.revision=a.revision WHERE a.installation_id=platform_modules.installation_id AND a.revision=?)`)
        .bind(phase, generation, enable ? null : disabling ? now : module.deletion.disabledAt, enable ? null : disabling ? deleteAfter : module.deletion.deleteAfter, fresh ? 1 : 0, fresh ? 1 : 0, installationId, module.id, module.generation, module.phase, input.revision + 1),
      db.prepare(`UPDATE platform_module_epochs SET generation=? WHERE installation_id=? AND module_id=? AND generation=?
        AND EXISTS(SELECT 1 FROM platform_modules m WHERE m.installation_id=platform_module_epochs.installation_id AND m.module_id=platform_module_epochs.module_id AND m.generation=?)`)
        .bind(generation, installationId, module.id, module.generation, generation),
    ]),
    ...(disablingAttendance ? [
      db.prepare(`UPDATE kiosks SET active=0,token_hash=lower(hex(randomblob(32))) WHERE installation_id=?
        AND EXISTS(SELECT 1 FROM platform_modules m JOIN platform_module_epochs e ON e.installation_id=m.installation_id AND e.module_id=m.module_id AND e.generation=m.generation
          WHERE m.installation_id=kiosks.installation_id AND m.module_id='attendance' AND m.generation=? AND m.phase='retained')`).bind(installationId, attendance.generation),
      db.prepare(`UPDATE pairing_codes SET expires_at=? WHERE installation_id=?
        AND EXISTS(SELECT 1 FROM platform_modules m JOIN platform_module_epochs e ON e.installation_id=m.installation_id AND e.module_id=m.module_id AND e.generation=m.generation
          WHERE m.installation_id=pairing_codes.installation_id AND m.module_id='attendance' AND m.generation=? AND m.phase='retained')`).bind(now, installationId, attendance.generation),
      db.prepare(`UPDATE simulated_kiosk_sessions SET active=0,online=0 WHERE installation_id=?
        AND EXISTS(SELECT 1 FROM platform_modules m JOIN platform_module_epochs e ON e.installation_id=m.installation_id AND e.module_id=m.module_id AND e.generation=m.generation
          WHERE m.installation_id=simulated_kiosk_sessions.installation_id AND m.module_id='attendance' AND m.generation=? AND m.phase='retained')`).bind(installationId, attendance.generation),
      db.prepare(`DELETE FROM kiosk_commands WHERE installation_id=? AND completed_at IS NULL
        AND EXISTS(SELECT 1 FROM platform_modules m JOIN platform_module_epochs e ON e.installation_id=m.installation_id AND e.module_id=m.module_id AND e.generation=m.generation
          WHERE m.installation_id=kiosk_commands.installation_id AND m.module_id='attendance' AND m.generation=? AND m.phase='retained')`).bind(installationId, attendance.generation),
    ] : []),
    ...transitions.filter((item) => item.module.id === "hour-tracking" && item.fresh).flatMap(() => [
      db.prepare("INSERT OR IGNORE INTO hours_entry_settings(installation_id) VALUES(?)").bind(installationId),
      ...[["event", "Event", "event"], ["team-support", "Team Support", "team"], ["other-service", "Other Service", "task"]].map(([id, name, mode]) =>
        db.prepare("INSERT OR IGNORE INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES(?,?,?,?,1,?,?)").bind(installationId, id, name, mode, now, now)),
    ]),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,?,?, 'modules.configured','platform_module',?,?,? WHERE EXISTS(SELECT 1 FROM platform_module_administration a JOIN platform_module_administration_epochs e ON e.installation_id=a.installation_id AND e.revision=a.revision WHERE a.installation_id=? AND a.revision=?)`)
      .bind(operationId, installationId, actorUserId, installationId, JSON.stringify({ enabled: input.enabled }), now, installationId, input.revision + 1),
  ];
  const results = await db.batch(statements);
  const transitionResults = results.slice(2, 2 + transitions.length * 2);
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1 || transitionResults.some((result) => result.meta?.changes !== 1) || results.at(-1)?.meta?.changes !== 1) throw new HttpError(409, "Module configuration or Admin access changed; reload before saving");
  return readModulePlatformSnapshot(db, actorUserId);
}

export async function readModuleAssignments(db: ModuleDatabase, actorUserId: string, targetUserId: string) {
  if (!targetUserId || targetUserId.length > 128) throw new HttpError(400, "Invalid Operator identity");
  const rows = (await db.prepare(`SELECT r.revision,e.revision AS epoch,g.capabilities_json AS capabilitiesJson
    FROM users target
    JOIN platform_module_assignment_revisions r ON r.installation_id=target.installation_id AND r.user_id=target.id
    JOIN platform_module_assignment_epochs e ON e.installation_id=target.installation_id AND e.user_id=target.id
    LEFT JOIN platform_module_assignments g ON g.installation_id=target.installation_id AND g.user_id=target.id
    WHERE target.installation_id=? AND target.id=? AND target.active=1 AND target.role='operator'
    AND EXISTS(SELECT 1 FROM users actor WHERE actor.installation_id=target.installation_id AND actor.id=? AND actor.active=1 AND actor.role='admin')`)
    .bind(installationId, targetUserId, actorUserId).all<{ revision: number; epoch: number; capabilitiesJson: string | null }>()).results ?? [];
  if (!rows.length) throw new HttpError(404, "Active Operator account is unavailable");
  if (!integer(rows[0]!.revision) || rows[0]!.revision !== rows[0]!.epoch) throw new HttpError(409, "Module assignments require recovery reconciliation");
  return { userId: targetUserId, revision: rows[0]!.revision, capabilities: [...new Set(rows.flatMap((row) => parseCapabilities(row.capabilitiesJson)))].filter((capability) => bundledModuleRegistry.capabilityOwner(capability)?.available) };
}

export function validateModuleAssignments(value: unknown) {
  if (!object(value) || Object.keys(value).some((key) => !["capabilities", "revision"].includes(key)) || !Array.isArray(value.capabilities) || value.capabilities.some((item) => typeof item !== "string") || new Set(value.capabilities).size !== value.capabilities.length || !integer(value.revision)) throw new HttpError(400, "Provide module capabilities and the current assignment revision");
  for (const capability of value.capabilities as string[]) {
    const owner = bundledModuleRegistry.capabilityOwner(capability);
    if (!owner?.available || !owner.capabilities.some((item) => item.id === capability && item.operator)) throw new HttpError(400, "Assignments require available Operator capabilities");
  }
  return { capabilities: [...value.capabilities] as string[], revision: Number(value.revision) };
}

export async function setModuleAssignments(db: ModuleDatabase, actorUserId: string, targetUserId: string, value: unknown) {
  const input = validateModuleAssignments(value);
  const current = await readModuleAssignments(db, actorUserId, targetUserId);
  if (current.revision !== input.revision) throw new HttpError(409, "Module assignments changed; reload before saving");
  const nextRevision = input.revision + 1;
  const operationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const byModule = new Map<string, string[]>();
  for (const capability of input.capabilities) {
    const owner = bundledModuleRegistry.capabilityOwner(capability)!;
    byModule.set(owner.id, [...(byModule.get(owner.id) ?? []), capability]);
  }
  const results = await db.batch([
    db.prepare(`UPDATE platform_module_assignment_revisions SET revision=? WHERE installation_id=? AND user_id=? AND revision=? AND revision<?
      AND EXISTS(SELECT 1 FROM platform_module_assignment_epochs e WHERE e.installation_id=platform_module_assignment_revisions.installation_id AND e.user_id=platform_module_assignment_revisions.user_id AND e.revision=platform_module_assignment_revisions.revision)
      AND EXISTS(SELECT 1 FROM users target WHERE target.installation_id=platform_module_assignment_revisions.installation_id AND target.id=platform_module_assignment_revisions.user_id AND target.active=1 AND target.role='operator')
      AND EXISTS(SELECT 1 FROM users actor WHERE actor.installation_id=platform_module_assignment_revisions.installation_id AND actor.id=? AND actor.active=1 AND actor.role='admin')`)
      .bind(nextRevision, installationId, targetUserId, input.revision, maximumAuthority - 1, actorUserId),
    db.prepare(`UPDATE platform_module_assignment_epochs SET revision=? WHERE installation_id=? AND user_id=? AND revision=?
      AND EXISTS(SELECT 1 FROM platform_module_assignment_revisions r WHERE r.installation_id=platform_module_assignment_epochs.installation_id AND r.user_id=platform_module_assignment_epochs.user_id AND r.revision=?)`)
      .bind(nextRevision, installationId, targetUserId, input.revision, nextRevision),
    db.prepare(`DELETE FROM platform_module_assignments WHERE installation_id=? AND user_id=?
      AND EXISTS(SELECT 1 FROM platform_module_assignment_revisions r JOIN platform_module_assignment_epochs e ON e.installation_id=r.installation_id AND e.user_id=r.user_id AND e.revision=r.revision WHERE r.installation_id=platform_module_assignments.installation_id AND r.user_id=platform_module_assignments.user_id AND r.revision=?)`)
      .bind(installationId, targetUserId, nextRevision),
    ...[...byModule].map(([moduleId, capabilities]) => db.prepare(`INSERT INTO platform_module_assignments(installation_id,user_id,module_id,capabilities_json)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM platform_module_assignment_revisions r JOIN platform_module_assignment_epochs e ON e.installation_id=r.installation_id AND e.user_id=r.user_id AND e.revision=r.revision WHERE r.installation_id=? AND r.user_id=? AND r.revision=?)
      AND EXISTS(SELECT 1 FROM platform_modules m JOIN platform_module_epochs me ON me.installation_id=m.installation_id AND me.module_id=m.module_id AND me.generation=m.generation WHERE m.installation_id=? AND m.module_id=? AND m.phase IN ('disabled','enabled','retained'))`)
      .bind(installationId, targetUserId, moduleId, JSON.stringify(capabilities), installationId, targetUserId, nextRevision, installationId, moduleId)),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,?,?, 'modules.assignments_updated','user',?,?,? WHERE EXISTS(SELECT 1 FROM platform_module_assignment_revisions r JOIN platform_module_assignment_epochs e ON e.installation_id=r.installation_id AND e.user_id=r.user_id AND e.revision=r.revision WHERE r.installation_id=? AND r.user_id=? AND r.revision=?)`)
      .bind(operationId, installationId, actorUserId, targetUserId, JSON.stringify({ capabilities: input.capabilities }), now, installationId, targetUserId, nextRevision),
  ]);
  const auditIndex = 3 + byModule.size;
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1 || results[auditIndex]?.meta?.changes !== 1) throw new HttpError(409, "Module assignments or Admin access changed; reload before saving");
  return readModuleAssignments(db, actorUserId, targetUserId);
}

export async function requireModuleWorkspace(db: ModuleDatabase, userId: string, moduleId: string) {
  const module = bundledModuleRegistry.get(moduleId);
  if (!module?.available) throw new HttpError(409, "Module is unavailable in this release");
  const capability = module.capabilities.find((item) => item.operator)?.id;
  const row = await db.prepare(`SELECT m.generation FROM users u
    JOIN platform_module_administration a ON a.installation_id=u.installation_id
    JOIN platform_module_administration_epochs ae ON ae.installation_id=a.installation_id AND ae.revision=a.revision
    JOIN platform_modules m ON m.installation_id=u.installation_id AND m.module_id=?
    JOIN platform_module_epochs me ON me.installation_id=m.installation_id AND me.module_id=m.module_id AND me.generation=m.generation
    WHERE u.installation_id=? AND u.id=? AND u.active=1 AND a.selection_completed=1 AND m.phase='enabled' AND m.setup_complete=1
    AND (u.role='admin' OR (u.role='operator' AND EXISTS(SELECT 1 FROM platform_module_assignments g
      JOIN platform_module_assignment_revisions r ON r.installation_id=g.installation_id AND r.user_id=g.user_id
      JOIN platform_module_assignment_epochs e ON e.installation_id=r.installation_id AND e.user_id=r.user_id AND e.revision=r.revision,
      json_each(g.capabilities_json) c WHERE g.installation_id=u.installation_id AND g.user_id=u.id AND g.module_id=m.module_id AND c.type='text' AND c.value=?)))`)
    .bind(moduleId, installationId, userId, capability).first<{ generation: number }>();
  if (!row) throw new HttpError(403, `${module.label} access is unavailable`);
  return row.generation;
}

export async function requireModuleService(db: ModuleDatabase, moduleId: string) {
  const module = bundledModuleRegistry.get(moduleId);
  if (!module?.available) throw new HttpError(409, "Module is unavailable in this release");
  const row = await db.prepare(`SELECT m.generation FROM platform_modules m
    JOIN platform_module_epochs me ON me.installation_id=m.installation_id AND me.module_id=m.module_id AND me.generation=m.generation
    JOIN platform_module_administration a ON a.installation_id=m.installation_id AND a.selection_completed=1
    JOIN platform_module_administration_epochs ae ON ae.installation_id=a.installation_id AND ae.revision=a.revision
    WHERE m.installation_id=? AND m.module_id=? AND m.phase='enabled' AND m.setup_complete=1`)
    .bind(installationId, moduleId).first<{ generation: number }>();
  if (!row) throw new HttpError(409, `${module.label} is disabled`);
  return row.generation;
}

export async function requireModuleSetup(db: ModuleDatabase, userId: string, moduleId: string) {
  const module = bundledModuleRegistry.get(moduleId);
  if (!module?.available) throw new HttpError(409, "Module is unavailable in this release");
  const row = await db.prepare(`SELECT m.generation FROM users u
    JOIN platform_module_administration a ON a.installation_id=u.installation_id AND a.selection_completed=1
    JOIN platform_module_administration_epochs ae ON ae.installation_id=a.installation_id AND ae.revision=a.revision
    JOIN platform_modules m ON m.installation_id=u.installation_id AND m.module_id=?
    JOIN platform_module_epochs me ON me.installation_id=m.installation_id AND me.module_id=m.module_id AND me.generation=m.generation
    WHERE u.installation_id=? AND u.id=? AND u.active=1 AND u.role='admin' AND m.phase='enabled' AND m.setup_version=?`)
    .bind(moduleId, installationId, userId, module.setup.version).first<{ generation: number }>();
  if (!row) throw new HttpError(403, `${module.label} setup is unavailable`);
  return row.generation;
}

type SetupOutcome = "completed" | "skipped";
type SetupProgressRow = { stepId: string; setupVersion: number; outcome: SetupOutcome; completedAt: string; };

export async function readModuleSetup(db: ModuleDatabase, actorUserId: string, moduleId: string) {
  const module = bundledModuleRegistry.get(moduleId);
  if (!module?.available) throw new HttpError(404, "Module setup is unavailable");
  const generation = await requireModuleSetup(db, actorUserId, moduleId);
  const state = await db.prepare("SELECT phase,setup_complete AS setupComplete FROM platform_modules WHERE installation_id=? AND module_id=? AND generation=?")
    .bind(installationId, moduleId, generation).first<{ phase: ModuleLifecyclePhase; setupComplete: number }>();
  if (!state) throw new HttpError(409, "Module setup state changed; reload setup");
  const progress = (await db.prepare(`SELECT step_id AS stepId,setup_version AS setupVersion,outcome,completed_at AS completedAt
    FROM platform_module_setup_progress WHERE installation_id=? AND module_id=? ORDER BY completed_at,step_id`)
    .bind(installationId, moduleId).all<SetupProgressRow>()).results ?? [];
  const byStep = new Map(progress.filter((item) => item.setupVersion === module.setup.version).map((item) => [item.stepId, item]));
  const stepValid = moduleSetupBindings[moduleId as keyof typeof moduleSetupBindings]?.stepValid;
  if (!stepValid) throw new HttpError(500, "Module setup binding is unavailable");
  const steps = await Promise.all(module.setup.steps.map(async (step) => {
    const recorded = byStep.get(step.id); const valid = await stepValid(db, step.id);
    return { ...step, valid, outcome: recorded?.outcome ?? null, completedAt: recorded?.completedAt ?? null };
  }));
  return { moduleId, generation, ready: state.setupComplete === 1, phase: state.phase, version: module.setup.version, steps };
}

export function validateModuleSetupUpdate(value: unknown) {
  if (!object(value) || Object.keys(value).some((key) => !["generation", "stepId", "outcome"].includes(key)) || !integer(value.generation, 1) || typeof value.stepId !== "string" || !["completed", "skipped"].includes(String(value.outcome))) throw new HttpError(400, "Provide the current module generation, setup step, and outcome");
  return { generation: Number(value.generation), stepId: value.stepId, outcome: value.outcome as SetupOutcome };
}

export async function updateModuleSetup(db: ModuleDatabase, actorUserId: string, moduleId: string, value: unknown) {
  const module = bundledModuleRegistry.get(moduleId);
  if (!module?.available) throw new HttpError(404, "Module setup is unavailable");
  const input = validateModuleSetupUpdate(value);
  const generation = await requireModuleSetup(db, actorUserId, moduleId);
  if (generation !== input.generation) throw new HttpError(409, "Module generation changed; reload setup");
  const step = module.setup.steps.find((item) => item.id === input.stepId);
  if (!step) throw new HttpError(400, "Unknown module setup step");
  if (step.required && input.outcome === "skipped") throw new HttpError(400, "Required module setup steps cannot be skipped");
  const predicates = moduleSetupBindings[moduleId as keyof typeof moduleSetupBindings]?.predicates;
  const predicateFactory = predicates?.[input.stepId];
  if (!predicateFactory) throw new HttpError(500, "Module setup binding is unavailable");
  const predicate = predicateFactory(installationId);
  const now = new Date().toISOString(); const auditId = crypto.randomUUID();
  const required = module.setup.steps.filter((item) => item.required).map((item) => ({ step: item, predicate: predicates![item.id]!(installationId) }));
  const readySql = required.map((item) => `EXISTS(SELECT 1 FROM platform_module_setup_progress p WHERE p.installation_id=platform_modules.installation_id
    AND p.module_id=platform_modules.module_id AND p.step_id='${item.step.id}' AND p.setup_version=${module.setup.version} AND p.outcome='completed') AND (${item.predicate.sql})`).join(" AND ");
  const readyBindings = required.flatMap((item) => item.predicate.bindings);
  const results = await db.batch([
    db.prepare(`INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM platform_modules m
        JOIN platform_module_epochs e ON e.installation_id=m.installation_id AND e.module_id=m.module_id AND e.generation=m.generation
        JOIN platform_module_administration a ON a.installation_id=m.installation_id AND a.selection_completed=1
        JOIN platform_module_administration_epochs ae ON ae.installation_id=a.installation_id AND ae.revision=a.revision
        JOIN users u ON u.installation_id=m.installation_id AND u.id=? AND u.active=1 AND u.role='admin'
        WHERE m.installation_id=? AND m.module_id=? AND m.generation=? AND m.phase='enabled' AND m.setup_version=?)
        ${input.outcome === "completed" ? `AND (${predicate.sql})` : ""}
      ON CONFLICT(installation_id,module_id,step_id) DO UPDATE SET setup_version=excluded.setup_version,outcome=excluded.outcome,
        completed_at=excluded.completed_at,completed_by=excluded.completed_by`)
      .bind(installationId, moduleId, input.stepId, module.setup.version, input.outcome, now, actorUserId,
        actorUserId, installationId, moduleId, generation, module.setup.version, ...(input.outcome === "completed" ? predicate.bindings : [])),
    db.prepare(`UPDATE platform_modules SET setup_complete=1 WHERE installation_id=? AND module_id=? AND generation=? AND phase='enabled'
      AND setup_version=? AND (${readySql})`).bind(installationId, moduleId, generation, module.setup.version, ...readyBindings),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,?,?, 'module.setup_step_recorded','platform_module',?,?,? WHERE EXISTS(SELECT 1 FROM platform_module_setup_progress
        WHERE installation_id=? AND module_id=? AND step_id=? AND setup_version=? AND outcome=? AND completed_at=?)`)
      .bind(auditId, installationId, actorUserId, moduleId, JSON.stringify({ stepId: input.stepId, outcome: input.outcome }), now,
        installationId, moduleId, input.stepId, module.setup.version, input.outcome, now),
  ]);
  if (results[0]?.meta?.changes !== 1 || results[2]?.meta?.changes !== 1) throw new HttpError(409, input.outcome === "completed" ? "Complete the current setup step before continuing" : "Module setup state changed; reload setup");
  return readModuleSetup(db, actorUserId, moduleId);
}

export async function moduleServiceEnabled(db: ModuleDatabase, moduleId: string) {
  try { await requireModuleService(db, moduleId); return true; } catch { return false; }
}
