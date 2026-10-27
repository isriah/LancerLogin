// Carpool's place in the module platform (registry, stylesheet, controls, lifecycle and historical backups), run against the
// Carpool plugin composed from its pinned commit (see fixtures/carpool-plugin.ts).
import test from "node:test";
import { carpoolPlugin } from "./fixtures/carpool-plugin.ts";

if (carpoolPlugin.available) await import("./carpool/platform.ts");
else test("Carpool plugin in the module platform", { skip: carpoolPlugin.reason }, () => {});
