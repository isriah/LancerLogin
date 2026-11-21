import type { CleanupStep } from "./module-cleanup.ts";

/** Attendance retained-data cleanup. Step order is persisted as a cursor, so only append. */
export const attendanceCleanupSteps: readonly CleanupStep[] = [
  { kind: "delete", table: "kiosk_commands" },
  // Was simulated_kiosk_sessions, dropped in migration 0092. A repeat of kiosk_commands, already empty here, keeps a
  // persisted cursor's meaning.
  { kind: "delete", table: "kiosk_commands" },
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
  { kind: "reset", table: "organization_settings", pending: `late_scan_minutes<>30 OR discord_block_recontests_after_rejection<>0 OR discord_contest_window_hours<>24 OR discord_channel_manager_enabled<>0
      OR attendance_reporting_starts_on IS NOT NULL OR anomaly_late_threshold_minutes<>10 OR anomaly_early_threshold_minutes<>10
      OR discord_anomaly_reports_enabled<>0 OR discord_anomaly_report_channel_id IS NOT NULL OR discord_anomaly_reports_enabled_at IS NOT NULL
      OR attendance_recent_days<>30 OR attendance_policy_activated_on IS NOT NULL OR kiosk_authentication_method<>'fingerprint'`, set: `late_scan_minutes=30,discord_block_recontests_after_rejection=0,discord_contest_window_hours=24,
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
  { kind: "delete", table: "kiosk_enrollment_sessions" },
  { kind: "delete", table: "kiosk_fingerprint_vault_enrollments" },
  { kind: "delete", table: "kiosk_fingerprint_vault_retirements" },
  { kind: "delete", table: "kiosk_scan_reviews" },
  { kind: "delete", table: "kiosk_scan_matches" },
  { kind: "delete", table: "kiosk_fingerprint_match_settings" },
  { kind: "delete", table: "kiosk_accepted_scans" },
  { kind: "delete", table: "kiosk_possible_wrong_matches" },
  { kind: "delete", table: "kiosk_fingerprint_reenrollment" },
  // Member PINs exist only for kiosks that require one (migration 0091).
  { kind: "delete", table: "pin_setup_requests" },
  { kind: "delete", table: "member_pins" },
  { kind: "reset", table: "organization_settings", pending: "pin_lockout_enabled<>0 OR pin_lockout_attempts<>5 OR pin_lockout_minutes<>15", set: "pin_lockout_enabled=0,pin_lockout_attempts=5,pin_lockout_minutes=15", bindings: [] },
  // The early arrival allowance (migration 0099) returns to its 15-minute default.
  { kind: "reset", table: "organization_settings", pending: "early_scan_minutes<>15", set: "early_scan_minutes=15", bindings: [] },
  // Discord kiosk codes (migration 0100) are for Attendance kiosks only.
  { kind: "delete", table: "discord_kiosk_codes" },
  // Report ids for offline wrong-PIN reports (migration 0101) belong to Attendance kiosks.
  { kind: "delete", table: "kiosk_pin_failure_reports" },
  // Calendar events recorded for removal (migration 0103) cannot be reached once the module's data is gone and its jobs
  // no longer run: those still waiting are set aside, so the integration cards stop counting them as waiting.
  { kind: "reset", table: "calendar_event_removals", pending: "next_attempt_at IS NOT NULL", set: "next_attempt_at=NULL,last_error='Attendance was removed before this event could be deleted.'", bindings: [] },
];

/**
 * Attendance delivery work that is being sent this moment and must finish before deletion: an email in progress, or a
 * Discord calendar operation whose delivery holds its lease. Queued calendar operations do not block: they are deleted
 * with the rest, and the remote events their deletes were for were recorded in calendar_event_removals when the module
 * was disabled. The clean-up sets those removals aside; Sync all, after Attendance is set up again, makes them due.
 * Binds the installation twice.
 */
export const attendanceCleanupBlocker = `EXISTS(SELECT 1 FROM integration_deliveries WHERE installation_id=? AND status='pending')
  OR EXISTS(SELECT 1 FROM discord_calendar_operations WHERE installation_id=? AND status='processing' AND julianday(lease_expires_at)>julianday('now'))`;
