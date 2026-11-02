// Compose the Guest Visits plugin for Core-side tests, exactly as an installation build would, then point this process at it.
// Guest Visits is an opt-in plugin, not an official default. Composition (see composed-plugins.ts) uses the test pin in
// tests/fixtures/visits.modules.json (or the LANCERLOGIN_VISITS_PLUGIN_SOURCE and LANCERLOGIN_VISITS_PLUGIN_COMMIT
// overrides) together with Core's official modules, so Outreach, which Guest Visits optionally uses, is composed too.
// Afterwards `@lancerlogin-test/visits/<path>` and `@lancerlogin-test/outreach/<path>` resolve to files in the composed checkouts.
// Import this module first, then import test bodies and application modules dynamically.
// When a plugin source is unavailable, `visitsPlugin.available` is false and callers register a skipped test that names
// the reason. Set LANCERLOGIN_REQUIRE_VISITS_PLUGIN=1 to fail instead; LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN=1 also fails
// when the composition can't be made.
import { readFileSync } from "node:fs";
import { composeTestPlugins } from "./composed-plugins.ts";

type Pin = { readonly source: string; readonly commit: string };
export type VisitsPlugin =
  | { readonly available: true; readonly root: string; readonly outreachRoot: string; readonly output: string; readonly source: string; readonly commit: string }
  | { readonly available: false; readonly reason: string };

function pin(): Pin | string {
  const source = process.env.LANCERLOGIN_VISITS_PLUGIN_SOURCE; const commit = process.env.LANCERLOGIN_VISITS_PLUGIN_COMMIT;
  if (source || commit) return source && commit ? { source, commit } : "Set both LANCERLOGIN_VISITS_PLUGIN_SOURCE and LANCERLOGIN_VISITS_PLUGIN_COMMIT";
  const selection = JSON.parse(readFileSync(new URL("../../tests/fixtures/visits.modules.json", import.meta.url), "utf8")) as { modules: (Pin & { id: string })[] };
  const pinned = selection.modules.find((module) => module.id === "visits");
  return pinned ? { source: pinned.source, commit: pinned.commit } : "tests/fixtures/visits.modules.json does not pin Guest Visits";
}

function load(): VisitsPlugin {
  const pinned = pin();
  if (typeof pinned === "string") { if (process.env.LANCERLOGIN_REQUIRE_VISITS_PLUGIN === "1") throw new Error(pinned); return { available: false, reason: pinned }; }
  const composed = composeTestPlugins({ selection: [{ id: "visits", ...pinned }], aliases: { visits: "visits", outreach: "hour-tracking" }, requireVariable: "LANCERLOGIN_REQUIRE_VISITS_PLUGIN", name: "visits" });
  if (!composed.available) { if (process.env.LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN === "1") throw new Error(composed.reason); return composed; }
  // The source actually composed: the pin itself, or a local checkout of its commit when no plugin token is set.
  const effective = composed.modules.find((module) => module.id === "visits")!;
  return { available: true, root: composed.roots.visits!, outreachRoot: composed.roots["hour-tracking"]!, output: composed.output, source: effective.source, commit: effective.commit };
}

export const visitsPlugin: VisitsPlugin = load();
