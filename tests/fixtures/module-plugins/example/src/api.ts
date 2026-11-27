// Synthetic, unshipped API contribution for composition tests. Handlers receive Core's module context and the
// module-scoped database; they never see the Worker environment or Core credentials.
import { expectedMembersForDay, HttpError, installationTimeZone, listActiveRosterWithLabels, meetingsOnLocalDate, presentMembersForDay, type ApiModuleContribution } from "@lancerlogin/module-sdk/api";
import { countOpenItems, itemsWithRequests } from "./items.ts";

const installationId = "primary";
const validId = (value: unknown) => typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);

/**
 * Lets tests confirm a job reads Core's day projections through its own scoped database: today's required meetings, who
 * checked in, who was expected and the labelled roster, noted on the first open item. Nothing is written while Attendance is
 * unavailable or the installation has no time zone yet.
 */
async function recordAttendanceDay(db: any) {
  const timeZone = await installationTimeZone(db, installationId).catch(() => undefined);
  if (!timeZone) return;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const meetings = await meetingsOnLocalDate(db, installationId, today, { requiredOnly: true });
  if (!meetings) return;
  // One after another: the test database cannot overlap batches (D1 can).
  const present = await presentMembersForDay(db, installationId, today, { requiredOnly: true });
  const expected = await expectedMembersForDay(db, installationId, today, { requiredOnly: true });
  const roster = await listActiveRosterWithLabels(db, installationId, today);
  const note = `${today}: ${meetings.length} meetings, ${present?.length ?? 0} present, ${expected?.filter((row) => row.expected).length ?? 0} expected, ${roster.length} on the roster`;
  await db.prepare("INSERT OR REPLACE INTO example_requests (installation_id, id, item_id, note, created_at) SELECT installation_id, 'attendance-day', id, ?, ? FROM example_items WHERE installation_id = ? AND closed = 0 ORDER BY id LIMIT 1").bind(note, new Date().toISOString(), installationId).run();
}

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
      // Lets tests exercise Core's shared email service and the installation time zone projection.
      if (context.url.pathname === "/admin/example/notify" && context.request.method === "POST") {
        await context.requireRole(["admin"]);
        context.requireDashboardOrigin("Example changes require the dashboard origin");
        const input = await context.json(2048);
        const ready = await context.services.email.ready();
        const timeZone = await installationTimeZone(context.db, installationId);
        if (!ready) return context.respond({ ready, timeZone });
        try {
          const sent = await context.services.email.send({ to: input?.to, subject: "Example notice", text: `Example notice (${timeZone})`, idempotencyKey: `notice-${input?.key}` });
          return context.respond({ ready, timeZone, id: sent.id });
        } catch (error) {
          const providerStatus = context.services.email.providerStatus(error);
          if (providerStatus === undefined) throw error;
          return context.respond({ ready, timeZone, providerStatus }, 502);
        }
      }
      // Lets tests confirm a Discord rate limit reaches a plugin as a neutral 429 with Discord's delay.
      if (context.url.pathname === "/admin/example/discord-events" && context.request.method === "GET") {
        await context.requireRole(["admin"]);
        try {
          const client = await context.services.discord.client();
          const listed = await client.request(`/guilds/${client.guildId}/scheduled-events`, { method: "GET" });
          return context.respond({ events: listed.body });
        } catch (error) {
          const providerStatus = context.services.discord.providerStatus(error);
          if (providerStatus === undefined) throw error;
          return context.respond({ providerStatus, retryAfterMs: context.services.discord.retryAfterMs(error), message: (error as Error).message }, 502);
        }
      }
      // Lets tests exercise Core's Notion service: the bound database, a page Core returned, a page it did not, an
      // operation the manifest did not declare, user access without email, and the legacy import that is Part Requests' alone.
      if (context.url.pathname === "/admin/example/notion" && context.request.method === "POST") {
        await context.requireRole(["admin"]);
        const input = await context.json(2048); const notion = context.services.notion;
        const attempt = async (work: () => Promise<unknown>) => {
          try { return { ok: await work() }; }
          catch (error: any) {
            if (notion.errorCode(error) === undefined && typeof error?.status !== "number") throw error;
            return { code: notion.errorCode(error) ?? null, status: error.status, providerStatus: notion.providerStatus(error) ?? null, retryAfterMs: notion.retryAfterMs(error) ?? null, uncertain: notion.uncertain(error) };
          }
        };
        const title = (text: string) => ({ Name: { title: [{ text: { content: text } }] } });
        const ready = await notion.ready(); const status = await notion.status();
        const binding = await attempt(async () => await notion.binding("items") ?? null);
        const rows = await attempt(async () => (await notion.query("items", { pageSize: 5 })).results.map((row: any) => row.id));
        const created: any = await attempt(async () => (await notion.createPage("items", { properties: title("Example item") })).id);
        const updatedOwn = created.ok ? await attempt(async () => (await notion.updatePage("items", created.ok, { properties: title("Example item, updated") })).id) : null;
        const updatedOther = input?.pageId ? await attempt(async () => (await notion.updatePage("items", input.pageId, { properties: title("Example other") })).id) : null;
        const trashed = await attempt(() => notion.trashPage("items", input?.pageId ?? created.ok));
        const users = await attempt(async () => (await notion.users.list()).users);
        const imported = await attempt(() => notion.importLegacyConnection({ ciphertext: "c", iv: "i" }));
        return context.respond({ ready, status, binding, rows, created, updatedOwn, updatedOther, trashed, users, imported });
      }
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
      // Lets tests confirm Core's FIRST service counts a public visitor's lookups, and that its legacy import is Guest Visits' alone.
      if (context.url.pathname === "/public/example/first" && context.request.method === "POST") {
        const input = await context.json(256);
        const lookup = await context.services.first.lookupTeam({ program: "FRC", number: input?.number });
        const importStatus = await context.services.first.importLegacyCredential({ program: "FTC", username: "u", ciphertext: "c", iv: "i", checkedAt: "2026-01-01T00:00:00.000Z" }).then(() => 200, (error: any) => error?.status);
        return context.respond({ lookup, importStatus });
      }
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
      await recordAttendanceDay(db);
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
  // Other modules call these through Core with an Admin's grant or a signed-in user's Example access. The handlers validate
  // their own input and see who is calling; `create` writes twice, so tests can revoke access between its statements.
  interfaces: {
    "example.items": {
      list: async ({ db }: any) => ({ items: (await itemsWithRequests(db, installationId)).map(({ id, title }) => ({ id, title })) }),
      create: async ({ db, caller }: any, input: any) => {
        if (!validId(input?.id) || typeof input?.title !== "string" || !input.title.trim() || input.title.length > 120) throw new HttpError(400, "An item ID and title are required");
        if (await db.prepare("SELECT 1 FROM example_items WHERE installation_id = ? AND id = ?").bind(installationId, input.id).first()) throw new HttpError(409, "That Example item already exists");
        await db.prepare("INSERT INTO example_items (installation_id, id, title, created_at) VALUES (?, ?, ?, ?)").bind(installationId, input.id, input.title.trim(), new Date().toISOString()).run();
        await db.prepare("INSERT INTO example_requests (installation_id, id, item_id, note, created_at) VALUES (?, ?, ?, ?, ?)").bind(installationId, `${input.id}-origin`, input.id, `Created by ${caller.moduleId}${caller.grantId ? " with a grant" : ` for ${caller.userId}`}`, new Date().toISOString()).run();
        return { id: input.id };
      },
      close: async ({ db }: any, input: any) => {
        if (!validId(input?.id)) throw new HttpError(400, "An item ID is required");
        const result = await db.prepare("UPDATE example_items SET closed = 1 WHERE installation_id = ? AND id = ?").bind(installationId, input.id).run();
        if (result.meta?.changes !== 1) throw new HttpError(404, "That Example item does not exist");
        return { closed: input.id };
      },
    },
  },
  cleanup: { steps: [{ kind: "delete", table: "example_requests" }, { kind: "delete", table: "example_items" }, { kind: "assignments" }] },
  // Requests are operational public submissions and stay out of portable backups.
  backup: { version: 1, tables: { example_items: ["installation_id", "id", "title", "owner_member_id", "closed", "digest_count", "created_at"] } },
};

export default api;
