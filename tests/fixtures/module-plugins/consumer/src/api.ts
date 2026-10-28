// Synthetic, unshipped API contribution for cross-module tests. It reaches the Example plugin only through
// `services.modules.interface`, never through Example's tables, and keeps working when Example is absent.
import { HttpError, type ApiModuleContribution } from "@lancerlogin/module-sdk/api";

const installationId = "primary";

/** Call one operation and report the outcome; a provider failure arrives as an HttpError with the provider's status. */
async function callExample(services: any, input: any) {
  const items = await services.modules.interface("example.items", 1);
  if (!items) return { available: false };
  try { return { available: true, result: await items.call(input?.operation, input?.input) }; }
  catch (error) { if (error instanceof HttpError) return { available: true, failed: { status: error.status, message: error.message } }; throw error; }
}

const api: ApiModuleContribution<unknown> = {
  moduleId: "consumer",
  routes: {
    // Calls with the signed-in user's own Example access.
    "/admin/consumer": async (context: any) => {
      if (context.url.pathname !== "/admin/consumer/call" || context.request.method !== "POST") return undefined;
      await context.requireRole(["admin", "operator"]);
      context.requireDashboardOrigin("Consumer changes require the dashboard origin");
      return context.respond(await callExample(context.services, await context.json(4096)));
    },
    // No signed-in user: only an Admin's grant to Consumer can authorize a call here.
    "/public/consumer": async (context: any) => {
      if (context.url.pathname !== "/public/consumer/call" || context.request.method !== "POST") return undefined;
      return context.respond(await callExample(context.services, await context.json(4096)));
    },
  },
  setup: {
    predicates: { settings: (installation: string) => ({ sql: "EXISTS (SELECT 1 FROM consumer_settings WHERE installation_id = ?)", bindings: [installation] }) },
    stepValid: async (db: any, stepId: string) => stepId === "settings" && Boolean(await db.prepare("SELECT 1 FROM consumer_settings WHERE installation_id = ?").bind(installationId).first()),
  },
  // A job has no signed-in user either; it lists Example items with the grant and records what it saw.
  jobs: {
    "consumer.sync": async ({ db, services }: any) => {
      const record = (outcome: string, detail: string) => db.prepare("INSERT INTO consumer_runs (installation_id, id, outcome, detail, created_at) VALUES (?, ?, ?, ?, ?)").bind(installationId, crypto.randomUUID(), outcome, detail.slice(0, 500), new Date().toISOString()).run();
      const outcome = await callExample(services, { operation: "list", input: {} });
      if (!outcome.available) await record("unavailable", "");
      else if ("failed" in outcome) await record("failed", `${outcome.failed!.status} ${outcome.failed!.message}`);
      else await record("listed", (outcome.result as any).items.map((item: any) => item.id).join(","));
      return outcome;
    },
  },
  freshEnable: (db: any, context: any) => [db.prepare("INSERT OR IGNORE INTO consumer_settings (installation_id, created_at) VALUES (?, ?)").bind(context.installationId, context.now)],
  cleanup: { steps: [{ kind: "delete", table: "consumer_runs" }, { kind: "delete", table: "consumer_settings" }, { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["consumer"] }, { kind: "assignments" }] },
  backup: { version: 1, tables: { consumer_settings: ["installation_id", "created_at"], consumer_runs: ["installation_id", "id", "outcome", "detail", "created_at"] } },
};

export default api;
