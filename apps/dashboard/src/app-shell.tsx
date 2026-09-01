import { useEffect, useState } from "react";
import type { Branding } from "./setup-workspace";
import { SetupWorkspace } from "./setup-workspace";
import { AttendanceWorkspace } from "./attendance-workspace";
import { HomePage } from "./home-page";
import { MeetingsPage } from "./meetings-page";
import { ReportsPage } from "./reports-page";
import { RosterPage } from "./roster-page";
import { OrganizationSettings } from "./organization-settings";
import { IntegrationSettings } from "./integration-settings";
import { PrivacySettings } from "./privacy-settings";
import { DataSettings } from "./data-settings";
import { UpdatesPage } from "./updates-page";
import { KiosksPage } from "./kiosks-page";
import { api } from "./dashboard-api";
import { RouteLink, usePath } from "./router";
import { UpdateIndicator } from "./update-indicator";

export function AppShell({ role, branding, onBrandingChanged, onSignedOut }: { role: "admin" | "operator"; branding: Branding; onBrandingChanged: (branding: Branding) => void; onSignedOut: () => void }) {
  const { path, navigate } = usePath(); const [setupKey, setSetupKey] = useState(0); const [onboarding, setOnboarding] = useState(role === "admin" ? undefined as boolean | undefined : false);
  useEffect(() => { if (role !== "admin") return; void api<{ completedSteps: unknown[] }>("/admin/setup/progress").then((result) => setOnboarding(result.completedSteps.length < 6)).catch(() => setOnboarding(false)); }, [role, setupKey]);
  useEffect(() => { if (onboarding) window.requestAnimationFrame(() => { window.scrollTo({ top: 0, behavior: "auto" }); document.getElementById("dashboard-content")?.focus(); }); }, [onboarding, setupKey]);
  function openSetup() { setOnboarding(true); window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" })); }
  const primary = [["/dashboard", "Home"], ["/meetings", "Meetings"], ["/attendance", "Attendance"], ["/reports", "Reports"], ["/roster", "Roster"], ["/kiosks", "Kiosks"], ...(role === "admin" ? [["/settings/organization", "Settings"]] : [])] as [string, string][];
  const settings = [["/settings/organization", "Organization"], ["/settings/integrations", "Integrations"], ["/settings/privacy", "Privacy"], ["/settings/data", "Data"], ["/settings/updates", "Updates"]] as const;
  let page: React.ReactNode;
  if (role === "admin" && onboarding) page = <SetupWorkspace key={setupKey} initialBranding={branding} onBrandingChanged={onBrandingChanged} onSignedOut={onSignedOut} embedded onComplete={() => { setOnboarding(false); navigate("/dashboard"); }} />;
  else if (path === "/dashboard") page = <HomePage role={role} navigate={navigate} />;
  else if (path === "/meetings") page = <MeetingsPage />;
  else if (path === "/attendance") page = <AttendanceWorkspace embedded />;
  else if (path === "/reports") page = <ReportsPage />;
  else if (path === "/roster") page = <RosterPage role={role} />;
  else if (path === "/kiosks") page = <KiosksPage role={role} />;
  else if (role === "admin" && path === "/settings/organization") page = <OrganizationSettings initialBranding={branding} onChanged={onBrandingChanged} onOpenSetup={openSetup} />;
  else if (role === "admin" && path === "/settings/integrations") page = <IntegrationSettings />;
  else if (role === "admin" && path === "/settings/privacy") page = <PrivacySettings />;
  else if (role === "admin" && path === "/settings/data") page = <DataSettings onReset={() => { setSetupKey((value) => value + 1); openSetup(); }} />;
  else if (role === "admin" && path === "/settings/updates") page = <UpdatesPage />;
  else page = <section className="empty-page"><h2>Page unavailable</h2><p>This page does not exist or your role cannot open it.</p><button type="button" onClick={() => navigate("/dashboard")}>Return home</button></section>;
  return <div className="dashboard-shell">{!onboarding && <header className="dashboard-toolbar"><nav className="primary-navigation" aria-label="Primary dashboard navigation">{primary.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate}>{label}</RouteLink>)}</nav><div className="toolbar-end">{role === "admin" && <UpdateIndicator openUpdates={() => navigate("/settings/updates")} />}<button className="sign-out-button" type="button" onClick={onSignedOut}>Sign out</button></div></header>}{role === "admin" && !onboarding && path.startsWith("/settings/") && <nav className="settings-navigation" aria-label="Settings categories">{settings.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate}>{label}</RouteLink>)}</nav>}<main id="dashboard-content" className={`dashboard-page${onboarding ? " onboarding-page" : ""}`} tabIndex={-1}>{onboarding === undefined ? <p className="auth-check" role="status">Loading setup progress…</p> : page}</main></div>;
}
