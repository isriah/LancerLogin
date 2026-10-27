import { bundledModuleRegistry, type ModulePlatformSnapshot } from "../../../packages/shared/src/module-platform.ts";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string") && new Set(value).size === value.length;
const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) < Number.MAX_SAFE_INTEGER;
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function fail(): never { throw new Error("Module access could not be verified. Reload the workspace."); }

/**
 * A module the Worker reports as unavailable: plugin code that was removed while lifecycle or retained data remains, or an
 * installed plugin whose database setup has not completed. It grants nothing, so only its lifecycle shape is checked; one
 * unavailable plugin must never make the rest of the workspace unverifiable.
 */
function checkUnavailable(module: ModulePlatformSnapshot["modules"][number]) {
  const definition = bundledModuleRegistry.get(module.id);
  const kind = module.unavailable;
  if (typeof module.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(module.id) || typeof module.label !== "string" || typeof module.description !== "string" || !integer(module.contractVersion, 1)) fail();
  if (kind === "setup-incomplete" ? !definition?.available || module.phase !== "disabled" || module.generation !== 0 : kind !== "removed" || definition || !["enabled", "retained", "deleting"].includes(module.phase) || !integer(module.generation, 1)) fail();
  if (typeof module.enabled !== "boolean" || module.enabled !== (module.phase === "enabled") || !strings(module.dependencies) || !equal(module.permissions, []) || !equal(module.effectiveCapabilities, []) || module.workspaceReady !== false || !equal(module.navigation, []) || !equal(module.settings, [])) fail();
  if (!record(module.setup) || !record(module.deletion) || typeof module.deletion.contentStillPresent !== "boolean" || module.deletion.contentStillPresent !== ["retained", "deleting"].includes(module.phase) || !(module.deletion.cleanupFailure === null || typeof module.deletion.cleanupFailure === "string") || !Array.isArray(module.deletion.data)) fail();
}

export function readModuleSnapshot(value: unknown): ModulePlatformSnapshot {
  if (!record(value) || !integer(value.revision) || typeof value.selectionCompleted !== "boolean" || !strings(value.capabilities) || !Array.isArray(value.modules)) fail();
  const snapshot = value as unknown as ModulePlatformSnapshot;
  const expected = bundledModuleRegistry.modules.filter((module) => module.available);
  const seen = new Set<string>();
  const effective = new Set<string>();
  for (const module of snapshot.modules) {
    if (!record(module) || seen.has(module.id)) fail();
    if (module.unavailable !== undefined) { checkUnavailable(module); seen.add(module.id); continue; }
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
