// Module lifecycle, retention and cleanup, run with the official Outreach plugin composed from Core's pin (see fixtures/outreach-plugin.ts).
import test from "node:test";
import { outreachPlugin } from "./fixtures/outreach-plugin.ts";

if (outreachPlugin.available) await import("./outreach/module-lifecycle.ts");
else test("Module lifecycle, retention and cleanup", { skip: outreachPlugin.reason }, () => {});
