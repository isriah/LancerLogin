import type { WalkthroughPage } from "../../../packages/shared/src/walkthrough";
import type { WalkthroughExperienceDefinition } from "./page-walkthrough";

const definitions: Record<Exclude<WalkthroughPage, "dashboard">, WalkthroughExperienceDefinition> = {
  roster: {
    pageId: "roster",
    readySelector: '[data-walkthrough-page="roster"][data-walkthrough-ready="true"]',
    returnFocusSelector: '[data-walkthrough-page="roster"]',
    welcomeTitle: "Get to know your roster",
    welcomeDescription: "Learn to find members, read attendance status, open profiles, and understand Admin roster tools. This tour will not change member records.",
    finishTitle: "You're ready to work with the roster",
    finishDescription: "Find a member, open their history, or use the available Admin tools when roster records need attention.",
    steps: [
      { id: "summary", title: "Read the roster at a glance", description: "The summary separates active members from the complete roster. Inactive records remain available when you need historical context.", targets: '[data-walkthrough="roster-summary"]' },
      { id: "filters", title: "Find the right people", description: "Search by name, email, member ID, or Discord ID. Show changes between active and complete history, while Label narrows the list to a current group.", targets: '[data-walkthrough="roster-filters"]' },
      { id: "member-rows", title: "Open a member profile", description: "A member's name opens their profile and complete attendance history. Each row also shows identifiers, current labels, roster status, and available integration identity.", targets: '[data-walkthrough="roster-list"]' },
      { id: "attendance", title: "Interpret attendance", description: "Regular attendance matches the default Reports calculation. Assigned label policies can use their own windows and targets, so a member may show more than one result.", targets: '.roster-attendance-rate, [data-walkthrough="roster-list"]' },
      { id: "member-actions", title: "Understand member actions", description: "Admins can add or edit a member, change active status, and delete a record only when no attendance history prevents it. Operators can inspect the same roster without mutation controls.", targets: '[data-walkthrough="roster-actions"], [data-walkthrough="roster-list"]' },
      { id: "bulk-tools", title: "Update groups carefully", description: "Admins can use Bulk edit for label or roster changes, and CSV import previews changes before applying them. Operators can review the roster without these tools.", targets: '[data-walkthrough="roster-bulk"], [data-walkthrough="roster-actions"]' },
    ],
  },
  member: {
    pageId: "member",
    readySelector: '[data-walkthrough-page="member"][data-walkthrough-ready="true"]',
    returnFocusSelector: '[data-walkthrough-page="member"]',
    welcomeTitle: "Understand this member",
    welcomeDescription: "Learn to read a member's profile, attendance policy, and meeting history. This tour will not change the member.",
    finishTitle: "You're ready to review a member",
    finishDescription: "Use the profile for current status and the history table for meeting-by-meeting attendance evidence.",
    steps: [
      { id: "profile", title: "Start with the member profile", description: "The profile combines contact details, roster status, attendance start date, current labels, and integration identity when available.", targets: '[data-walkthrough="member-profile"]' },
      { id: "labels", title: "Use labels as current context", description: "Current labels describe the groups this member belongs to now. Debug mode can also expose dated label history for troubleshooting.", targets: '[data-walkthrough="member-labels"], [data-walkthrough="member-profile"]' },
      { id: "attendance-policy", title: "Read attendance results", description: "Regular attendance covers required meetings in the standard calculation. Assigned policies show label-specific targets, windows, and whether the member currently meets them.", targets: '[data-walkthrough="member-policies"]' },
      { id: "history", title: "Review meeting evidence", description: "Complete attendance history lists scan times, outcome, eligibility, and correction reasons. Present, Excuse, and Absent record a reviewed outcome; Admin Clear removes the meeting's recorded attendance after confirmation.", targets: '[data-walkthrough="member-history"]' },
      { id: "member-actions", title: "Know which changes are available", description: "Admins can edit details, activate or deactivate the member, or delete an unused record. Operators can review the profile and history without those controls.", targets: '[data-walkthrough="member-actions"], [data-walkthrough="member-profile"]' },
    ],
  },
  reports: {
    pageId: "reports",
    readySelector: '[data-walkthrough-page="reports"][data-walkthrough-ready="true"]',
    returnFocusSelector: '[data-walkthrough-page="reports"]',
    welcomeTitle: "Turn attendance into answers",
    welcomeDescription: "Learn to filter the leaderboard, read trends, and understand saved report tabs and exports. You can choose to add a personal example report that stays saved after the tour.",
    finishTitle: "You're ready to explore reports",
    finishDescription: "Use the Leaderboard for a standard view, or create and pin a report when you need a reusable question answered.",
    steps: [
      { id: "tabs", title: "Move between report views", description: "Leaderboard is the shared starting point. Pinned reports become tabs, Browse reports finds saved views, and the plus button starts a new report.", targets: '[data-walkthrough="reports-tabs"]' },
      { id: "filters", title: "Choose the population and period", description: "Filters control the date range, meeting type, roster scope, and label membership used in the result. Operational baseline is available when it has been configured.", targets: '[data-walkthrough="reports-filters"], [data-walkthrough="report-builder"]' },
      { id: "leaderboard", title: "Read the result rows", description: "The result compares regular attendance with assigned policies. Member names open the same profile and attendance history available from Roster.", targets: '[data-walkthrough="reports-results"]' },
      { id: "trend", title: "Look for team movement", description: "The trend summarizes weighted regular attendance across completed required meetings. Change the visible meeting count to compare short and longer patterns.", targets: '[data-walkthrough="reports-trend"]' },
      { id: "report-builder", title: "Build a reusable report", description: "A custom report chooses its audience, time period, columns, filters, and sort order. Personal reports belong to you; shared reports are available to other authorized users.", targets: '[data-walkthrough="report-builder"], [data-walkthrough="reports-tabs"]' },
      { id: "report-actions", title: "Save, pin, export, or remove", description: "Save keeps the report, pinning makes it a tab, and CSV actions export the current definition. Delete report removes the saved view after confirmation, not the underlying attendance data.", targets: '[data-walkthrough="report-actions"], [data-walkthrough="reports-tabs"]' },
    ],
  },
  meeting: {
    pageId: "meeting",
    readySelector: '[data-walkthrough-page="meeting"][data-walkthrough-ready="true"]',
    returnFocusSelector: '[data-walkthrough-page="meeting"]',
    welcomeTitle: "Manage this meeting's attendance",
    welcomeDescription: "Learn to read meeting status, review scans, make corrections, and understand meeting actions. This tour will not change attendance or contact providers.",
    finishTitle: "You're ready to manage a meeting",
    finishDescription: "Use the summary for context, the attendance table for evidence, and correction tools only when the recorded outcome needs review.",
    steps: [
      { id: "navigation", title: "Move between meetings", description: "Back to Dashboard returns to the meeting browser. Switch meeting opens another meeting workspace without making you search again.", targets: '[data-walkthrough="meeting-navigation"]' },
      { id: "summary", title: "Confirm the meeting context", description: "Lifecycle, date, time, attendance requirement, audience, weight, recurrence, and notes explain how this meeting contributes to attendance.", targets: '[data-walkthrough="meeting-summary"]' },
      { id: "management", title: "Understand meeting changes", description: "Edit changes this occurrence or future series items when available. Duplicate creates a new schedule from this meeting. Delete asks for scope and returns an Undo opportunity on Dashboard.", targets: '[data-walkthrough="meeting-management"]' },
      { id: "integrations", title: "Run provider actions deliberately", description: "When configured, calendar sync updates this meeting and Discord can notify linked absent members after attendance begins. These actions contact external providers.", targets: '[data-walkthrough="meeting-integrations"]' },
      { id: "contests", title: "Review attendance contests", description: "Open contest requests show the member's evidence and prior context. Approval may change attendance; rejection or review keeps the recorded outcome according to the selected resolution.", targets: '[data-walkthrough="meeting-contests"]' },
      { id: "attendance", title: "Read scans and outcomes", description: "Each row shows the member, eligibility, authoritative check-in and check-out times, current outcome, and whether the meeting counts toward their rate.", targets: '[data-walkthrough="meeting-attendance"]' },
      { id: "corrections", title: "Use corrections with context", description: "Present, Excuse, and Absent record a reviewed outcome and may require a reason. Admin Clear removes recorded attendance for this meeting after confirmation.", targets: '[data-walkthrough="meeting-corrections"], [data-walkthrough="meeting-attendance"]' },
    ],
  },
  kiosks: {
    pageId: "kiosks",
    readySelector: '[data-walkthrough-page="kiosks"][data-walkthrough-ready="true"]',
    returnFocusSelector: '[data-walkthrough-page="kiosks"]',
    welcomeTitle: "Understand kiosk health",
    welcomeDescription: "Learn to read physical kiosk status, diagnostics, management actions, and the browser simulator. This tour will not send device commands.",
    finishTitle: "You're ready to monitor kiosks",
    finishDescription: "Use health and diagnostics to decide whether the kiosk needs attention, then choose the smallest appropriate Admin action.",
    steps: [
      { id: "status", title: "Start with physical status", description: "Healthy, degraded, offline, and not paired summarize whether the physical kiosk can scan and synchronize attendance normally.", targets: '[data-walkthrough="kiosk-status"]' },
      { id: "diagnostics", title: "Find the cause", description: "Reader, network, pending scans, last sync, release, heartbeat, and reported issue fields show where a degraded or offline state begins.", targets: '[data-walkthrough="kiosk-diagnostics"], [data-walkthrough="kiosk-status"]' },
      { id: "pairing", title: "Pair or replace hardware", description: "Admins create a short-lived one-time key for a Pi. Replacing a kiosk retires the old credential only after the new key is redeemed.", targets: '[data-walkthrough="kiosk-pairing"]' },
      { id: "device-actions", title: "Choose device actions carefully", description: "The controls below manage the physical kiosk. When Discord is configured, Sync Discord status refreshes its health message. Operators can monitor health without Admin controls. An example device is shown if no kiosk is paired.", targets: '[data-walkthrough="kiosk-actions"], [data-walkthrough="kiosk-status"]' },
      { id: "rename", title: "Give the kiosk a clear name", description: "Rename changes the device label shown here. Use a location or purpose that helps staff identify the right Pi.", targets: '[data-walkthrough="kiosk-rename"], [data-walkthrough="kiosk-status"]' },
      { id: "fingerprints", title: "Manage fingerprints at the kiosk", description: "Fingerprint maintenance explains how to open the Pi's local tools. Hold its organization name or logo for three seconds and enter the settings PIN to enroll, test, or remove mappings. Templates remain on the sensor.", targets: '[data-walkthrough="kiosk-fingerprints"], [data-walkthrough="kiosk-status"]' },
      { id: "restart", title: "Recover the display or software", description: "Reload display refreshes the kiosk screen. Restart software restarts the attendance service. Reboot Pi restarts the device and pauses scanning while it comes back online.", targets: '[data-walkthrough="kiosk-reload"], [data-walkthrough="kiosk-restart"], [data-walkthrough="kiosk-reboot"], [data-walkthrough="kiosk-status"]' },
      { id: "network-pin", title: "Recover access to local settings", description: "Reset network PIN clears the local settings PIN after confirmation. Someone at the kiosk can then set a new PIN. Use this only when authorized staff need to regain access.", targets: '[data-walkthrough="kiosk-network-pin"], [data-walkthrough="kiosk-status"]' },
      { id: "updates", title: "Update the physical kiosk", description: "Compare the installed and latest stable versions before updating. Update to latest stable becomes available when the kiosk is online and the release is confirmed. This updates the Pi separately from the dashboard.", targets: '[data-walkthrough="kiosk-update"], [data-walkthrough="kiosk-diagnostics"]' },
      { id: "retirement", title: "Retire a device deliberately", description: "Retire kiosk invalidates this device's credential after confirmation and preserves its history. Use Replace kiosk instead when you want the old device to keep working until the replacement pairs.", targets: '[data-walkthrough="kiosk-retire"], [data-walkthrough="kiosk-status"]' },
      { id: "simulator", title: "Use the browser simulator", description: "Admins can use the simulator for audited browser-selected reads. It does not claim physical reader, heartbeat, or fingerprint activity, and Operators do not receive simulator controls.", targets: '[data-walkthrough="kiosk-simulator"]' },
      { id: "history", title: "Keep device history", description: "Retired kiosks remain listed with pairing, last-seen, and release information so device changes can be reviewed later.", targets: '[data-walkthrough="kiosk-history"], [data-walkthrough="kiosk-status"]' },
    ],
  },
  simulator: {
    pageId: "simulator",
    readySelector: '[data-walkthrough-page="simulator"][data-walkthrough-ready="true"]',
    returnFocusSelector: '[data-walkthrough-page="simulator"]',
    welcomeTitle: "Practice the kiosk scan flow",
    welcomeDescription: "Learn what the browser simulator represents and how to choose a test member and meeting. The tour itself will not submit a simulated scan.",
    finishTitle: "You're ready to use the simulator",
    finishDescription: "Choose a synthetic test member and meeting when you want to verify the scan experience without claiming physical kiosk activity.",
    steps: [
      { id: "boundary", title: "Know the simulator boundary", description: "This page uses browser input and the shared kiosk display contract. It cannot pair hardware, report a physical heartbeat, or read fingerprint templates.", targets: '[data-walkthrough="simulator-boundary"]' },
      { id: "preview", title: "Watch the kiosk display", description: "The preview shows the same ready, processing, welcome, goodbye, and rejected states used by the physical kiosk presentation.", targets: '[data-walkthrough="simulator-preview"]' },
      { id: "inputs", title: "Choose a member and meeting", description: "Roster member identifies who is scanning. Meeting chooses the attendance window that will receive the simulated read.", targets: '[data-walkthrough="simulator-inputs"]' },
      { id: "simulate", title: "Submit an audited simulated read", description: "Simulate member read sends an explicitly simulated attendance event. It can affect test attendance data, but never counts as physical kiosk activity.", targets: '[data-walkthrough="simulator-submit"], [data-walkthrough="simulator-inputs"]' },
    ],
  },
};

export function pageWalkthroughForPath(path: string, role: "admin" | "operator") {
  if (path === "/roster") return definitions.roster;
  if (path.startsWith("/roster/") && path.slice("/roster/".length)) return definitions.member;
  if (path === "/reports" || path === "/reports/new" || path.startsWith("/reports/view/")) return definitions.reports;
  if (path.startsWith("/meetings/") && path.slice("/meetings/".length)) return definitions.meeting;
  if (path === "/kiosks") return definitions.kiosks;
  if (role === "admin" && path === "/simulator") return definitions.simulator;
  return undefined;
}
