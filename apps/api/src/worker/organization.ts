import { MAX_ANOMALY_THRESHOLD_MINUTES } from "../attendance-lifecycle.ts";
import { assertAllowanceChangeKeepsMeetingsApart, attendanceAllowances, saveAllowancesKeepingMeetingsApart, validEarlyScanMinutes, validLateScanMinutes, type AttendanceAllowances } from "../attendance-allowances.ts";
import { HttpError } from "../http-error.ts";
import { type BrandingInput, type Env, auditStatement, parseJson, requireDatabase, requireRole, response, validColor, validLogoData } from "./core.ts";


export async function branding(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") {
    const settings = await db.prepare("SELECT organization_name AS organizationName, subtitle, logo_data AS logoData, primary_color AS primaryColor, secondary_color AS secondaryColor, appearance, time_zone AS timeZone, logo_backdrop AS logoBackdrop, late_scan_minutes AS lateScanMinutes, early_scan_minutes AS earlyScanMinutes, discord_contest_window_hours AS discordContestWindowHours, attendance_reporting_starts_on AS attendanceReportingStartsOn, anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes, anomaly_early_threshold_minutes AS anomalyEarlyThresholdMinutes FROM organization_settings WHERE installation_id = 'primary'").first();
    return response({ settings });
  }
  const input = await parseJson<BrandingInput>(request); const errors: string[] = [];
  if (!input.organizationName?.trim() || input.organizationName.trim().length > 100) errors.push("Organization name is required and must be at most 100 characters");
  if (input.subtitle && input.subtitle.length > 140) errors.push("Subtitle must be at most 140 characters");
  if (input.logoData && !validLogoData(input.logoData)) errors.push("Logo must be a PNG, JPEG, or WebP image no larger than 128 KiB");
  if (!input.primaryColor || !validColor(input.primaryColor) || !input.secondaryColor || !validColor(input.secondaryColor)) errors.push("Brand colors must use six-digit hex values");
  if (!input.appearance || !["system", "themed", "light", "dark"].includes(input.appearance)) errors.push("Appearance must be themed, light, dark, or follow the device");
  if (!input.logoBackdrop || !["auto", "light", "dark", "none"].includes(input.logoBackdrop)) errors.push("Logo background must be automatic, light, dark, or none");
  if (!validLateScanMinutes(input.lateScanMinutes)) errors.push("Late scan window must be from 0 to 180 minutes");
  // Optional, so a client that predates the early arrival allowance keeps the saved value.
  if (input.earlyScanMinutes !== undefined && !validEarlyScanMinutes(input.earlyScanMinutes)) errors.push("Early arrival allowance must be from 0 to 180 minutes");
  if (!Number.isInteger(input.discordContestWindowHours) || input.discordContestWindowHours! < 1 || input.discordContestWindowHours! > 168) errors.push("Discord contest window must be from 1 to 168 hours");
  if (input.anomalyLateThresholdMinutes !== undefined && (!Number.isInteger(input.anomalyLateThresholdMinutes) || input.anomalyLateThresholdMinutes < 0 || input.anomalyLateThresholdMinutes > MAX_ANOMALY_THRESHOLD_MINUTES)) errors.push("Late-arrival threshold must be from 0 to 1440 minutes");
  if (input.anomalyEarlyThresholdMinutes !== undefined && (!Number.isInteger(input.anomalyEarlyThresholdMinutes) || input.anomalyEarlyThresholdMinutes < 0 || input.anomalyEarlyThresholdMinutes > MAX_ANOMALY_THRESHOLD_MINUTES)) errors.push("Early-departure threshold must be from 0 to 1440 minutes");
  if (input.attendanceReportingStartsOn !== undefined && input.attendanceReportingStartsOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.attendanceReportingStartsOn)) errors.push("Attendance reporting baseline must be YYYY-MM-DD");
  if (errors.length) throw new HttpError(400, "Invalid branding", errors);
  // Only a longer early arrival or late scan allowance can make meetings overlap, so other branding saves skip reading meetings.
  const current = attendanceAllowances(await db.prepare("SELECT late_scan_minutes AS lateScanMinutes, early_scan_minutes AS earlyScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<Partial<AttendanceAllowances>>());
  await assertAllowanceChangeKeepsMeetingsApart(db, current, { lateScanMinutes: input.lateScanMinutes!, earlyScanMinutes: input.earlyScanMinutes ?? current.earlyScanMinutes });
  // The check is repeated in the batch, so a meeting saved since it, which these allowances would make overlap, refuses the save.
  await saveAllowancesKeepingMeetingsApart(db, { lateScanMinutes: input.lateScanMinutes!, earlyScanMinutes: input.earlyScanMinutes ?? null }, [
    db.prepare("UPDATE organization_settings SET organization_name = ?, subtitle = ?, logo_data = ?, primary_color = ?, secondary_color = ?, appearance = ?, logo_backdrop = ?, late_scan_minutes = ?, early_scan_minutes = COALESCE(?, early_scan_minutes), discord_contest_window_hours = ?, attendance_reporting_starts_on = ?, anomaly_late_threshold_minutes = COALESCE(?, anomaly_late_threshold_minutes), anomaly_early_threshold_minutes = COALESCE(?, anomaly_early_threshold_minutes) WHERE installation_id = 'primary'")
      .bind(input.organizationName!.trim(), input.subtitle?.trim() || null, input.logoData || null, input.primaryColor!.toLowerCase(), input.secondaryColor!.toLowerCase(), input.appearance === "themed" ? "system" : input.appearance, input.logoBackdrop, input.lateScanMinutes, input.earlyScanMinutes ?? null, input.discordContestWindowHours, input.attendanceReportingStartsOn || null, input.anomalyLateThresholdMinutes ?? null, input.anomalyEarlyThresholdMinutes ?? null),
    auditStatement(db, principal, "branding.updated", "organization_settings", "primary", { lateScanMinutes: input.lateScanMinutes, earlyScanMinutes: input.earlyScanMinutes ?? current.earlyScanMinutes, attendanceReportingStartsOn: input.attendanceReportingStartsOn || null, anomalyLateThresholdMinutes: input.anomalyLateThresholdMinutes, anomalyEarlyThresholdMinutes: input.anomalyEarlyThresholdMinutes }),
  ]); return response({ ok: true });
}

// Compatibility endpoint for older authenticated clients. No consent writes or reports.
export async function privacySettings(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  if (request.method === "PATCH") await parseJson<{ telemetryAccepted?: boolean }>(request);
  return response({ telemetryAccepted: false, acceptedAt: null, notice: "Anonymous usage reporting has been retired. No telemetry is collected or transmitted." });
}
