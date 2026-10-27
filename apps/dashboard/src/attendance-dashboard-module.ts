import type { DashboardModuleContribution } from "./module-contributions.ts";
import { AttendanceSetupWorkspace } from "./module-setup-workspace";

/** Attendance owns kiosks and Core-field behavior, so its pages stay integrated in the Core shell. */
export const attendanceDashboardModule: DashboardModuleContribution = {
  moduleId: "attendance",
  coreShell: true,
  setup: AttendanceSetupWorkspace,
};
