// quick-check: covers apps/api/migrations/**
// The backup query budget with Outreach and Guest Visits composed (see fixtures/visits-plugin.ts): plugin tables join
// Core's in the one batch, so the count equals a Core build's (fixtures/backup-query-budget.ts).
import test from "node:test";
import { visitsPlugin } from "./fixtures/visits-plugin.ts";

if (visitsPlugin.available) await import("./visits/backup-query-budget.ts");
else test("Backup query budget with plugins composed", { skip: visitsPlugin.reason }, () => {});
