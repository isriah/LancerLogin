import { bundledModuleRegistry, type ModulePlatformSnapshot } from "../../../packages/shared/src/module-platform.ts";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string") && new Set(value).size === value.length;
const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) < Number.MAX_SAFE_INTEGER;
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function fail(): never { throw new Error("Module access could not be verified. Reload the workspace."); }

export function readModuleSnapshot(value: unknown): ModulePlatformSnapshot {
  if (!record(value) || !integer(value.revision) || typeof value.selectionCompleted !== "boolean" || !strings(value.capabilities) || !Array.isArray(value.modules)) fail();
  const snapshot = value as unknown as ModulePlatformSnapshot;
  const expected = bundledModuleRegistry.modules.filter((module) => module.available);
  if (snapshot.modules.length !== expected.length) fail();
  const seen = new Set<string>();
  const effective = new Set<string>();
  for (const module of snapshot.modules) {
    const definition = bundledModuleRegistry.get(module.id);
    if (!definition?.available || seen.has(module.id) || module.label !== definition.label || module.description !== definition.description || module.contractVersion !== definition.contractVersion || !integer(module.generation, 1) || typeof module.enabled !== "boolean" || !["disabled", "enabled", "retained", "deleting", "deleted"].includes(module.phase) || module.enabled !== (module.phase === "enabled")) fail();
    seen.add(module.id);
    if (!equal(module.dependencies, definition.dependencies) || !equal(module.permissions, definition.capabilities) || !equal(module.navigation, definition.navigation) || !equal(module.settings, definition.settings) || !record(module.setup) || module.setup.version !== definition.setup.version || !equal(module.setup.steps, definition.setup.steps) || typeof module.setup.ready !== "boolean" || !strings(module.effectiveCapabilities) || module.effectiveCapabilities.some((capability) => !definition.capabilities.some((item) => item.id === capability)) || module.workspaceReady !== (module.effectiveCapabilities.length > 0)) fail();
    if (!record(module.deletion) || !equal(module.deletion.data, definition.deletedData) || typeof module.deletion.contentStillPresent !== "boolean" || module.deletion.contentStillPresent !== ["retained", "deleting"].includes(module.phase) || ![null, "retry-required"].includes(module.deletion.cleanupFailure)) fail();
    if (module.deletion.contentStillPresent) {
      if (typeof module.deletion.disabledAt !== "string" || typeof module.deletion.deleteAfter !== "string" || Date.parse(module.deletion.deleteAfter) - Date.parse(module.deletion.disabledAt) !== 7 * 24 * 60 * 60 * 1000) fail();
    } else if (module.deletion.disabledAt !== null || module.deletion.deleteAfter !== null) fail();
    for (const capability of module.effectiveCapabilities) effective.add(capability);
  }
  if (expected.some((module) => !seen.has(module.id)) || effective.size !== snapshot.capabilities.length || snapshot.capabilities.some((capability) => !effective.has(capability))) fail();
  return structuredClone(snapshot);
}
