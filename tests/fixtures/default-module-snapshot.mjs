import { externalModuleManifests } from "../../packages/shared/src/generated/external-manifests.ts";
const attendance = {
  id: "attendance",
  label: "Attendance",
  description: "Meetings, check-ins, corrections, attendance calculations, kiosks, and attendance delivery workflows.",
  contractVersion: 1,
  enabled: true,
  phase: "enabled",
  generation: 1,
  dependencies: [],
  permissions: [{ id: "attendance.manage", label: "Manage Attendance", operator: true }],
  effectiveCapabilities: ["attendance.manage"],
  workspaceReady: true,
  navigation: [{ label: "Meetings", path: "/dashboard" }, { label: "Kiosks", path: "/kiosks" }],
  settings: [{ label: "Attendance", path: "/settings/attendance" }],
  setup: {
    version: 2,
    ready: true,
    steps: [
      { id: "rules", label: "Attendance rules", required: true },
      { id: "meeting", label: "First meeting", required: true },
      { id: "input", label: "Verified attendance input", required: true },
      { id: "calendar", label: "Calendar integration", required: false },
      { id: "discord", label: "Discord integration", required: false },
    ],
  },
  deletion: {
    disabledAt: null,
    deleteAfter: null,
    contentStillPresent: false,
    cleanupFailure: null,
    data: [
      "Meetings and meeting templates",
      "Attendance events and corrections",
      "Kiosk, simulator, and pairing records",
      "Attendance policy and delivery records",
    ],
  },
};

// Composed plugins (none in a plugin-free build; official Outreach in an installation build) start disabled, so the preview
// matches the dashboard's registry.
const plugins = externalModuleManifests.map((definition) => ({
  id: definition.id,
  label: definition.label,
  description: definition.description,
  contractVersion: definition.contractVersion,
  enabled: false,
  phase: "disabled",
  generation: 1,
  dependencies: definition.dependencies,
  permissions: definition.capabilities,
  effectiveCapabilities: [],
  workspaceReady: false,
  navigation: definition.navigation,
  settings: definition.settings,
  setup: { ...definition.setup, ready: false },
  deletion: { disabledAt: null, deleteAfter: null, contentStillPresent: false, cleanupFailure: null, data: definition.deletedData },
}));

export const defaultModuleSnapshot = {
  revision: 0,
  selectionCompleted: true,
  capabilities: ["attendance.manage"],
  modules: [attendance, ...plugins],
};
