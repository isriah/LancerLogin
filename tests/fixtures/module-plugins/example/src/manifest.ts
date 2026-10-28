// Synthetic, unshipped module definition for composition tests. It declares every contribution point a plugin
// can use: a job, a Discord command, a report dataset, workspace, public service and setup routes, and an interface other
// modules call (tests/fixtures/module-plugins/consumer uses it).
const text = ["contains", "equals", "empty", "not_empty"] as const;
const number = ["minimum", "equals", "maximum", "between", "empty", "not_empty"] as const;

const manifest = {
  id: "example",
  label: "Example",
  description: "Synthetic external module that exercises every plugin contribution point.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  capabilities: [{ id: "example.manage", label: "Manage Example", operator: true }],
  interfaces: [{
    id: "example.items", version: 1, label: "Example items",
    operations: [
      { id: "list", label: "List Example items", capability: "example.manage", grantable: true },
      { id: "create", label: "Create Example items", capability: "example.manage", grantable: true },
      { id: "close", label: "Close Example items", capability: "example.manage", grantable: false },
    ],
  }],
  navigation: [{ label: "Example", path: "/example" }],
  settings: [{ label: "Example", path: "/settings/example" }],
  setup: { version: 1, steps: [{ id: "catalog", label: "First Example item", required: true }] },
  jobs: [{ id: "example.digest", interval: 300_000 }],
  discordCommands: [{ name: "example-status", type: 1, description: "Show how many Example items are open", options: [{ name: "title", description: "Only count items with this exact title", type: 3 }] }],
  reportDatasets: [{
    id: "example.items", label: "Example items", description: "Synthetic Example items with public request totals.", rowIdentity: "example.item.id", capability: "example.manage",
    fields: [
      { id: "example.item.id", label: "Item record ID", group: "Item", kind: "dimension", valueType: "text", sortable: true, filterOperators: text },
      { id: "example.item.title", label: "Title", group: "Item", kind: "dimension", valueType: "text", sortable: true, filterOperators: text },
      { id: "example.item.requests", label: "Public requests", group: "Item", kind: "measure", valueType: "number", sortable: true, filterOperators: number },
    ],
    filters: [], groupBy: ["example.item.id"], defaultColumns: ["example.item.title", "example.item.requests"], defaultSort: { field: "example.item.title", direction: "asc" }, relationships: [],
  }],
  apiRoutes: [
    { path: "/module-setup/example", match: "prefix", access: "setup" },
    { path: "/admin/example", match: "prefix", access: "workspace" },
    { path: "/public/example", match: "prefix", access: "service" },
  ],
  tablePrefix: "example_",
  persistence: { tables: ["example_items", "example_requests"], sharedFields: [], transientAuthority: [] },
  backup: { version: 1, tables: ["example_items"], nonPortableTables: ["example_requests"] },
  lifecycle: { cleanupTargets: ["example_requests", "example_items", "platform_module_setup_progress:example", "platform_module_assignments:example"] },
  deletedData: ["Example items and their public requests"],
} as const;

export default manifest;
