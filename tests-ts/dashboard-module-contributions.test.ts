// Dashboard module contributions, run with the official Outreach plugin composed from Core's pin (see fixtures/outreach-plugin.ts).
import test from "node:test";
import { outreachPlugin } from "./fixtures/outreach-plugin.ts";

if (outreachPlugin.available) await import("./outreach/dashboard-module-contributions.ts");
else test("Dashboard module contributions", { skip: outreachPlugin.reason }, () => {});
