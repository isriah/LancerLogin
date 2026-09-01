import { useState } from "react";
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
import { RouteLink, usePath } from "./router";

export function AppShell({ role, branding, onBrandingChanged, onSignedOut }: { role: "admin" | "operator"; branding: Branding; onBrandingChanged: (branding: Branding) => void; onSignedOut: () => void }) {
  const { path, navigate } = usePath(); const [setupKey, setSetupKey] = useState(0);
  const primary = [["/dashboard", "Home"], ["/meetings", "Meetings"], ["/attendance", "Attendance"], ["/reports", "Reports"], ["/roster", "Roster"], ...(role === "admin" ? [["/setup", "Setup"], ["/settings/organization", "Settings"]] : [])] as [string, string][];
  const settings = [["/settings/organization", "Organization"], ["/settings/integrations", "Integrations"], ["/settings/privacy", "Privacy"], ["/settings/data", "Data"], ["/settings/updates", "Updates"]] as const;
  let page: React.ReactNode;
  if (path === "/dashboard") page = <HomePage role={role} navigate={navigate} />;
  else if (path === "/meetings") page = <MeetingsPage />;
  else if (path === "/attendance") page = <AttendanceWorkspace embedded />;
  else if (path === "/reports") page = <ReportsPage />;
  else if (path === "/roster") page = <RosterPage role={role} />;
  else if (role === "admin" && path === "/setup") page = <SetupWorkspace key={setupKey} initialBranding={branding} onBrandingChanged={onBrandingChanged} onSignedOut={onSignedOut} embedded onComplete={() => navigate("/dashboard")} />;
  else if (role === "admin" && path === "/settings/organization") page = <OrganizationSettings initialBranding={branding} onChanged={onBrandingChanged} />;
  else if (role === "admin" && path === "/settings/integrations") page = <IntegrationSettings />;
  else if (role === "admin" && path === "/settings/privacy") page = <PrivacySettings />;
  else if (role === "admin" && path === "/settings/data") page = <DataSettings onReset={() => { setSetupKey((value) => value + 1); navigate("/setup"); }} />;
  else if (role === "admin" && path === "/settings/updates") page = <UpdatesPage />;
  else page = <section className="empty-page"><h2>Page unavailable</h2><p>This page does not exist or your role cannot open it.</p><button type="button" onClick={() => navigate("/dashboard")}>Return home</button></section>;
  return <div className="dashboard-shell"><header className="dashboard-toolbar"><nav className="primary-navigation" aria-label="Primary dashboard navigation">{primary.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate}>{label}</RouteLink>)}</nav><button className="sign-out-button" type="button" onClick={onSignedOut}>Sign out</button></header>{role === "admin" && path.startsWith("/settings/") && <nav className="settings-navigation" aria-label="Settings categories">{settings.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate}>{label}</RouteLink>)}</nav>}<main id="dashboard-content" className="dashboard-page" tabIndex={-1}>{page}</main></div>;
}
