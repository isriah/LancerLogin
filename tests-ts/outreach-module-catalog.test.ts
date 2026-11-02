// Installed-module catalog, module migrations and removed modules, run with the official Outreach plugin composed from Core's pin (see fixtures/outreach-plugin.ts).
import test from "node:test";
import { outreachPlugin } from "./fixtures/outreach-plugin.ts";

if (outreachPlugin.available) await import("./outreach/module-catalog.ts");
else test("Installed-module catalog, module migrations and removed modules", { skip: outreachPlugin.reason }, () => {});
