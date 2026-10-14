import { attendanceModule, carpoolModule, outreachModule, type ModuleDefinition, type ModulePlatformSnapshot, type ModuleSnapshotItem } from "../packages/shared/src/module-platform.ts";

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

export function attendanceSnapshot(options: SnapshotOptions = {}): ModulePlatformSnapshot {
  const enabled = options.enabled ?? true;
  const selectionCompleted = options.selectionCompleted ?? true;
  const setupReady = options.setupReady ?? true;
  const access = options.access ?? true;
  const attendance = moduleSnapshotItem(attendanceModule, enabled, setupReady, selectionCompleted && access);
  const outreach = moduleSnapshotItem(outreachModule, false, false, false);
  const carpool = moduleSnapshotItem(carpoolModule, false, false, false);
  return { revision: options.revision ?? 0, selectionCompleted, capabilities: attendance.effectiveCapabilities, modules: [attendance, outreach, carpool] };
}

export function outreachSnapshot(options: SnapshotOptions = {}): ModulePlatformSnapshot {
  const enabled = options.enabled ?? true;
  const selectionCompleted = options.selectionCompleted ?? true;
  const setupReady = options.setupReady ?? true;
  const access = options.access ?? true;
  const attendance = moduleSnapshotItem(attendanceModule, false, false, false);
  const outreach = moduleSnapshotItem(outreachModule, enabled, setupReady, selectionCompleted && access);
  const carpool = moduleSnapshotItem(carpoolModule, false, false, false);
  return { revision: options.revision ?? 0, selectionCompleted, capabilities: outreach.effectiveCapabilities, modules: [attendance, outreach, carpool] };
}

export function carpoolSnapshot(options: SnapshotOptions = {}): ModulePlatformSnapshot {
  const enabled = options.enabled ?? true; const selectionCompleted = options.selectionCompleted ?? true; const setupReady = options.setupReady ?? true; const access = options.access ?? true;
  const attendance = moduleSnapshotItem(attendanceModule, false, false, false); const outreach = moduleSnapshotItem(outreachModule, false, false, false); const carpool = moduleSnapshotItem(carpoolModule, enabled, setupReady, selectionCompleted && access);
  return { revision: options.revision ?? 0, selectionCompleted, capabilities: carpool.effectiveCapabilities, modules: [attendance, outreach, carpool] };
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
  const steps = outreachModule.setup.steps.map((step) => ({
    ...step,
    valid: validSteps.has(step.id),
    outcome: outcomes[step.id] ?? null,
    completedAt: outcomes[step.id] ? "2026-09-28T12:00:00.000Z" : null,
  }));
  const ready = steps.filter((step) => step.required).every((step) => step.valid && step.outcome === "completed");
  return { moduleId: "hour-tracking", generation: 1, ready, phase: "enabled", version: 1, steps };
}
