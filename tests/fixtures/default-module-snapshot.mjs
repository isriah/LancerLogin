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
  settings: [{ label: "Attendance", path: "/settings/attendance" }, { label: "Kiosk Simulator", path: "/settings/kiosk-simulator" }],
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

const outreach = {
  id: "hour-tracking",
  label: "Outreach Participation",
  description: "Outreach labels, supported teams, dated activities, member submissions, staff exceptions, and participation totals.",
  contractVersion: 1,
  enabled: false,
  phase: "disabled",
  generation: 1,
  dependencies: [],
  permissions: [{ id: "hours.manage", label: "Manage Outreach Participation", operator: true }],
  effectiveCapabilities: [],
  workspaceReady: false,
  navigation: [{ label: "Outreach", path: "/hours" }],
  settings: [{ label: "Outreach", path: "/settings/outreach-setup" }],
  setup: {
    version: 1,
    ready: false,
    steps: [
      { id: "rules", label: "Entry rules", required: true },
      { id: "catalog", label: "Labels and supported teams", required: true },
    ],
  },
  deletion: {
    disabledAt: null,
    deleteAfter: null,
    contentStillPresent: false,
    cleanupFailure: null,
    data: [
      "Outreach labels, supported teams, and activities",
      "Member submissions, staff exceptions, integer-minute totals, and immutable entry history",
      "Outreach setup and assignment records",
    ],
  },
};

const carpool = {
  id: "carpool",
  label: "Carpool",
  description: "Independent outbound and return ride planning with optional roster and event references.",
  contractVersion: 1,
  enabled: false,
  phase: "disabled",
  generation: 1,
  dependencies: [],
  permissions: [{ id: "carpool.manage", label: "Manage Carpool", operator: true }],
  effectiveCapabilities: [],
  workspaceReady: false,
  navigation: [{ label: "Carpool", path: "/carpool" }],
  settings: [],
  setup: { version: 1, ready: false, steps: [{ id: "workspace", label: "First Carpool plan", required: true }] },
  deletion: { disabledAt: null, deleteAfter: null, contentStillPresent: false, cleanupFailure: null, data: ["Carpool plans and optional event snapshots", "Participants, locations, vehicles, assignments, imports, and unresolved ride reasons"] },
};

export const defaultModuleSnapshot = {
  revision: 0,
  selectionCompleted: true,
  capabilities: ["attendance.manage"],
  modules: [attendance, outreach, carpool],
};
