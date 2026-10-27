// Module registry, assignments and table ownership, run with the official Outreach plugin composed from Core's pin (see fixtures/outreach-plugin.ts).
import test from "node:test";
import { outreachPlugin } from "./fixtures/outreach-plugin.ts";

if (outreachPlugin.available) await import("./outreach/module-platform.ts");
else test("Module registry, assignments and table ownership", { skip: outreachPlugin.reason }, () => {});
