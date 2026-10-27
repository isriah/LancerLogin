// The plugin repository and released commit of each module that moved out of LancerLogin into a plugin, so an installation
// that uses one can keep it by adding its plugin. scripts/known-modules.json is the single list; official modules use the
// commit official-modules.json pins (enforced by tests).
import known from "../../../scripts/known-modules.json" with { type: "json" };
import { extractedModules } from "./extracted-modules.ts";

export type KnownModule = { readonly id: string; readonly label: string; readonly source: string; readonly commit: string };
export const knownModules: readonly KnownModule[] = Object.freeze((known as { modules: KnownModule[] }).modules.map((entry) => Object.freeze({ ...entry })));
export function knownModule(id: string): KnownModule | undefined {
  return knownModules.find((entry) => entry.id === id);
}
if (knownModules.some((entry) => !extractedModules.some((module) => module.id === entry.id))) throw new Error("scripts/known-modules.json lists a module that was never part of LancerLogin");
