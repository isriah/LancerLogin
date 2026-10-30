import type { CleanupStep } from "./module-cleanup.ts";

/** Attendance retained-data cleanup. Step order is persisted as a cursor, so only append. */
export const attendanceCleanupSteps: readonly CleanupStep[] = [
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
];

/** In-flight Attendance delivery work that must drain before deletion. Binds the installation three times. */
export const attendanceCleanupBlocker = `EXISTS(SELECT 1 FROM integration_deliveries WHERE installation_id=? AND status='pending')
  OR EXISTS(SELECT 1 FROM google_calendar_operations WHERE installation_id=? AND status='pending')
  OR EXISTS(SELECT 1 FROM discord_calendar_operations WHERE installation_id=? AND (status='processing' OR julianday(lease_expires_at)>julianday('now')))`;
