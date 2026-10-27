// Carpool plugin logic, routes, settings and backup validation, run against the Carpool plugin composed from its pinned commit (see fixtures/carpool-plugin.ts).
import test from "node:test";
import { carpoolPlugin } from "./fixtures/carpool-plugin.ts";

if (carpoolPlugin.available) await import("./carpool/module.ts");
else test("Carpool plugin logic, routes, settings and backup validation", { skip: carpoolPlugin.reason }, () => {});
