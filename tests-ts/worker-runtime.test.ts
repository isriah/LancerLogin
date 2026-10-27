// Worker runtime routes, reports, Discord, backups and modules, run with the official Outreach plugin composed from Core's pin (see fixtures/outreach-plugin.ts).
import test from "node:test";
import { outreachPlugin } from "./fixtures/outreach-plugin.ts";

if (outreachPlugin.available) await import("./outreach/worker-runtime.ts");
else test("Worker runtime routes, reports, Discord, backups and modules", { skip: outreachPlugin.reason }, () => {});
