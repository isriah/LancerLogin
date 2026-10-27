// Synthetic, unshipped API contribution for composition tests. Handlers receive Core's module context and the
// module-scoped database; they never see the Worker environment or Core credentials.
import type { ApiModuleContribution } from "@lancerlogin/module-sdk/api";
import { countOpenItems, itemsWithRequests } from "./items.ts";

const installationId = "primary";
const validId = (value: unknown) => typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);

const api: ApiModuleContribution<unknown> = {
  moduleId: "example",
  routes: {
    "/module-setup/example": async (context: any) => {
      if (context.url.pathname !== "/module-setup/example" || context.request.method !== "GET") return undefined;
      await context.requireRole(["admin"]);
      return context.respond({ catalog: await countOpenItems(context.db, installationId) > 0 });
    },
    "/admin/example": async (context: any) => {
      // Lets tests confirm a plugin receives Core services but none of the Worker environment.
      if (context.url.pathname === "/admin/example/environment") return context.respond({ environmentKeys: Object.keys(context.env ?? {}), credentials: context.services.credentials.available });
      if (context.url.pathname !== "/admin/example/items") return undefined;
      await context.requireRole(["admin", "operator"]);
      if (context.request.method === "GET") return context.respond({ items: await itemsWithRequests(context.db, installationId) });
      if (context.request.method !== "POST") return undefined;
      context.requireDashboardOrigin("Example changes require the dashboard origin");
      const input = await context.json(4096);
      if (!validId(input?.id) || typeof input?.title !== "string" || !input.title.trim() || input.title.length > 120) return context.respond({ error: "An item ID and title are required" }, 400);
      await context.db.prepare("INSERT INTO example_items (installation_id, id, title, created_at) VALUES (?, ?, ?, ?)").bind(installationId, input.id, input.title.trim(), new Date().toISOString()).run();
      return context.respond({ id: input.id }, 201);
    },
    "/public/example": async (context: any) => {
      if (context.url.pathname !== "/public/example/requests" || context.request.method !== "POST") return undefined;
      const input = await context.json(2048);
      if (!validId(input?.id) || !validId(input?.itemId) || typeof (input.note ?? "") !== "string" || (input.note ?? "").length > 500) return context.respond({ error: "A request ID and open item are required" }, 400);
      const result = await context.db.prepare("INSERT INTO example_requests (installation_id, id, item_id, note, created_at) SELECT installation_id, ?, id, ?, ? FROM example_items WHERE installation_id = ? AND id = ? AND closed = 0").bind(input.id, input.note ?? "", new Date().toISOString(), installationId, input.itemId).run();
      return result.meta?.changes === 1 ? context.respond({ accepted: true }, 202) : context.respond({ error: "That item is not open" }, 404);
    },
  },
  setup: {
    predicates: { catalog: (installation: string) => ({ sql: "EXISTS (SELECT 1 FROM example_items WHERE installation_id = ?)", bindings: [installation] }) },
    stepValid: async (db: any, stepId: string) => stepId === "catalog" && await countOpenItems(db, installationId) > 0,
  },
  jobs: {
    "example.digest": async ({ db }: any) => {
      await db.prepare("UPDATE example_items SET digest_count = digest_count + 1 WHERE installation_id = ? AND closed = 0").bind(installationId).run();
      return { open: await countOpenItems(db, installationId) };
    },
  },
  reports: {
    "example.items": async (db: any) => (await itemsWithRequests(db, installationId)).map((item) => ({
      id: item.id, label: item.title,
      cells: { "example.item.id": { text: item.id, sortValue: item.id }, "example.item.title": { text: item.title, sortValue: item.title }, "example.item.requests": { text: String(item.requests), sortValue: item.requests } },
    })),
  },
  discord: {
    "example-status": async (db: any, interaction: any) => {
      const title = interaction.data?.options?.find((option: any) => option.name === "title")?.value;
      const open = await countOpenItems(db, installationId, title);
      return `${open} open Example item${open === 1 ? "" : "s"}${title ? ` titled ${title}` : ""}`;
    },
  },
  cleanup: { steps: [{ kind: "delete", table: "example_requests" }, { kind: "delete", table: "example_items" }, { kind: "assignments" }] },
  // Requests are operational public submissions and stay out of portable backups.
  backup: { version: 1, tables: { example_items: ["installation_id", "id", "title", "owner_member_id", "closed", "digest_count", "created_at"] } },
};

export default api;
