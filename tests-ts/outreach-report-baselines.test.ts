// Outreach's own reporting start date, run with the official Outreach plugin composed from Core's pin (see fixtures/outreach-plugin.ts).
import test from "node:test";
import { outreachPlugin } from "./fixtures/outreach-plugin.ts";

if (outreachPlugin.available) await import("./outreach/report-baselines.ts");
else test("Outreach reporting start date", { skip: outreachPlugin.reason }, () => {});
