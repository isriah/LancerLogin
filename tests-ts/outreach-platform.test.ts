// Outreach as the official plugin: registry ownership, first-party identity, styles, controls, first enablement seeds,
// existing installations and historical backups, run against the plugin composed from Core's pin (see fixtures/outreach-plugin.ts).
import test from "node:test";
import { outreachPlugin } from "./fixtures/outreach-plugin.ts";

if (outreachPlugin.available) await import("./outreach/platform.ts");
else test("Outreach as the official plugin", { skip: outreachPlugin.reason }, () => {});
