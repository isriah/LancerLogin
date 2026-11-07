// quick-check: covers apps/api/src/report-builder.ts
// The report query budget with Outreach and Guest Visits composed (see fixtures/visits-plugin.ts): every dataset, its
// default columns and every column it offers, within the budget in fixtures/report-query-budget.ts.
import test from "node:test";
import { visitsPlugin } from "./fixtures/visits-plugin.ts";

if (visitsPlugin.available) await import("./visits/report-query-budget.ts");
else test("Report query budget with plugins composed", { skip: visitsPlugin.reason }, () => {});
