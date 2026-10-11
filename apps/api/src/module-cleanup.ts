import type { D1Database, D1Statement } from "./d1-usage.ts";
import { carpoolCleanupSteps } from "./carpool-lifecycle.ts";

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
type CleanupStep = DeleteStep | ResetStep | AssignmentStep;

const attendanceSteps: readonly CleanupStep[] = [
  { kind: "delete", table: "kiosk_commands" },
  { kind: "delete", table: "simulated_kiosk_sessions" },
  { kind: "delete", table: "kiosks" },
  { kind: "delete", table: "pairing_codes" },
  { kind: "delete", table: "discord_attendance_recipients" },
  { kind: "delete", table: "discord_attendance_contests" },
  { kind: "delete", table: "discord_attendance_notifications" },
  { kind: "delete", table: "discord_anomaly_reports" },
  { kind: "delete", table: "discord_calendar_operations" },
  { kind: "delete", table: "discord_calendar_event_mappings" },
  { kind: "delete", table: "google_calendar_operations" },
  { kind: "delete", table: "google_calendar_event_mappings" },
  { kind: "delete", table: "attendance_corrections" },
  { kind: "delete", table: "attendance_events" },
  { kind: "delete", table: "meeting_audience_labels" },
  { kind: "delete", table: "meetings" },
  { kind: "delete", table: "meeting_templates" },
  { kind: "delete", table: "label_attendance_rules" },
  { kind: "delete", table: "meeting_weight_categories" },
  { kind: "delete", table: "integration_deliveries", where: "provider='resend' AND (delivery_key LIKE 'missed:%' OR delivery_key LIKE 'report:%')" },
  { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["attendance"] },
  { kind: "delete", table: "setup_progress", where: "step IN ('pair-kiosk','fingerprint-test','confirm-attendance')" },
  { kind: "assignments" },
  { kind: "reset", table: "members", pending: "attendance_required_from IS NOT NULL", set: "attendance_required_from=NULL", bindings: [] },
  { kind: "reset", table: "organization_settings", pending: `late_scan_minutes<>30 OR discord_contest_window_hours<>24 OR discord_channel_manager_enabled<>0
      OR attendance_reporting_starts_on IS NOT NULL OR anomaly_late_threshold_minutes<>10 OR anomaly_early_threshold_minutes<>10
      OR discord_anomaly_reports_enabled<>0 OR discord_anomaly_report_channel_id IS NOT NULL OR discord_anomaly_reports_enabled_at IS NOT NULL
      OR attendance_recent_days<>30 OR attendance_policy_activated_on IS NOT NULL OR kiosk_authentication_method<>'fingerprint'`, set: `late_scan_minutes=30,discord_contest_window_hours=24,
      discord_channel_manager_enabled=0,attendance_reporting_starts_on=NULL,anomaly_late_threshold_minutes=10,anomaly_early_threshold_minutes=10,
      discord_anomaly_reports_enabled=0,discord_anomaly_report_channel_id=NULL,discord_anomaly_reports_enabled_at=NULL,
      attendance_recent_days=30,attendance_policy_activated_on=NULL,kiosk_authentication_method='fingerprint'`, bindings: [] },
  // Appended so an in-progress retained-data cursor keeps its historical meaning.
  { kind: "delete", table: "label_weekly_targets" },
  { kind: "delete", table: "kiosk_fingerprint_deliveries" },
  { kind: "delete", table: "kiosk_fingerprint_keys" },
  { kind: "delete", table: "kiosk_fingerprint_sync" },
  { kind: "delete", table: "kiosk_fingerprint_vault_templates" },
  { kind: "delete", table: "kiosk_fingerprint_vault_settings" },
  // Slots have no installation_id. Delete scoped parents and cascade children,
  // retaining both appended cursor positions for interrupted cleanup retries.
  { kind: "delete", table: "kiosk_fingerprint_review_manifests" },
  { kind: "delete", table: "kiosk_fingerprint_review_manifests" },
  { kind: "delete", table: "kiosk_fingerprint_review_requests" },
  { kind: "delete", table: "kiosk_fingerprint_reset_commands" },
  { kind: "delete", table: "kiosk_fingerprint_reset_batches" },
  { kind: "delete", table: "kiosk_fingerprint_retired_review_grants" },
];

const outreachSteps: readonly CleanupStep[] = [
  { kind: "delete", table: "hours_publication_operations" },
  { kind: "delete", table: "hours_activity_publications" },
  { kind: "delete", table: "hours_correction_resolutions" },
  { kind: "delete", table: "hours_correction_requests" },
  { kind: "delete", table: "hours_reopen_windows" },
  { kind: "delete", table: "hours_submission_keys" },
  { kind: "delete", table: "hours_entry_revisions" },
  { kind: "delete", table: "hours_entries" },
  { kind: "delete", table: "hours_activities" },
  { kind: "delete", table: "hours_teams" },
  { kind: "delete", table: "hours_categories" },
  { kind: "delete", table: "hours_entry_settings" },
  { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["hour-tracking"] },
  { kind: "assignments" },
  // Appended so an in-progress retained-data cursor keeps its historical meaning.
  { kind: "delete", table: "hours_activity_labels" },
  { kind: "delete", table: "hours_labels" },
  { kind: "delete", table: "hours_public_form_settings" },
  { kind: "delete", table: "hours_public_lookup_limits" },
];

function stepsFor(moduleId: string) {
  const bindings: Readonly<Record<string, readonly CleanupStep[]>> = { attendance: attendanceSteps, "hour-tracking": outreachSteps, carpool: carpoolCleanupSteps };
  const steps = bindings[moduleId]; if (!steps) throw new Error("Unknown module cleanup binding"); return steps;
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

const moduleBlockers = `EXISTS(SELECT 1 FROM integration_deliveries WHERE installation_id=? AND status='pending')
  OR EXISTS(SELECT 1 FROM google_calendar_operations WHERE installation_id=? AND status='pending')
  OR EXISTS(SELECT 1 FROM discord_calendar_operations WHERE installation_id=? AND (status='processing' OR julianday(lease_expires_at)>julianday('now')))`;
const outreachBlockers = "EXISTS(SELECT 1 FROM hours_publication_operations WHERE installation_id=? AND status='processing' AND julianday(lease_expires_at)>julianday('now'))";

async function start(db: D1Database, state: DueState, token: string, now: Date) {
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  const lease = await db.prepare(`INSERT INTO platform_module_cleanup_leases(installation_id,module_id,generation,token,expires_at)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM platform_modules m
      JOIN platform_module_epochs e ON e.installation_id=m.installation_id AND e.module_id=m.module_id AND e.generation=m.generation
      JOIN platform_module_administration a ON a.installation_id=m.installation_id
      JOIN platform_module_administration_epochs ae ON ae.installation_id=a.installation_id AND ae.revision=a.revision
      WHERE m.installation_id=? AND m.module_id=? AND m.generation=? AND m.phase IN ('retained','deleting')
      AND julianday(m.delete_after)<=julianday(?) ${state.moduleId === "attendance" ? `AND NOT (${moduleBlockers})` : state.moduleId === "hour-tracking" ? `AND NOT (${outreachBlockers})` : ""})
    ON CONFLICT(installation_id,module_id) DO UPDATE SET generation=excluded.generation,token=excluded.token,expires_at=excluded.expires_at
    WHERE julianday(platform_module_cleanup_leases.expires_at)<=julianday(?)`)
    .bind(state.installationId, state.moduleId, state.generation, token, expiresAt,
      state.installationId, state.moduleId, state.generation, now.toISOString(),
      ...(state.moduleId === "attendance" ? [state.installationId, state.installationId, state.installationId] : state.moduleId === "hour-tracking" ? [state.installationId] : []), now.toISOString()).run();
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
    FROM platform_modules WHERE module_id IN ('attendance','hour-tracking','carpool') AND phase IN ('retained','deleting') AND julianday(delete_after)<=julianday(?)
    ORDER BY delete_after,installation_id LIMIT 1`).bind(now.toISOString()).first<DueState>();
  if (!state) return { status: "idle" };
  const blocker = state.moduleId === "attendance" ? await db.prepare(`SELECT 1 AS blocked WHERE ${moduleBlockers}`).bind(state.installationId, state.installationId, state.installationId).first() : null;
  if (blocker) {
    await db.prepare("UPDATE platform_modules SET cleanup_failure='retry-required' WHERE installation_id=? AND module_id=? AND generation=? AND phase IN ('retained','deleting')")
      .bind(state.installationId, state.moduleId, state.generation).run();
    return { status: "blocked" };
  }
  const token = crypto.randomUUID();
  try {
    if (!await start(db, state, token, now)) return { status: "idle" };
    const steps = stepsFor(state.moduleId);
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
