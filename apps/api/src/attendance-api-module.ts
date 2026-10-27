import { attendanceCleanupBlocker, attendanceCleanupSteps } from "./attendance-cleanup.ts";
import { attendanceSetupPredicates, attendanceSetupStepValid } from "./attendance-module-setup.ts";
import type { ApiModuleContribution } from "./module-contributions.ts";

/**
 * Attendance stays integrated with Core: its routes, including kiosk endpoints, remain in the Core dispatcher,
 * and the Worker binds its delivery jobs and report projection where they are implemented.
 */
export const attendanceApiModule: ApiModuleContribution<unknown> = Object.freeze({
  moduleId: "attendance",
  coreRoutes: true,
  setup: { predicates: attendanceSetupPredicates, stepValid: attendanceSetupStepValid },
  cleanup: {
    steps: attendanceCleanupSteps,
    blocker: { sql: attendanceCleanupBlocker, bindings: (installationId) => [installationId, installationId, installationId], recordFailure: true },
  },
});
