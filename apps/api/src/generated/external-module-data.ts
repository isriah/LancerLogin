// Replaced by module composition for an installation's selected plugins. Core builds without plugins use this empty default.
import type { ModuleMigrationPackage } from "../module-migrations.ts";

export const externalModuleMigrations: readonly ModuleMigrationPackage[] = [];

export const externalModuleSources: Readonly<Record<string, { readonly source: string; readonly commit: string; readonly official?: boolean; readonly selected?: boolean }>> = {};
