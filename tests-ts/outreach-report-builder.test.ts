// Report definitions and dataset catalog, run with the official Outreach plugin composed from Core's pin (see fixtures/outreach-plugin.ts).
import test from "node:test";
import { outreachPlugin } from "./fixtures/outreach-plugin.ts";

if (outreachPlugin.available) await import("./outreach/report-builder.ts");
else test("Report definitions and dataset catalog", { skip: outreachPlugin.reason }, () => {});
