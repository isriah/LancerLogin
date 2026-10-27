// Carpool plugin routes on local D1, run against the Carpool plugin composed from its pinned commit (see fixtures/carpool-plugin.ts).
import test from "node:test";
import { carpoolPlugin } from "./fixtures/carpool-plugin.ts";

if (carpoolPlugin.available) await import("./carpool/d1.ts");
else test("Carpool plugin routes on local D1", { skip: carpoolPlugin.reason }, () => {});
