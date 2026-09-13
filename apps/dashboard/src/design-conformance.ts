export type DashboardConformanceOwner = "01-authentication" | "02-meetings" | "03-reporting" | "04-kiosks" | "05-settings" | "06-convergence";

export type DashboardConformanceSurface = {
  owner: DashboardConformanceOwner;
  area: string;
  routes: readonly string[];
  overlays: readonly string[];
  states: readonly string[];
};

export const dashboardConformanceMatrix = [
  { owner: "01-authentication", area: "Authentication", routes: ["boot/auth check", "first-Admin bootstrap", "local sign-in", "Google sign-in"], overlays: ["authentication validation and recovery states"], states: ["loading", "validation", "pending", "denied", "locked", "error", "Google-only", "dual-auth"] },
  { owner: "01-authentication", area: "Guided setup", routes: ["embedded guided setup", "/settings/guided-setup"], overlays: ["setup completion dialog"], states: ["organization", "roster", "kiosk or simulator", "input test", "attendance confirmation", "skipped", "completed"] },
  { owner: "02-meetings", area: "Dashboard", routes: ["/dashboard", "/meetings"], overlays: ["meeting creation dialog", "Undo status"], states: ["Calendar", "Table", "search", "selection", "bulk actions", "empty", "error", "redirect"] },
  { owner: "02-meetings", area: "Meeting detail", routes: ["/meetings/[ID]", "/attendance", "/attendance?meetingId=[ID]"], overlays: ["meeting edit dialog", "meeting duplicate dialog", "meeting delete dialog"], states: ["lifecycle", "Discord gates", "contest review", "attendance", "unavailable", "redirect"] },
  { owner: "03-reporting", area: "Reports", routes: ["/reports"], overlays: ["contest review workspace"], states: ["filters", "saved views", "trend", "leaderboard", "CSV", "empty", "preserved history"] },
  { owner: "03-reporting", area: "Roster", routes: ["/roster", "/roster/[ID]"], overlays: ["add member dialog", "edit member dialog", "roster import dialog"], states: ["search", "filter", "preview", "import error", "active", "inactive", "linked", "unlinked", "unavailable"] },
  { owner: "04-kiosks", area: "Kiosks dashboard", routes: ["/kiosks", "/simulator dashboard entry"], overlays: ["kiosk pairing dialog"], states: ["paired", "unpaired", "healthy", "degraded", "offline", "maintenance", "device history", "action feedback"] },
  { owner: "05-settings", area: "Settings", routes: ["/settings/organization", "/settings/configuration", "/settings/access", "/settings/integrations", "/settings/data", "/settings/guided-setup", "/settings/updates"], overlays: ["data backup dialog", "data restore dialog", "data deletion dialog"], states: ["enabled", "disabled", "configured", "validation", "confirmation", "degraded", "success", "error"] },
  { owner: "06-convergence", area: "Final convergence", routes: ["all governed dashboard routes"], overlays: ["loading overlay", "contest dialog", "update popup", "all governed dialogs"], states: ["desktop", "mobile", "light", "dark", "adopter brand", "Admin", "Operator", "keyboard", "reduced motion"] },
] as const satisfies readonly DashboardConformanceSurface[];

export const dashboardConformanceReferences = {
  viewports: [{ width: 1280, height: 900 }, { width: 390, height: 844 }],
  themes: ["light", "dark"],
  brand: { primary: "#7c3aed", secondary: "#0f766e" },
  input: ["pointer", "keyboard"],
  motion: ["no-preference", "reduce"],
  roles: ["admin", "operator"],
} as const;
