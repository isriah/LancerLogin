// Simulate plugin composition for one test process: generated plugin lists resolve to this directory's synthetic modules.
// Import this module, then import application modules dynamically so they load after the hook is registered.
import { registerHooks } from "node:module";

const fixtures = new URL("./", import.meta.url);
const replacements: readonly (readonly [string, string])[] = [
  ["/packages/shared/src/generated/external-manifests.ts", "external-manifests.ts"],
  ["/apps/api/src/generated/external-modules.ts", "external-modules.ts"],
];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const replacement = replacements.find(([suffix]) => resolved.url.endsWith(suffix));
    return replacement ? { ...resolved, url: new URL(replacement[1], fixtures).href } : resolved;
  },
});
