import { installationToday } from "./report-view.ts";

// Each module's reporting start date (operational baseline) is where its reports that use the baseline begin: Attendance's
// is attendance_reporting_starts_on, other modules' are in module_report_baselines. A date after today leaves those reports
// empty until it arrives, which is easy to set by mistake when the date is read as the end of a season or school year.

/** The field label, such as "Outreach reporting start date (operational baseline)". */
export const reportingStartLabel = (moduleLabel: string) => `${moduleLabel} reporting start date (operational baseline)`;

/** Help text for a module's reporting start date. Attendance's also sets where the Leaderboard begins. */
export function reportingStartHelp(moduleLabel: string): string {
  const reports = moduleLabel === "Attendance" ? "Attendance reports and the Leaderboard" : `${moduleLabel} reports`;
  return `${reports} that use the operational baseline count records from this date through today. Use it to leave out data from before you started using LancerLogin, for example the first day of this season. This is a start date, not an end date. Leave it blank to include all history.`;
}

/** A warning for a reporting start date after today in the installation's time zone, or undefined. */
export function futureReportingStartWarning(value: string | null | undefined, timeZone: string | undefined, moduleLabel: string, now = Date.now()): string | undefined {
  if (!value) return;
  const today = installationToday(timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone, now);
  return value > today ? `This date is in the future. ${moduleLabel} reports that use the operational baseline will show nothing until ${value}. To include records up to today, choose an earlier date or leave it blank.` : undefined;
}
