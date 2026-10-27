export type DashboardConformanceOwner = "01-authentication" | "02-meetings" | "03-reporting" | "04-kiosks" | "05-settings" | "06-convergence";

export type DashboardConformanceSurface = {
  owner: DashboardConformanceOwner;
  area: string;
  routes: readonly string[];
  overlays: readonly string[];
  states: readonly string[];
  browserSpecs: readonly string[];
};

export const dashboardConformanceMatrix = [
  { owner: "01-authentication", area: "Authentication", routes: ["boot/auth check", "first-Admin bootstrap", "local sign-in", "Google sign-in"], overlays: ["authentication validation and recovery states"], states: ["loading", "validation", "pending", "denied", "locked", "error", "Google-only", "dual-auth"], browserSpecs: ["auth-setup-conformance.spec.ts"] },
  { owner: "01-authentication", area: "Guided setup", routes: ["embedded guided setup", "/settings/guided-setup"], overlays: ["setup completion dialog"], states: ["organization", "roster", "kiosk or simulator", "input test", "attendance confirmation", "skipped", "completed"], browserSpecs: ["auth-setup-conformance.spec.ts", "onboarding-first-meeting.spec.ts"] },
  { owner: "02-meetings", area: "Dashboard", routes: ["/dashboard", "/meetings"], overlays: ["meeting creation dialog", "Undo status"], states: ["Calendar", "Table", "search", "selection", "bulk actions", "empty", "error", "redirect", "session-only deletion Undo"], browserSpecs: ["dashboard-meeting-browser.spec.ts", "meeting-deletion-undo.spec.ts", "convergence-audit.spec.ts"] },
  { owner: "02-meetings", area: "Meeting detail", routes: ["/meetings/[ID]", "/attendance", "/attendance?meetingId=[ID]"], overlays: ["meeting edit dialog", "meeting duplicate dialog", "meeting delete dialog"], states: ["lifecycle", "Discord gates", "contest review", "attendance", "unavailable", "redirect"], browserSpecs: ["meeting-workspace-conformance.spec.ts"] },
  { owner: "03-reporting", area: "Reports", routes: ["/reports"], overlays: ["contest review workspace"], states: ["filters", "saved views", "trend", "leaderboard", "CSV", "empty", "preserved history"], browserSpecs: ["roster-reporting-conformance.spec.ts", "modular-reporting.spec.ts"] },
  { owner: "03-reporting", area: "Roster", routes: ["/roster", "/roster/[ID]"], overlays: ["add member dialog", "edit member dialog", "roster import dialog"], states: ["search", "filter", "preview", "import error", "active", "inactive", "linked", "unlinked", "unavailable"], browserSpecs: ["roster-reporting-conformance.spec.ts", "member-detail.spec.ts"] },
  { owner: "04-kiosks", area: "Kiosks dashboard", routes: ["/kiosks", "/simulator dashboard entry"], overlays: ["kiosk pairing dialog", "fingerprint mapping reset confirmation"], states: ["paired", "unpaired", "healthy", "degraded", "offline", "maintenance", "device history", "action feedback", "fingerprint cloud storage consent", "vault key recovery", "fingerprint re-enrollment", "pending offline mapping reset", "rejected scan review"], browserSpecs: ["kiosks-conformance.spec.ts", "fingerprint-reset.spec.ts"] },
  { owner: "05-settings", area: "Settings", routes: ["/settings/organization", "/settings/configuration", "/settings/access", "/settings/integrations", "/settings/data", "/settings/guided-setup", "/settings/updates"], overlays: ["data backup dialog", "data restore dialog", "data deletion dialog"], states: ["enabled", "disabled", "configured", "validation", "confirmation", "degraded", "success", "error"], browserSpecs: ["settings-conformance.spec.ts", "updates-page.spec.ts", "update-channels.spec.ts"] },
  { owner: "05-settings", area: "Plugin management", routes: ["/settings/modules", "/settings/updates module migration notice"], overlays: ["plugin change dialog"], states: ["credential missing", "module moved into a plugin", "installed", "pending not deployed", "review", "incompatible", "re-authentication", "locked by update", "apply plugin changes", "light", "dark", "mobile", "keyboard"], browserSpecs: ["plugin-management.spec.ts"] },
  { owner: "06-convergence", area: "Outreach staff workspace", routes: ["/hours", "/hours/activities/[ID]"], overlays: ["activity creation dialog", "activity edit dialog", "participation edit and deletion dialogs", "publication destination menu", "catalog creation and edit dialogs", "activity correction dialog", "Outreach walkthrough"], states: ["Calendar", "Table", "Submission Log", "supported teams", "labels", "member totals", "expanded submissions", "publication icons", "reporting status", "catalog tabs and search", "logged-order paging", "paging error", "activity correction selection", "empty", "error", "Admin", "Operator"], browserSpecs: ["outreach-workflow.spec.ts", "outreach-activity-detail.spec.ts", "outreach-feedback.spec.ts"] },
  { owner: "06-convergence", area: "Public Outreach participation", routes: ["/submit-hours"], overlays: ["time picker"], states: ["available", "closed", "validation", "pending", "success", "uncertain retry", "light", "dark", "mobile"], browserSpecs: ["outreach-workflow.spec.ts", "outreach-feedback.spec.ts", "outreach-public-time-order.spec.ts", "outreach-public-privacy.spec.ts"] },
  { owner: "06-convergence", area: "Final convergence", routes: ["all governed dashboard routes"], overlays: ["loading overlay", "contest dialog", "update popup", "all governed dialogs"], states: ["desktop", "mobile", "light", "dark", "adopter brand", "Admin", "Operator", "keyboard", "touch", "reduced motion", "native controls", "scroll regions"], browserSpecs: ["convergence-audit.spec.ts", "ui-foundations.spec.ts"] },
] as const satisfies readonly DashboardConformanceSurface[];

export const dashboardConformanceReferences = {
  viewports: [{ width: 1280, height: 900 }, { width: 390, height: 844 }],
  themes: ["light", "dark"],
  brand: { primary: "#7c3aed", secondary: "#0f766e" },
  input: ["pointer", "keyboard"],
  motion: ["no-preference", "reduce"],
  roles: ["admin", "operator"],
} as const;

/**
 * A stylesheet that a first-party module's dashboard contribution loads. Core keeps module-owned classes out of its own
 * stylesheets. Plugins ship their stylesheets in their own repositories; a plugin's test harness applies the same scope checks.
 */
export type DashboardModuleStylesheet = {
  moduleId: string;
  /** File in apps/dashboard/src, imported only by the module's dashboard contribution. */
  stylesheet: string;
  contribution: string;
  /** Class prefix the module owns. */
  classPrefix: string;
  browserSpecs: readonly string[];
};

export const dashboardModuleStylesheets: readonly DashboardModuleStylesheet[] = [];

/** Every module stylesheet selector sits beneath this zero-specificity module root scope, which Core renders around module pages and slot content. */
export function dashboardModuleScope(moduleId: string) {
  return `:where([data-module="${moduleId}"])`;
}
