// Walkthrough progress and installation backups, run with the official Outreach plugin composed from Core's pin (see fixtures/outreach-plugin.ts).
import test from "node:test";
import { outreachPlugin } from "./fixtures/outreach-plugin.ts";

if (outreachPlugin.available) await import("./outreach/walkthrough.ts");
else test("Walkthrough progress and installation backups", { skip: outreachPlugin.reason }, () => {});
