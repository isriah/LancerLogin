// Test-only composition of two unshipped plugin API contributions. Tests substitute this file for the generated contribution list.
import type { ApiModuleContribution, ModuleBackupTables } from "../../../apps/api/src/module-contributions.ts";

type Row = Readonly<Record<string, unknown>>;
const handled = async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
const setup = (table: string) => ({ predicates: { workspace: (installationId: string) => ({ sql: `EXISTS(SELECT 1 FROM ${table} WHERE installation_id=?)`, bindings: [installationId] }) }, stepValid: async () => true });

export const syntheticNotesApiModule: ApiModuleContribution<unknown> = {
  moduleId: "synthetic-notes",
  routes: { "/admin/synthetic-notes": handled },
  setup: setup("synthetic_notes_entries"),
  cleanup: { steps: [{ kind: "delete", table: "synthetic_notes_tokens" }, { kind: "delete", table: "synthetic_notes_jobs" }, { kind: "delete", table: "synthetic_notes_tags" }, { kind: "delete", table: "synthetic_notes_entries" }, { kind: "assignments" }] },
  backup: {
    version: 2,
    tables: {
      synthetic_notes_entries: ["installation_id", "id", "member_id", "body", "pinned"],
      synthetic_notes_tags: ["installation_id", "note_id", "tag"],
      synthetic_notes_jobs: ["installation_id", "id", "status", "lease_token"],
    },
    // Version 1 had no pin flag and no queued work.
    normalize: (tables, fromVersion): ModuleBackupTables => fromVersion === 1
      ? { synthetic_notes_entries: (tables.synthetic_notes_entries ?? []).map((row: Row) => ({ ...row, pinned: 0 })), synthetic_notes_tags: tables.synthetic_notes_tags ?? [], synthetic_notes_jobs: [] }
      : tables,
    validate: (tables) => {
      const notes = new Set(tables.synthetic_notes_entries!.map((row) => row.id));
      if (tables.synthetic_notes_entries!.some((row) => typeof row.body !== "string" || !row.body.trim())) throw new Error("Synthetic note body is required");
      if (tables.synthetic_notes_tags!.some((row) => !notes.has(row.note_id))) throw new Error("Synthetic tag references an unknown note");
    },
    neutralize: (tables) => ({
      ...tables,
      synthetic_notes_jobs: tables.synthetic_notes_jobs!.map((row) => ["pending", "processing"].includes(String(row.status)) ? { ...row, status: "cancelled", lease_token: null } : row),
    }),
  },
};

export const syntheticAddonApiModule: ApiModuleContribution<unknown> = {
  moduleId: "synthetic-addon",
  routes: { "/admin/synthetic-addon": handled },
  setup: setup("synthetic_addon_items"),
  cleanup: { steps: [{ kind: "delete", table: "synthetic_addon_items" }, { kind: "assignments" }] },
  freshEnable: (db) => [db.prepare("INSERT OR IGNORE INTO synthetic_addon_items(installation_id,id,label) VALUES('primary','starter','Starter item')")],
  backup: { version: 1, tables: { synthetic_addon_items: ["installation_id", "id", "label"] } },
};

export const externalApiModules: readonly ApiModuleContribution<unknown>[] = [syntheticNotesApiModule, syntheticAddonApiModule];
