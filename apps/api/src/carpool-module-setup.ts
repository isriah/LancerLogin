import type { D1Database } from "./d1-usage.ts";

export type CarpoolSetupPredicate = { sql: string; bindings: readonly unknown[] };

export const carpoolSetupPredicates: Readonly<Record<string, (installationId: string) => CarpoolSetupPredicate>> = Object.freeze({
  workspace: (installationId) => ({ sql: "EXISTS(SELECT 1 FROM carpool_plans WHERE installation_id=? AND archived=0)", bindings: [installationId] }),
});

export async function carpoolSetupStepValid(db: D1Database, stepId: string) {
  const factory = carpoolSetupPredicates[stepId]; if (!factory) return false;
  const predicate = factory("primary");
  return Boolean(await db.prepare(`SELECT 1 AS valid WHERE ${predicate.sql}`).bind(...predicate.bindings).first());
}
