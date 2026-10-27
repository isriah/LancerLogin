// Compose the official Outreach plugin for Core-side tests, exactly as an installation build with Core's official modules
// would, then point this process at it (see composed-plugins.ts). The pin is Core's own in scripts/official-modules.json,
// or the LANCERLOGIN_OUTREACH_PLUGIN_SOURCE and LANCERLOGIN_OUTREACH_PLUGIN_COMMIT overrides.
// Browser specs use the same composition: node scripts/run-browser-tests.mjs --compose-selection tests/fixtures/official.modules.json ...
// Afterwards `@lancerlogin-test/outreach/<path>` resolves to a file in the composed Outreach checkout.
// Import this module first, then import test bodies and application modules dynamically.
// When the plugin source is unavailable, `outreachPlugin.available` is false and callers register a skipped test that names
// the reason. Set LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN=1 to fail instead.
import { composeTestPlugins, officialModulePins } from "./composed-plugins.ts";

type Pin = { readonly source: string; readonly commit: string };
export type OutreachPlugin =
  | { readonly available: true; readonly root: string; readonly output: string; readonly source: string; readonly commit: string }
  | { readonly available: false; readonly reason: string };

function pin(): Pin | string {
  const source = process.env.LANCERLOGIN_OUTREACH_PLUGIN_SOURCE; const commit = process.env.LANCERLOGIN_OUTREACH_PLUGIN_COMMIT;
  if (source || commit) return source && commit ? { source, commit } : "Set both LANCERLOGIN_OUTREACH_PLUGIN_SOURCE and LANCERLOGIN_OUTREACH_PLUGIN_COMMIT";
  const official = officialModulePins().find((module) => module.id === "hour-tracking");
  return official ? { source: official.source, commit: official.commit } : "scripts/official-modules.json does not pin Outreach";
}

function load(): OutreachPlugin {
  const pinned = pin();
  if (typeof pinned === "string") { if (process.env.LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN === "1") throw new Error(pinned); return { available: false, reason: pinned }; }
  // An override replaces Core's official pin through the selection, as an installation pinning another commit would.
  const overridden = Boolean(process.env.LANCERLOGIN_OUTREACH_PLUGIN_SOURCE);
  const composed = composeTestPlugins({ selection: overridden ? [{ id: "hour-tracking", ...pinned }] : [], aliases: { outreach: "hour-tracking" }, requireVariable: "LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN", name: "outreach" });
  if (!composed.available) return composed;
  // The source actually composed: the pin itself, or a local checkout of its commit when no plugin token is set.
  const effective = composed.modules.find((module) => module.id === "hour-tracking")!;
  return { available: true, root: composed.roots["hour-tracking"]!, output: composed.output, source: effective.source, commit: effective.commit };
}

export const outreachPlugin: OutreachPlugin = load();
