// Test-only composition of two unshipped plugin manifests. Tests substitute this file for the generated manifest list.
import type { ModuleDefinition } from "../../../packages/shared/src/module-platform.ts";

export const syntheticNotesModule: ModuleDefinition = {
  id: "synthetic-notes",
  label: "Synthetic Notes",
  description: "Unshipped test plugin with portable notes, tags and queued work.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  capabilities: [{ id: "synthetic-notes.manage", label: "Manage Synthetic Notes", operator: true }],
  navigation: [],
  settings: [],
  setup: { version: 1, steps: [{ id: "workspace", label: "First note", required: true }] },
  jobs: [],
  discordCommands: [],
  reportDatasets: [],
  apiRoutes: [{ path: "/admin/synthetic-notes", match: "prefix", access: "workspace" }],
  persistence: {
    tables: ["synthetic_notes_entries", "synthetic_notes_tags", "synthetic_notes_jobs", "synthetic_notes_tokens"],
    sharedFields: [],
    transientAuthority: [{ table: "synthetic_notes_jobs", columns: ["status", "lease_token"] }],
  },
  backup: { version: 2, tables: ["synthetic_notes_entries", "synthetic_notes_tags", "synthetic_notes_jobs"], nonPortableTables: ["synthetic_notes_tokens"] },
  lifecycle: { cleanupTargets: ["synthetic_notes_tokens", "synthetic_notes_jobs", "synthetic_notes_tags", "synthetic_notes_entries", "platform_module_setup_progress:synthetic-notes", "platform_module_assignments:synthetic-notes"] },
  deletedData: ["Synthetic notes, tags and queued work"],
};

export const syntheticAddonModule: ModuleDefinition = {
  id: "synthetic-addon",
  label: "Synthetic Add-on",
  description: "Unshipped test plugin that depends on Synthetic Notes.",
  contractVersion: 1,
  available: true,
  dependencies: ["synthetic-notes"],
  capabilities: [{ id: "synthetic-addon.manage", label: "Manage Synthetic Add-on", operator: true }],
  navigation: [],
  settings: [],
  setup: { version: 1, steps: [{ id: "workspace", label: "First item", required: true }] },
  jobs: [],
  discordCommands: [],
  reportDatasets: [],
  apiRoutes: [{ path: "/admin/synthetic-addon", match: "prefix", access: "workspace" }],
  persistence: { tables: ["synthetic_addon_items"], sharedFields: [], transientAuthority: [] },
  backup: { version: 1, tables: ["synthetic_addon_items"] },
  lifecycle: { cleanupTargets: ["synthetic_addon_items", "platform_module_setup_progress:synthetic-addon", "platform_module_assignments:synthetic-addon"] },
  deletedData: ["Synthetic add-on items"],
};

export const externalModuleManifests: readonly ModuleDefinition[] = [syntheticNotesModule, syntheticAddonModule];

/** Plugin migrations for the test database. */
export const syntheticPluginSchema = `
CREATE TABLE synthetic_notes_entries (installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, id TEXT NOT NULL, member_id TEXT REFERENCES members(id) ON DELETE SET NULL, body TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(installation_id, id));
CREATE TABLE synthetic_notes_tags (installation_id TEXT NOT NULL, note_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(installation_id, note_id, tag), FOREIGN KEY(installation_id, note_id) REFERENCES synthetic_notes_entries(installation_id, id));
CREATE TABLE synthetic_notes_jobs (installation_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, lease_token TEXT, PRIMARY KEY(installation_id, id));
CREATE TABLE synthetic_notes_tokens (installation_id TEXT NOT NULL, token TEXT NOT NULL);
CREATE TABLE synthetic_addon_items (installation_id TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(installation_id, id));
`;
