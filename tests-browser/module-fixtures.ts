import { attendanceModule, bundledModuleRegistry, type ModuleDefinition, type ModulePlatformSnapshot, type ModuleSnapshotItem } from "../packages/shared/src/module-platform.ts";

type SnapshotOptions = {
  enabled?: boolean;
  selectionCompleted?: boolean;
  setupReady?: boolean;
  access?: boolean;
  revision?: number;
};

function moduleSnapshotItem(definition: ModuleDefinition, enabled: boolean, setupReady: boolean, access: boolean): ModuleSnapshotItem {
  const effectiveCapabilities = enabled && setupReady && access ? definition.capabilities.map((capability) => capability.id) : [];
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    contractVersion: definition.contractVersion,
    enabled,
    phase: enabled ? "enabled" : "disabled",
    generation: 1,
    dependencies: definition.dependencies,
    permissions: definition.capabilities,
    effectiveCapabilities,
    workspaceReady: effectiveCapabilities.length > 0,
    navigation: definition.navigation,
    settings: definition.settings,
    setup: { ...definition.setup, ready: setupReady },
    deletion: { disabledAt: null, deleteAfter: null, contentStillPresent: false, cleanupFailure: null, data: definition.deletedData },
  };
}

/**
 * A snapshot of every module in this dashboard build: first-party modules plus any composed plugins, in registry order,
 * so it always matches what the dashboard validates. The named module uses the options; every other module is disabled.
 */
export function moduleSnapshot(moduleId: string, options: SnapshotOptions = {}): ModulePlatformSnapshot {
  if (!bundledModuleRegistry.get(moduleId)) throw new Error(`Module ${moduleId} is not in this dashboard build; compose its plugin first`);
  const enabled = options.enabled ?? true; const selectionCompleted = options.selectionCompleted ?? true; const setupReady = options.setupReady ?? true; const access = options.access ?? true;
  const modules = bundledModuleRegistry.modules.map((definition) => definition.id === moduleId ? moduleSnapshotItem(definition, enabled, setupReady, selectionCompleted && access) : moduleSnapshotItem(definition, false, false, false));
  return { revision: options.revision ?? 0, selectionCompleted, capabilities: modules.find((module) => module.id === moduleId)!.effectiveCapabilities, modules };
}

/** Combine snapshots: each module comes from the first snapshot that enables it, and capabilities are the union. */
export function combinedSnapshot(...snapshots: ModulePlatformSnapshot[]): ModulePlatformSnapshot {
  const [first] = snapshots;
  const modules = first!.modules.map((module) => snapshots.map((snapshot) => snapshot.modules.find((item) => item.id === module.id)!).find((item) => item.enabled) ?? module);
  return { ...first!, modules, capabilities: modules.flatMap((module) => module.effectiveCapabilities) };
}

export function attendanceSnapshot(options: SnapshotOptions = {}): ModulePlatformSnapshot {
  return moduleSnapshot("attendance", options);
}

export function outreachSnapshot(options: SnapshotOptions = {}): ModulePlatformSnapshot {
  return moduleSnapshot("hour-tracking", options);
}

export type AttendanceSetupStep = {
  id: string;
  label: string;
  required: boolean;
  valid: boolean;
  outcome: "completed" | "skipped" | null;
  completedAt: string | null;
};

export type AttendanceSetupState = {
  moduleId: "attendance";
  generation: 1;
  ready: boolean;
  phase: "enabled";
  version: 2;
  steps: AttendanceSetupStep[];
};

export function attendanceSetupState(outcomes: Partial<Record<string, "completed" | "skipped">> = {}, valid: readonly string[] = []): AttendanceSetupState {
  const validSteps = new Set(valid);
  const steps = attendanceModule.setup.steps.map((step) => ({
    ...step,
    valid: validSteps.has(step.id),
    outcome: outcomes[step.id] ?? null,
    completedAt: outcomes[step.id] ? "2026-09-28T12:00:00.000Z" : null,
  }));
  const ready = steps.filter((step) => step.required).every((step) => step.valid && step.outcome === "completed");
  return { moduleId: "attendance", generation: 1, ready, phase: "enabled", version: 2, steps };
}

export type OutreachSetupState = {
  moduleId: "hour-tracking";
  generation: 1;
  ready: boolean;
  phase: "enabled";
  version: 1;
  steps: AttendanceSetupStep[];
};

export function outreachSetupState(outcomes: Partial<Record<string, "completed" | "skipped">> = {}, valid: readonly string[] = []): OutreachSetupState {
  const validSteps = new Set(valid);
  // Outreach is the official plugin; its manifest is available when the dashboard is composed with it.
  const steps = bundledModuleRegistry.get("hour-tracking")!.setup.steps.map((step) => ({
    ...step,
    valid: validSteps.has(step.id),
    outcome: outcomes[step.id] ?? null,
    completedAt: outcomes[step.id] ? "2026-09-28T12:00:00.000Z" : null,
  }));
  const ready = steps.filter((step) => step.required).every((step) => step.valid && step.outcome === "completed");
  return { moduleId: "hour-tracking", generation: 1, ready, phase: "enabled", version: 1, steps };
}
