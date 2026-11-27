import { inactivePeriodsUpdateSql } from "../member-participation.ts";
import { calendarRemovalStatements } from "../calendar-queue.ts";
import { createSessionCodec } from "../runtime-security.ts";
import { bootstrapClaimKey, setupResetCookie, setupResetGrantKey, setupResetGrantMs } from "../auth-protection.ts";
import { type D1Database, type D1Statement } from "../d1-usage.ts";
import { startCorrectionReset } from "../participation-start-correction.ts";
import { HttpError } from "../http-error.ts";
import { pauseRestoredTwoWayStatements } from "../discord-label-two-way.ts";
import { reconcileInstalledModules } from "../module-catalog.ts";
import { RESTORE_PART_MAX_BYTES, createRestoreSession, deleteTransferSession, loadStagedRestore, parseRestoreParts, restorePartMeta, restoreSessionResult, restoreSessionStatus, sessionGone, sha256Hex as transferDigest, stagedColumnValues, stagedCommitCleanup, stagedCommitGuards, stagedRowsInsert, storeRestorePart, validTransferSessionId } from "../data-transfer.ts";
import { estimateRestoreWrites } from "../../../../packages/shared/src/restore-writes.ts";
import { clearExternalModuleStatements, freshExternalModuleStatements, insertExternalModuleStatements, insertRowsStatements, ModuleRestoreRefusal } from "../module-backup.ts";
import { type BackupScope, type BackupTable, installationTables, installedExternalBackupModules, tableColumns, tablesForScope } from "./backup.ts";
import { type Env, type Principal, type Role, parseJson, randomToken, requireDatabase, requireRole, response, sessionCookie } from "./core.ts";
import { calendarRemovalTargets } from "./google-calendar.ts";
import { moduleRosterReferences } from "./module-runtime.ts";
import { type NormalizedBackup, normalizeBackup, normalizeStagedPart, stagedBackupTables } from "./restore-normalize.ts";


// Rows go in multi-row INSERT statements (insertRowsStatements), not one statement per row.
const insertBackupRows = (db: D1Database, table: BackupTable, rows: Record<string, unknown>[]) => insertRowsStatements(db, table, tableColumns[table], rows);
const upsertBackupMeetings = (db: D1Database, rows: Record<string, unknown>[]) => insertRowsStatements(db, "meetings", tableColumns.meetings, rows, meetingUpsertClause);

function freshAuthorityStatements(db: D1Database, tables: Record<BackupTable, Record<string, unknown>[]>): D1Statement[] {
  const administrationRevision = Number(tables.platform_module_administration_epochs[0]?.revision ?? 0);
  const statements: D1Statement[] = [
    db.prepare(`INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES('primary',?)
      ON CONFLICT(installation_id) DO UPDATE SET revision=MAX(platform_module_administration_epochs.revision,excluded.revision-1)+1`).bind(administrationRevision + 1),
  ];
  for (const row of tables.platform_module_epochs) statements.push(db.prepare(`INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES('primary',?,?)
    ON CONFLICT(installation_id,module_id) DO UPDATE SET generation=MAX(platform_module_epochs.generation,excluded.generation-1)+1`).bind(row.module_id, Number(row.generation) + 1));
  const assignmentEpochs = new Map(tables.platform_module_assignment_epochs.map((row) => [String(row.user_id), Number(row.revision)]));
  for (const row of tables.users) statements.push(db.prepare(`INSERT INTO platform_module_assignment_epochs(installation_id,user_id,revision) VALUES('primary',?,?)
    ON CONFLICT(installation_id,user_id) DO UPDATE SET revision=MAX(platform_module_assignment_epochs.revision,excluded.revision-1)+1`).bind(row.id, (assignmentEpochs.get(String(row.id)) ?? 0) + 1));
  return statements;
}

function restoredModuleStateStatements(db: D1Database, table: BackupTable, rows: Record<string, unknown>[]): D1Statement[] {
  if (table === "platform_module_administration") return rows.map((row) => db.prepare(`INSERT INTO platform_module_administration(installation_id,revision,selection_completed)
    SELECT 'primary',revision,? FROM platform_module_administration_epochs WHERE installation_id='primary'`).bind(row.selection_completed));
  if (table === "platform_modules") return rows.map((row) => db.prepare(`INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,disabled_at,delete_after,deletion_cursor,cleanup_failure)
    SELECT 'primary',?,?,generation,?,?,?,?,?,?,? FROM platform_module_epochs WHERE installation_id='primary' AND module_id=?`)
    .bind(row.module_id, row.contract_version, row.phase, row.setup_version, row.setup_complete, row.disabled_at, row.delete_after, row.deletion_cursor, row.cleanup_failure, row.module_id));
  if (table === "platform_module_assignment_revisions") return rows.map((row) => db.prepare(`INSERT INTO platform_module_assignment_revisions(installation_id,user_id,revision)
    SELECT 'primary',?,revision FROM platform_module_assignment_epochs WHERE installation_id='primary' AND user_id=?`).bind(row.user_id, row.user_id));
  return [];
}

// The restore is one all-or-nothing D1 batch. D1 limits how long, and how much memory, a batch may take; when a very large
// backup exceeds that, the batch is rolled back and nothing changes. Splitting the writes would lose that guarantee, so
// the Admin is told to restore a smaller category or use the documented D1 restore workflow instead
// (docs/BACKUP-RESTORE.md). A restore uploaded in parts (restoreSessions) keeps the guarantee: the parts are only staged,
// and the same single batch replaces the live rows from them.
const restoreLimitMessage = "This backup is too large to restore from the dashboard within the database's time limit. Nothing was changed. Restore one category at a time, or use the documented D1 restore workflow.";
const d1ResourceLimitError = (error: unknown) => error instanceof Error && /exceeded (?:its )?(?:timeout|cpu time limit|memory limit)|string or blob too big|sqlite_toobig/i.test(`${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`);
export async function restoreData(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); requireDatabase(env); const input = await parseJson<{ scope?: BackupScope; confirmation?: string; backup?: unknown; excludeModules?: unknown }>(request, 10_485_760); const scope = input.scope;
  if (!scope || !["meetings", "roster", "installation"].includes(scope)) throw new HttpError(400, "Restore scope must be meetings, roster, or installation");
  const expected = `RESTORE ${scope.toUpperCase()}`; if (input.confirmation !== expected) throw new HttpError(400, `Type ${expected} exactly to continue`);
  let backup: NormalizedBackup;
  try { backup = normalizeBackup(input.backup, scope, input.excludeModules); }
  catch (error) { if (error instanceof ModuleRestoreRefusal) return response(error.body, 409); throw error; }
  return applyRestore(env, principal, backup);
}

const meetingUpsertClause = ` ON CONFLICT(id) DO UPDATE SET ${tableColumns.meetings.filter((column) => column !== "id").map((column) => `${column} = excluded.${column}`).join(", ")}`;
/**
 * Schema 1 check-outs for attendance events that were uploaded in parts: each member's latest scan of a meeting, the
 * earliest-listed one when several share that time, also closes their attendance, as normalizeBackup adds for events the
 * document carries. Runs right after the staged events are inserted, when the table holds exactly the backup's events.
 * The `+` on o.installation_id keeps the inner lookup on the member and meeting index (two rows a lookup); without it, a
 * database with no statistics reads every scan the member ever made for each event.
 */
const legacyCheckoutStatement = (db: D1Database) => db.prepare(`INSERT INTO attendance_events (id, installation_id, member_id, meeting_id, source, occurred_at, kiosk_event_id, created_by, action)
  SELECT 'legacy-restore-checkout:' || e.member_id || ':' || e.meeting_id, e.installation_id, e.member_id, e.meeting_id, 'manual', e.occurred_at, NULL, e.created_by, 'check_out'
  FROM attendance_events e WHERE e.installation_id = 'primary' AND e.meeting_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attendance_events o
    WHERE +o.installation_id = e.installation_id AND o.member_id = e.member_id AND o.meeting_id = e.meeting_id AND (o.occurred_at > e.occurred_at OR o.occurred_at = e.occurred_at AND o.rowid < e.rowid))`);

/**
 * Replace the live rows with a checked backup, in one all-or-nothing batch. `staged` names a restore session whose large
 * tables wait in staging (backup.source.staged): those tables are copied into place by D1 itself inside the same batch,
 * which also removes the staged parts, so this request costs the same Worker CPU whatever the backup's size.
 */
async function applyRestore(env: Env, principal: Principal, backup: NormalizedBackup, staged?: { id: string; paused: number }): Promise<Response> {
  const db = requireDatabase(env); const scope = backup.scope; const tables = backup.tables;
  const stagedTables: ReadonlySet<BackupTable> = new Set(staged ? backup.source.staged : []);
  const insertRows = (table: BackupTable) => stagedTables.has(table) ? [stagedRowsInsert(db, staged!.id, table, tableColumns[table]), ...(table === "attendance_events" && backup.source.schemaVersion === 1 ? [legacyCheckoutStatement(db)] : [])] : insertBackupRows(db, table, tables[table]);
  const upsertMeetings = () => stagedTables.has("meetings") ? [stagedRowsInsert(db, staged!.id, "meetings", tableColumns.meetings, meetingUpsertClause)] : upsertBackupMeetings(db, tables.meetings);
  // Excluded modules restore absent: their rows were removed from every module-keyed Core table and their section is skipped.
  const excludedModules = backup.externalModules.excluded.map(({ id, label, status, requiredBackupVersion, source, commit, rows }) => ({ id, label, status, backupVersion: requiredBackupVersion, source, commit, rows }));
  let statements: D1Statement[];
  // An installation restore recreates every account. The backup carries no session epoch, and must not: restoring the
  // exported value, or the column default of 0, would lower an epoch, so a session revoked by signing out, a password
  // reset or deactivation would work again until its cookie expired. Every restored account instead gets an epoch no
  // cookie can hold: the time of the restore in milliseconds times 1,000. An epoch otherwise only grows by one per
  // revocation, from 0 or from an earlier restore's value, so a later restore is always above it (the factor leaves room
  // for a thousand revocations per millisecond between two restores). This ends every existing session of every account.
  // The Admin making the restore then gets a cookie for the new epoch (below), with the same expiry, and stays signed in.
  const restoredSessionEpoch = Date.now() * 1000;
  // Meetings that survive by ID are updated in place rather than deleted and reinserted, so live Google Calendar and Discord
  // event mappings (operational state, not portable backup data) keep linking them to their external events. Only meetings
  // absent from the backup are deleted, and their mappings cascade away; the response reports how many external events
  // were detached that way.
  const restoredMeetingIds = scope === "meetings" && stagedTables.has("meetings") ? await stagedColumnValues(db, staged!.id, "meetings", tableColumns.meetings.indexOf("id")) : JSON.stringify(tables.meetings.map((row) => row.id));
  const detachedCalendarEvents = scope === "meetings" ? Number((await db.prepare(`SELECT (SELECT COUNT(*) FROM google_calendar_event_mappings WHERE installation_id = 'primary' AND active = 1 AND meeting_id NOT IN (SELECT value FROM json_each(?1)))
    + (SELECT COUNT(*) FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND active = 1 AND event_id IS NOT NULL AND meeting_id NOT IN (SELECT value FROM json_each(?1))) AS n`).bind(restoredMeetingIds).first<{ n: number }>())?.n ?? 0) : 0;
  const recovery = { ...backup.recovery, pausedProviderOperations: backup.recovery.pausedProviderOperations + (staged?.paused ?? 0), ...(scope === "meetings" ? { detachedCalendarEvents } : {}) };
  // Those detached events are recorded for the calendar jobs to delete, as Delete attendance data records them, before
  // the meetings that are not in the backup go.
  if (scope === "meetings") statements = [
    ...calendarRemovalStatements(db, new Date().toISOString(), await calendarRemovalTargets(env), { keep: restoredMeetingIds }),
    db.prepare("DELETE FROM discord_anomaly_reports WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_contests WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_recipients WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_notifications WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_corrections WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_events WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meeting_audience_labels WHERE installation_id = 'primary'"),
    db.prepare("DELETE FROM meetings WHERE installation_id = 'primary' AND id NOT IN (SELECT value FROM json_each(?))").bind(restoredMeetingIds), db.prepare("UPDATE meetings SET weight_category_id = NULL WHERE installation_id = 'primary' AND weight_category_id IS NOT NULL"),
    db.prepare("DELETE FROM meeting_templates WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meeting_weight_categories WHERE installation_id = 'primary'"),
    ...insertRows("meeting_weight_categories"), ...upsertMeetings(), ...insertRows("meeting_audience_labels"), ...insertRows("meeting_templates"), ...insertRows("attendance_events"), ...insertRows("attendance_corrections"), ...insertRows("discord_attendance_notifications"), ...insertRows("discord_attendance_recipients"), ...insertRows("discord_attendance_contests"), ...insertRows("discord_anomaly_reports"),
  ];
  else if (scope === "roster") statements = [
    db.prepare(`UPDATE members SET inactive_periods_json = ${inactivePeriodsUpdateSql("0")}, active = 0 WHERE installation_id = 'primary' AND external_id NOT IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(tables.members.map(row => row.external_id))),
    ...tables.members.map((row) => db.prepare("INSERT INTO members (id, installation_id, external_id, first_name, last_name, email, discord_user_id, active, created_at, attendance_required_from, inactive_periods_json) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, external_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email, discord_user_id = excluded.discord_user_id, active = excluded.active, attendance_required_from = excluded.attendance_required_from, inactive_periods_json = excluded.inactive_periods_json").bind(row.id, row.external_id, row.first_name, row.last_name, row.email, row.discord_user_id, row.active, row.created_at, row.attendance_required_from, row.inactive_periods_json)),
    db.prepare("DELETE FROM member_label_changes WHERE installation_id = 'primary'"), db.prepare("DELETE FROM label_attendance_rules WHERE installation_id = 'primary'"), db.prepare("DELETE FROM label_weekly_targets WHERE installation_id = 'primary'"), db.prepare("UPDATE member_labels SET active = 0 WHERE installation_id = 'primary'"),
    ...tables.member_labels.map((row) => db.prepare("INSERT INTO member_labels (id, installation_id, name, active, formula_enabled, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = excluded.active, formula_enabled = excluded.formula_enabled").bind(row.id, row.name, row.active, row.formula_enabled, row.created_by, row.created_at)),
    ...insertRows("member_label_changes"), ...insertRows("label_weekly_targets"), ...insertRows("label_attendance_rules"), db.prepare("DELETE FROM discord_label_role_mappings WHERE installation_id = 'primary' AND label_id IN (SELECT id FROM member_labels WHERE installation_id = 'primary' AND active = 0)"), ...pauseRestoredTwoWayStatements(db), db.prepare("UPDATE discord_label_role_jobs SET status = 'stale', lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE installation_id = 'primary' AND status IN ('pending', 'running')").bind(new Date().toISOString(), new Date().toISOString()), db.prepare("UPDATE organization_settings SET attendance_recent_days = ?, attendance_policy_activated_on = ? WHERE installation_id = 'primary'").bind(backup.attendanceRecentDays, backup.attendancePolicyActivatedOn),
  ];
  else {
    // Installed plugin tables may not cascade from Core rows, so clear them child-first before Core deletion.
    // The scan check records (fingerprint match scores, accepted kiosk scans and possible wrong matches; migrations 0084 and
    // 0088) have no foreign key to the installation, so nothing cascades to them. They describe kiosk scans of the state
    // being replaced and are not in a backup, so they are cleared here, as Delete installation clears them. The minimum
    // match score (kiosk_fingerprint_match_settings) is a setting no backup carries; it is kept, so a restore never lowers it.
    statements = [...freshAuthorityStatements(db, tables), ...clearExternalModuleStatements(db, installedExternalBackupModules), ...["kiosk_scan_matches", "kiosk_accepted_scans", "kiosk_possible_wrong_matches"].map((table) => db.prepare(`DELETE FROM ${table} WHERE installation_id = 'primary'`)), db.prepare("DELETE FROM installations WHERE id = 'primary'")];
    const authorityTables = new Set<BackupTable>(["platform_module_administration_epochs", "platform_module_epochs", "platform_module_assignment_epochs"]);
    const restoredStateTables = new Set<BackupTable>(["platform_module_administration", "platform_modules", "platform_module_assignment_revisions"]);
    for (const table of installationTables) {
      if (authorityTables.has(table)) continue;
      if (table === "member_labels" && backup.schemaVersion >= 14) statements.push(db.prepare("DELETE FROM member_labels WHERE installation_id = 'primary'"));
      statements.push(...(restoredStateTables.has(table) ? restoredModuleStateStatements(db, table, tables[table]) : table === "users" ? insertRowsStatements(db, "users", [...tableColumns.users, "session_epoch"], tables.users.map((row) => ({ ...row, session_epoch: restoredSessionEpoch }))) : insertRows(table)));
      // Two-way labels restore paused, in the same batch, so no scheduled pass ever sees them syncing.
      if (table === "discord_label_role_mappings") statements.push(...pauseRestoredTwoWayStatements(db));
    }
    const restoredModules = new Set(tables.platform_modules.map((row) => String(row.module_id)));
    statements.push(...freshExternalModuleStatements(db, installedExternalBackupModules.filter(({ definition }) => !restoredModules.has(definition.id)), new Date().toISOString()), ...insertExternalModuleStatements(db, backup.externalModules.included));
  }
  // A restore that replaces members brings back the backup's participation start dates, so their one-time correction
  // starts again under a new run (participation-start-correction.ts), after the installation row is back.
  if (scope !== "meetings") statements.push(startCorrectionReset(db));
  const actorRestored = scope !== "installation" || tables.users.some((row) => row.id === principal.userId); const now = new Date().toISOString(); statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'data.backup_restored', 'installation', 'primary', ?, ?)").bind(crypto.randomUUID(), actorRestored ? principal.userId : null, JSON.stringify({ scope, schemaVersion: backup.schemaVersion, exportedAt: backup.exportedAt, recovery, ...(excludedModules.length ? { excludedModules } : {}) }), now));
  const answer = { restored: true, scope, recovery, ...(excludedModules.length ? { excludedModules } : {}) };
  // The report revision triggers (migration 0037) add one to a counter for every row of nine tables that is inserted,
  // changed or removed: a written row each, an eighth of what a restored scan costs. All the counter has to do is change,
  // so the batch sets the triggers aside, adds one to it, and puts them back exactly as the schema had them. It is one
  // transaction: a batch that fails leaves the triggers as they were. Without the schema read, the triggers simply fire.
  const triggers = await reportRevisionTriggers(db);
  if (triggers.length) statements = [...triggers.map((trigger) => db.prepare(`DROP TRIGGER ${trigger.name}`)), ...statements, ...triggers.map((trigger) => db.prepare(trigger.sql)), db.prepare("UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = 'primary'")];
  // A staged restore's batch starts with its guards and ends by removing the staged parts and recording the answer: one
  // transaction with the restore.
  if (staged) statements = [...stagedCommitGuards(db, staged.id), ...statements, ...stagedCommitCleanup(db, staged.id, answer)];
  try { await db.batch(statements); }
  catch (error) {
    if (d1ResourceLimitError(error)) throw new HttpError(503, restoreLimitMessage);
    if (staged) {
      // A request racing this one may have completed the restore, or the session may be gone; otherwise a guard stopped the batch.
      let recorded: Record<string, unknown> | undefined | null; try { recorded = await restoreSessionResult(db, staged.id); } catch { /* The original failure is reported. */ }
      if (recorded) return response(recorded);
      if (recorded === null) throw sessionGone("restore");
      const message = error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}` : "";
      if (/data_transfer_chunks/.test(message)) throw new HttpError(409, "Part of the backup has not been uploaded. Nothing was changed.", undefined, "restore_incomplete");
    }
    throw error;
  }
  // An installation restore recreates the installation row, which cascades away the installed-module catalog. Record it again
  // now, so backups keep plugin sources and removed code stays deletable; a failure retries on the next scheduled pass.
  if (scope === "installation") { try { await reconcileInstalledModules(db); } catch { /* Retried by the scheduled pass. */ } }
  // The restoring Admin stays signed in when the backup holds their account as an active one: the same session (its
  // expiry and sign-in time unchanged) under the new epoch. Otherwise their next request asks them to sign in with an
  // account from the backup, as every other signed-in person's does.
  const restoredActor = scope === "installation" ? tables.users.find((row) => row.id === principal.userId && Number(row.active) === 1 && (row.role === "admin" || row.role === "operator")) : undefined;
  const session = restoredActor && env.SESSION_KEY ? sessionCookie(await createSessionCodec(env.SESSION_KEY).reissue({ ...principal, role: restoredActor.role as Role, epoch: restoredSessionEpoch }), Math.max(1, Math.ceil((principal.expiresAt - Date.now()) / 1000))) : undefined;
  return response(answer, 200, session ? { "set-cookie": session } : undefined);
}

/** The report revision triggers as the schema defines them, or none when the schema cannot be read. Queries: one. */
async function reportRevisionTriggers(db: D1Database): Promise<{ name: string; sql: string }[]> {
  try {
    const rows = (await db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'report_revision_%' ORDER BY name").all<{ name: string; sql: string }>()).results ?? [];
    return rows.every((row) => /^report_revision_[a-z_]+$/.test(row.name) && typeof row.sql === "string" && /^CREATE TRIGGER report_revision_/.test(row.sql)) ? rows : [];
  } catch { return []; }
}

/**
 * Restore in parts, for a backup too large to read and check in one request (data-transfer.ts). Every request but the
 * last only stages rows; the last one runs the same all-or-nothing batch as a single-request restore. A restore that
 * fails, is cancelled or is abandoned before that batch commits leaves the installation exactly as it was.
 * - POST   /admin/data/restore/sessions                  { scope, confirmation, document, parts, excludeModules? }: checks the
 *                                                        backup document (every check of the single-request restore that does
 *                                                        not need the rows sent in parts) and stages it; 409 refusals as before
 * - PUT    /admin/data/restore/sessions/:id/parts/:seq   one part: a JSON array of rows of the table it was declared for
 * - GET    /admin/data/restore/sessions/:id              which parts have not arrived
 * - POST   /admin/data/restore/sessions/:id/commit       { confirmation, digest }: checks the document again and replaces the data
 * - DELETE /admin/data/restore/sessions/:id              cancel; staged parts are removed
 * Queries per request, after the session check: starting one batch, a part two, the commit as a single-request restore plus one.
 */
export async function restoreSessions(request: Request, env: Env, pathname: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const match = /^\/admin\/data\/restore\/sessions(?:\/([^/]+)(?:\/(parts\/\d{1,6}|commit))?)?$/.exec(pathname); const id = match?.[1]; const action = match?.[2];
  if (!match || id !== undefined && !validTransferSessionId(id)) return response({ error: "Not found" }, 404);
  const confirmed = (scope: BackupScope, confirmation: unknown) => { const expected = `RESTORE ${scope.toUpperCase()}`; if (confirmation !== expected) throw new HttpError(400, `Type ${expected} exactly to continue`); };
  const stagedCounts = (counts: Record<string, number>) => new Map(Object.entries(counts)) as Map<BackupTable, number>;
  if (id === undefined) {
    if (request.method !== "POST") return response({ error: "Not found" }, 404);
    // The document is the backup with its staged tables emptied, so this body stays small however much the backup holds;
    // the limit is the single-request restore's, for backups whose other tables or plugin sections are that large.
    const input = await parseJson<{ scope?: BackupScope; confirmation?: string; document?: unknown; parts?: unknown; excludeModules?: unknown }>(request, 11_534_336); const scope = input.scope;
    if (!scope || !["meetings", "roster", "installation"].includes(scope)) throw new HttpError(400, "Restore scope must be meetings, roster, or installation");
    confirmed(scope, input.confirmation);
    if (typeof input.document !== "string") throw new HttpError(400, "The restore must include the backup document");
    let document: unknown; try { document = JSON.parse(input.document); } catch { throw new HttpError(400, "The selected backup is not valid JSON"); }
    const parts = parseRestoreParts(input.parts, stagedBackupTables); const counts: Record<string, number> = {};
    for (const part of parts) counts[part.table] = (counts[part.table] ?? 0) + part.rows;
    let backup: NormalizedBackup;
    try { backup = normalizeBackup(document, scope, input.excludeModules, stagedCounts(counts)); }
    catch (error) { if (error instanceof ModuleRestoreRefusal) return response(error.body, 409); throw error; }
    // A table this backup's schema never had is not read from the file, so its parts are not uploaded either.
    const needed = parts.filter((part) => backup.source.staged.includes(part.table as BackupTable));
    const context = { excludeModules: input.excludeModules ?? null, counts, staged: backup.source.staged, source: { schemaVersion: backup.source.schemaVersion, community22: backup.source.community22, exactColumns: backup.source.exactColumns, exportedAt: backup.exportedAt } };
    const session = await createRestoreSession(db, { userId: principal.userId, scope, document: input.document, parts: needed, context });
    // Rows the final batch will write, for the dashboard's warning about D1's daily allowance (restore-writes.ts).
    const records: Record<string, number> = {};
    for (const table of tablesForScope(scope)) records[table] = backup.source.staged.includes(table) ? counts[table] ?? 0 : backup.tables[table].length;
    for (const module of backup.externalModules.included) for (const [table, rows] of Object.entries(module.tables)) records[table] = (records[table] ?? 0) + rows.length;
    return response({ id: session.id, expiresAt: session.expiresAt, digest: session.digest, parts: needed.map((part) => part.seq), estimatedRowsWritten: estimateRestoreWrites(records) }, 201);
  }
  if (action === undefined && request.method === "GET") return response(await restoreSessionStatus(db, id, principal.userId));
  if (action === undefined && request.method === "DELETE") { await deleteTransferSession(db, "restore", id, principal.userId); return response({ cancelled: true }); }
  if (action?.startsWith("parts/") && request.method === "PUT") {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
    if (Number(request.headers.get("content-length") ?? 0) > RESTORE_PART_MAX_BYTES) throw new HttpError(413, "Request body is too large");
    const bytes = await request.arrayBuffer(); const seq = Number(action.slice(6));
    if (bytes.byteLength > RESTORE_PART_MAX_BYTES) throw new HttpError(413, "Request body is too large");
    const part = await restorePartMeta(db, id, principal.userId, seq);
    // The bytes must be the ones declared when the restore started: a part that was changed or damaged on the way, or
    // belongs to another file, is refused before it is read.
    if (await transferDigest(bytes) !== part.sha256) throw new HttpError(409, "A part of the backup did not arrive as it was sent. Nothing was changed.", undefined, "restore_part_mismatch");
    let rows: unknown; try { rows = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, "Request body must be valid JSON"); }
    if (!Array.isArray(rows) || rows.length !== part.rows) throw new HttpError(400, `Backup table ${part.table} does not hold the rows its part declared`);
    const normalized = normalizeStagedPart(part.table as BackupTable, rows, part.context.source as { schemaVersion: number; community22: boolean; exactColumns: boolean; exportedAt: unknown });
    await storeRestorePart(db, id, seq, normalized.payload, normalized.paused);
    return response({ received: seq });
  }
  if (action === "commit" && request.method === "POST") {
    const input = await parseJson<{ confirmation?: string; digest?: string }>(request);
    const staged = await loadStagedRestore(db, id, principal.userId); const scope = staged.scope as BackupScope;
    confirmed(scope, input.confirmation);
    // The restore already completed: this is its final request sent again, answered as the first was, without running twice.
    if (staged.result) return response(staged.result);
    if (input.digest !== staged.digest) throw new HttpError(409, "This is not the restore that was prepared. Nothing was changed. Start the restore again.", undefined, "restore_digest_mismatch");
    if (staged.missing) throw new HttpError(409, `${staged.missing} ${staged.missing === 1 ? "part of the backup has" : "parts of the backup have"} not been uploaded. Nothing was changed.`, undefined, "restore_incomplete", { missing: staged.missing });
    const context = staged.context as { excludeModules: unknown; counts: Record<string, number>; staged: BackupTable[] };
    // Every check of the document runs again on the stored copy, against the modules installed now.
    let backup: NormalizedBackup;
    try { backup = normalizeBackup(JSON.parse(staged.document), scope, context.excludeModules ?? undefined, stagedCounts(context.counts)); }
    catch (error) { if (error instanceof ModuleRestoreRefusal) return response(error.body, 409); throw error; }
    if (backup.source.staged.join() !== context.staged.join()) throw new HttpError(409, "The application changed while this restore was being uploaded. Nothing was changed. Start the restore again.", undefined, "restore_stale");
    return applyRestore(env, principal, backup, { id, paused: staged.paused });
  }
  return response({ error: "Not found" }, 404);
}

/** Parts staged for a backup or a restore hold rows of the data being deleted, so every deletion removes them with it. */
const stagedTransfersRemoval = (db: D1Database) => db.prepare("DELETE FROM data_transfer_sessions");

export async function deleteData(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ scope?: "attendance" | "roster" | "installation"; confirmation?: string }>(request);
  const expected = input.scope === "attendance" ? "DELETE ATTENDANCE" : input.scope === "roster" ? "DELETE ROSTER" : input.scope === "installation" ? "DELETE INSTALLATION" : undefined;
  if (!expected || input.confirmation !== expected) throw new HttpError(400, `Type ${expected ?? "a valid confirmation"} exactly to continue`);
  const setupResetGrant = input.scope === "installation" && env.BOOTSTRAP_CODE_HASH ? await recordInstallationDeletion(db, env.BOOTSTRAP_CODE_HASH) : undefined;
  let calendarRemovals: number | undefined;
  if (input.scope === "attendance") {
    // Deleting the meetings takes their calendar mappings and queued operations with them, so the remote events that may
    // still exist are recorded first, in the same batch, for the calendar jobs to delete.
    const now = new Date().toISOString(); const removals = calendarRemovalStatements(db, now, await calendarRemovalTargets(env));
    const deletion = [
    db.prepare("DELETE FROM discord_anomaly_reports WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_contests WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_recipients WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_notifications WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_corrections WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_events WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meetings WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meeting_templates WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meeting_weight_categories WHERE installation_id = 'primary'"),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, created_at) VALUES (?, 'primary', ?, 'data.attendance_deleted', 'installation', ?)").bind(crypto.randomUUID(), principal.userId, now),
    ];
    calendarRemovals = (await db.batch([...removals, ...deletion, stagedTransfersRemoval(db)])).slice(0, removals.length).reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
  }
  else if (input.scope === "roster") {
    const modules = moduleRosterReferences();
    const references = await db.prepare(`SELECT COUNT(*) AS count FROM members m WHERE m.installation_id = 'primary' AND (EXISTS (SELECT 1 FROM attendance_events e WHERE e.member_id = m.id) OR EXISTS (SELECT 1 FROM attendance_corrections c WHERE c.member_id = m.id) OR EXISTS (SELECT 1 FROM discord_attendance_contests d WHERE d.member_id = m.id)${modules.columns.map(({ table, column }) => ` OR EXISTS (SELECT 1 FROM ${table} h WHERE h.installation_id = m.installation_id AND h.${column} = m.id)`).join("")})`).first<{ count: number }>();
    if (Number(references?.count ?? 0) > 0) throw new HttpError(409, `Delete ${["Attendance", ...modules.labels].join(" and ")} participation first so historical records do not lose their roster references`);
    await db.batch([stagedTransfersRemoval(db), db.prepare("UPDATE users SET member_id = NULL WHERE installation_id = 'primary' AND member_id IS NOT NULL"), db.prepare("DELETE FROM members WHERE installation_id = 'primary'"), db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, created_at) VALUES (?, 'primary', ?, 'data.roster_deleted', 'installation', ?)").bind(crypto.randomUUID(), principal.userId, new Date().toISOString())]);
  }
  // Installed plugin tables may not cascade from the installation row, so clear them child-first in the same batch, as an
  // installation restore does; otherwise a later first-Admin setup would inherit the deleted installation's plugin data.
  // The fingerprint match and scan integrity tables (migrations 0084 and 0088) have no foreign key to the installation
  // either, so nothing cascades to them and they are deleted here. Neither do backup and restore sessions: parts staged
  // for one hold the installation's rows, so they go too rather than wait for the clean-up.
  else await db.batch([stagedTransfersRemoval(db), ...clearExternalModuleStatements(db, installedExternalBackupModules), ...["kiosk_scan_matches", "kiosk_fingerprint_match_settings", "kiosk_accepted_scans", "kiosk_possible_wrong_matches"].map((table) => db.prepare(`DELETE FROM ${table} WHERE installation_id = 'primary'`)), db.prepare("DELETE FROM installations WHERE id = 'primary'")]);
  return response({ deleted: true, scope: input.scope, ...(calendarRemovals === undefined ? {} : { calendarEventRemovalsQueued: calendarRemovals }) }, 200, setupResetGrant ? { "set-cookie": `${setupResetCookie}=${setupResetGrant}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${setupResetGrantMs / 1000}` } : undefined);
}
/**
 * Before the installation is deleted, mark the current setup code as used (installations created before this check
 * recorded no claim), and grant the deleting Admin's browser one setup retry with the same code.
 */
async function recordInstallationDeletion(db: D1Database, codeHash: string): Promise<string> {
  const grant = randomToken(); const now = Date.now();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO bootstrap_code_claims (claim_key, claimed_at) VALUES (?, ?)").bind(await bootstrapClaimKey(codeHash), new Date(now).toISOString()),
    db.prepare("INSERT INTO bootstrap_reset_grants (grant_key, expires_at) VALUES (?, ?)").bind(await setupResetGrantKey(grant), new Date(now + setupResetGrantMs).toISOString()),
  ]);
  return grant;
}
