// Outreach catalogs, entries, reviews, publication, public routes, Discord commands and backups, run against the official Outreach plugin composed from Core's pin (see fixtures/outreach-plugin.ts).
import test from "node:test";
import { outreachPlugin } from "./fixtures/outreach-plugin.ts";

if (outreachPlugin.available) await import("./outreach/catalogs.ts");
else test("Outreach catalogs, entries, reviews, publication, public routes, Discord commands and backups", { skip: outreachPlugin.reason }, () => {});
