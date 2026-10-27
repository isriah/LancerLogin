import { attendanceApiModule } from "./attendance-api-module.ts";
import { externalApiModules } from "./generated/external-modules.ts";
import type { ApiModuleContribution } from "./module-contributions.ts";

export type InstalledModuleEnvironment = unknown;

/**
 * Installed module contributions in registry order. Setup, lifecycle and cleanup read this list directly;
 * the Worker validates it against the registry once it binds first-party runtime handlers.
 */
export const installedApiModules: readonly ApiModuleContribution<InstalledModuleEnvironment>[] = Object.freeze([attendanceApiModule, ...externalApiModules]);

export function installedApiModule(moduleId: string) {
  return installedApiModules.find((module) => module.moduleId === moduleId);
}
