// Compose the Carpool plugin for Core-side tests, exactly as an installation build would, then point this process at it.
// Carpool is an opt-in plugin, not an official default. Composition (see composed-plugins.ts) uses the test pin in
// tests/fixtures/carpool.modules.json (or the LANCERLOGIN_CARPOOL_PLUGIN_SOURCE and LANCERLOGIN_CARPOOL_PLUGIN_COMMIT
// overrides) together with Core's official modules, as an installation selecting Carpool receives them.
// Browser specs use the same selection: node scripts/run-browser-tests.mjs --compose-selection tests/fixtures/carpool.modules.json ...
// Afterwards `@lancerlogin-test/carpool/<path>` resolves to a file in the composed Carpool checkout.
// Import this module first, then import test bodies and application modules dynamically.
// When the plugin source is unavailable, `carpoolPlugin.available` is false and callers register a skipped test that names
// the reason. Set LANCERLOGIN_REQUIRE_CARPOOL_PLUGIN=1 to fail instead.
import { readFileSync } from "node:fs";
import { composeTestPlugins } from "./composed-plugins.ts";

type Pin = { readonly source: string; readonly commit: string };
export type CarpoolPlugin =
  | { readonly available: true; readonly root: string; readonly output: string; readonly source: string; readonly commit: string }
  | { readonly available: false; readonly reason: string };

function pin(): Pin | string {
  const source = process.env.LANCERLOGIN_CARPOOL_PLUGIN_SOURCE; const commit = process.env.LANCERLOGIN_CARPOOL_PLUGIN_COMMIT;
  if (source || commit) return source && commit ? { source, commit } : "Set both LANCERLOGIN_CARPOOL_PLUGIN_SOURCE and LANCERLOGIN_CARPOOL_PLUGIN_COMMIT";
  const selection = JSON.parse(readFileSync(new URL("../../tests/fixtures/carpool.modules.json", import.meta.url), "utf8")) as { modules: (Pin & { id: string })[] };
  const pinned = selection.modules.find((module) => module.id === "carpool");
  return pinned ? { source: pinned.source, commit: pinned.commit } : "tests/fixtures/carpool.modules.json does not pin Carpool";
}

function load(): CarpoolPlugin {
  const pinned = pin();
  if (typeof pinned === "string") { if (process.env.LANCERLOGIN_REQUIRE_CARPOOL_PLUGIN === "1") throw new Error(pinned); return { available: false, reason: pinned }; }
  const composed = composeTestPlugins({ selection: [{ id: "carpool", ...pinned }], aliases: { carpool: "carpool" }, requireVariable: "LANCERLOGIN_REQUIRE_CARPOOL_PLUGIN", name: "carpool" });
  if (!composed.available) return composed;
  // The source actually composed: the pin itself, or a local checkout of its commit when no plugin token is set.
  const effective = composed.modules.find((module) => module.id === "carpool")!;
  return { available: true, root: composed.roots.carpool!, output: composed.output, source: effective.source, commit: effective.commit };
}

export const carpoolPlugin: CarpoolPlugin = load();
