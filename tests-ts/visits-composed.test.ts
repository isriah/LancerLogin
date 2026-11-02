// Guest Visits through the composed Worker beside Outreach, including its services.modules use of Outreach, run against
// the Guest Visits plugin composed from its pinned commit (see fixtures/visits-plugin.ts).
import test from "node:test";
import { visitsPlugin } from "./fixtures/visits-plugin.ts";

if (visitsPlugin.available) await import("./visits/composed.ts");
else test("Guest Visits plugin through the composed Worker", { skip: visitsPlugin.reason }, () => {});
