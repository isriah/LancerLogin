// Synthetic, unshipped module definition for cross-module tests. It optionally uses the Example plugin's `example.items`
// interface: from a job (with an Admin's grant), a workspace route (with the signed-in user's access) and a public route.
const manifest = {
  id: "consumer",
  label: "Consumer",
  description: "Synthetic external module that calls another module's interface.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  capabilities: [{ id: "consumer.manage", label: "Manage Consumer", operator: true }],
  navigation: [],
  settings: [],
  setup: { version: 1, steps: [{ id: "settings", label: "Consumer settings", required: true }] },
  jobs: [{ id: "consumer.sync", interval: 300_000, label: "Consumer sync" }],
  discordCommands: [],
  apiRoutes: [
    { path: "/admin/consumer", match: "prefix", access: "workspace" },
    { path: "/public/consumer", match: "prefix", access: "service" },
  ],
  uses: [{ interface: "example.items", version: 1, operations: ["list", "create", "close"], required: false, reason: "Copy Example items into Consumer runs" }],
  tablePrefix: "consumer_",
  persistence: { tables: ["consumer_settings", "consumer_runs"], sharedFields: [], transientAuthority: [] },
  backup: { version: 1, tables: ["consumer_settings", "consumer_runs"] },
  lifecycle: { cleanupTargets: ["consumer_runs", "consumer_settings", "platform_module_setup_progress:consumer", "platform_module_assignments:consumer"] },
  deletedData: ["Consumer settings and recorded runs"],
} as const;

export default manifest;
