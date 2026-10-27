// Replaced by module composition for an installation's selected plugins. Core builds without plugins use this empty default.
import type { DashboardModuleContribution } from "../module-contributions.ts";

export const externalDashboardModules: readonly DashboardModuleContribution[] = [];
