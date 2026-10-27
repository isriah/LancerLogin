// Page walkthrough guidance, run with the official Outreach plugin composed from Core's pin (see fixtures/outreach-plugin.ts).
import test from "node:test";
import { outreachPlugin } from "./fixtures/outreach-plugin.ts";

if (outreachPlugin.available) await import("./outreach/walkthrough-guidance.ts");
else test("Page walkthrough guidance", { skip: outreachPlugin.reason }, () => {});
