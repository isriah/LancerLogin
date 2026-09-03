import { useEffect, useState } from "react";
import type { Branding } from "./setup-workspace";
import { SetupWorkspace } from "./setup-workspace";
import { AttendanceWorkspace } from "./attendance-workspace";
import { HomePage } from "./home-page";
import { MeetingsPage } from "./meetings-page";
import { ReportsPage } from "./reports-page";
import { RosterPage } from "./roster-page";
import { MemberDetailPage } from "./member-detail-page";
import { OrganizationSettings } from "./organization-settings";
import { ConfigurationSettings } from "./configuration-settings";
import { IntegrationSettings } from "./integration-settings";
import { PrivacySettings } from "./privacy-settings";
import { DataSettings } from "./data-settings";
import { UpdatesPage } from "./updates-page";
import { UserSettings } from "./user-settings";
import { SimulatorPage } from "./simulator-page";
import { KiosksPage } from "./kiosks-page";
import { api } from "./dashboard-api";
import { RouteLink, usePath } from "./router";
import { UpdateAvailablePopup, UpdateIndicator } from "./update-indicator";

const setupStepIds = ["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"];

export function AppShell({ role, branding, onBrandingChanged, onSignedOut }: { role: "admin" | "operator"; branding: Branding; onBrandingChanged: (branding: Branding) => void; onSignedOut: () => void }) {
  const { path, search, navigate } = usePath(); const [setupKey, setSetupKey] = useState(0); const [onboarding, setOnboarding] = useState(role === "admin" ? undefined as boolean | undefined : false); const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => { if (role !== "admin") return; void api<{ completedSteps: { step: string }[] }>("/admin/setup/progress").then((result) => setOnboarding(!setupStepIds.every((step) => result.completedSteps.some((item) => item.step === step)))).catch(() => setOnboarding(false)); }, [role, setupKey]);
  useEffect(() => { if (onboarding) window.requestAnimationFrame(() => { window.scrollTo({ top: 0, behavior: "auto" }); document.getElementById("dashboard-content")?.focus(); }); }, [onboarding, setupKey]);
  useEffect(() => { setMobileNavOpen(false); }, [path]);
  function openSetup() { setOnboarding(true); window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" })); }
  const primary = [["/dashboard", "Home"], ["/meetings", "Meetings"], ["/attendance", "Attendance"], ["/reports", "Reports"], ["/roster", "Roster"], ["/kiosks", "Kiosks"], ...(role === "admin" ? [["/settings/organization", "Settings"]] : [])] as [string, string][];
  const settings = [["/settings/organization", "Organization"], ["/settings/configuration", "Configuration"], ["/settings/access", "Access"], ["/settings/integrations", "Integrations"], ["/settings/privacy", "Privacy"], ["/settings/data", "Data"], ["/settings/guided-setup", "Guided Setup"], ["/settings/updates", "Updates"]] as const;
  let page: React.ReactNode;
  if (role === "admin" && onboarding) page = <SetupWorkspace key={setupKey} initialBranding={branding} onBrandingChanged={onBrandingChanged} onSignedOut={onSignedOut} embedded onComplete={() => { setOnboarding(false); navigate("/dashboard"); }} />;
  else if (path === "/dashboard") page = <HomePage role={role} navigate={navigate} />;
  else if (path === "/meetings") page = <MeetingsPage />;
  else if (path === "/attendance") page = <AttendanceWorkspace embedded selectedMeetingId={new URLSearchParams(search).get("meetingId") ?? undefined} />;
  else if (path === "/reports") page = <ReportsPage />;
  else if (path === "/roster") page = <RosterPage role={role} />;
  else if (path.startsWith("/roster/")) page = <MemberDetailPage role={role} memberId={decodeURIComponent(path.slice("/roster/".length))} />;
  else if (path === "/kiosks") page = <KiosksPage role={role} />;
  else if (role === "admin" && path === "/simulator") page = <SimulatorPage />;
  else if (role === "admin" && path === "/settings/organization") page = <OrganizationSettings initialBranding={branding} onChanged={onBrandingChanged} />;
  else if (role === "admin" && path === "/settings/configuration") page = <ConfigurationSettings initialBranding={branding} onChanged={onBrandingChanged} />;
  else if (role === "admin" && path === "/settings/access") page = <AccessSettings />;
  else if (role === "admin" && path === "/settings/integrations") page = <IntegrationSettings />;
  else if (role === "admin" && path === "/settings/privacy") page = <PrivacySettings />;
  else if (role === "admin" && path === "/settings/data") page = <DataSettings />;
  else if (role === "admin" && path === "/settings/guided-setup") page = <GuidedSetupSettings onOpenSetup={openSetup} />;
  else if (role === "admin" && path === "/settings/updates") page = <UpdatesPage />;
  else page = <section className="empty-page"><h2>Page unavailable</h2><p>This page does not exist or your role cannot open it.</p><button type="button" onClick={() => navigate("/dashboard")}>Return home</button></section>;
  return <div className="dashboard-shell">{!onboarding && <header className="dashboard-toolbar">{!mobileNavOpen && <button className="mobile-menu-toggle" type="button" aria-label="Open navigation" aria-controls="primary-dashboard-navigation" aria-expanded={false} onClick={() => setMobileNavOpen(true)}><span /><span /><span /></button>}{mobileNavOpen && <button className="mobile-nav-scrim" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}<nav id="primary-dashboard-navigation" className={`primary-navigation${mobileNavOpen ? " mobile-open" : ""}`} aria-label="Primary dashboard navigation" onClick={(event) => { if ((event.target as Element).closest("a")) setMobileNavOpen(false); }}>{primary.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate}>{label}</RouteLink>)}</nav><div className="toolbar-end">{role === "admin" && <UpdateIndicator openUpdates={() => navigate("/settings/updates")} />}<button className="sign-out-button" type="button" onClick={onSignedOut}>Sign out</button></div></header>}{role === "admin" && !onboarding && <UpdateAvailablePopup openUpdates={() => navigate("/settings/updates")} />}{role === "admin" && !onboarding && path.startsWith("/settings/") && <nav className="settings-navigation" aria-label="Settings categories">{settings.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate}>{label}</RouteLink>)}</nav>}<main id="dashboard-content" className={`dashboard-page${onboarding ? " onboarding-page" : ""}`} tabIndex={-1}>{onboarding === undefined ? <p className="auth-check" role="status">Loading setup progress…</p> : page}</main></div>;
}

function AccessSettings() { const [members, setMembers] = useState<import("./user-settings").RosterMember[]>([]); useEffect(() => { void api<{ members: import("./user-settings").RosterMember[] }>("/admin/members").then((result) => setMembers(result.members)); }, []); return <section className="settings-page" aria-labelledby="access-title"><div className="page-intro"><h1 id="access-title">Dashboard access</h1></div><UserSettings members={members} /></section>; }
function GuidedSetupSettings({ onOpenSetup }: { onOpenSetup: () => void }) { return <section className="settings-page" aria-labelledby="guided-setup-title"><div className="page-intro"><h1 id="guided-setup-title">Guided Setup</h1></div><article className="settings-callout"><h2>Reopen setup</h2><p>Return to the guided onboarding workflow without resetting completed steps or deleting installation data.</p><button className="primary-button" type="button" onClick={onOpenSetup}>Open guided setup</button></article></section>; }
