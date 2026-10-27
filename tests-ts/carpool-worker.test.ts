// Carpool through the composed Worker, including historical first-party backups, run against the Carpool plugin composed
// from its pinned commit (see fixtures/carpool-plugin.ts).
import test from "node:test";
import { carpoolPlugin } from "./fixtures/carpool-plugin.ts";

if (carpoolPlugin.available) await import("./carpool/worker.ts");
else test("Carpool plugin through the composed Worker", { skip: carpoolPlugin.reason }, () => {});
