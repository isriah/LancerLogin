// Replaced by module composition for an installation's selected plugins. Core builds without plugins use this empty default.
import type { ApiModuleContribution } from "../module-contributions.ts";

export const externalApiModules: readonly ApiModuleContribution<unknown>[] = [];
