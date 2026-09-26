import { useEffect, useRef, useState } from "react";
import type { Branding } from "./setup-workspace";
import { SetupWorkspace } from "./setup-workspace";
import { AttendanceWorkspace } from "./attendance-workspace";
import { dashboardMeetingViewKey, HomePage } from "./home-page";
import { ReportsPage } from "./reports-page";
import { RosterPage } from "./roster-page";
import { MemberDetailPage } from "./member-detail-page";
import { OrganizationSettings } from "./organization-settings";
import { ConfigurationSettings } from "./configuration-settings";
import { AttendanceSettings } from "./attendance-settings";
import { IntegrationSettings } from "./integration-settings";
import { DataSettings } from "./data-settings";
import { UpdatesPage } from "./updates-page";
import { UserSettings } from "./user-settings";
import { SimulatorPage } from "./simulator-page";
import { KiosksPage } from "./kiosks-page";
import { api } from "./dashboard-api";
import { RouteLink, usePath } from "./router";
import { UpdateAvailablePopup, UpdateIndicator } from "./update-indicator";
import { AdaptiveBrandLogo } from "./adaptive-brand-logo";
import { ContestIndicator } from "./contest-indicator";
import { PageWalkthroughExperience } from "./page-walkthrough";
import { pageWalkthroughForPath } from "./page-walkthrough-definitions";

const setupStepIds = ["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"];
type IntegrationCapabilities = Record<"google" | "resend" | "discord", { enabled: boolean; configured: boolean }>;
const disabledCapabilities: IntegrationCapabilities = { google: { enabled: false, configured: false }, resend: { enabled: false, configured: false }, discord: { enabled: false, configured: false } };

export function AppShell({ role, branding, onBrandingChanged, onSignedOut, themeControl, debugMode, onDebugModeChanged }: { themeControl: React.ReactNode; role: "admin" | "operator"; branding: Branding; onBrandingChanged: (branding: Branding) => void; onSignedOut: () => void; debugMode: boolean; onDebugModeChanged: (enabled: boolean) => Promise<void> }) {
  const [walkthrough, setWalkthrough] = useState({ open: false, navigation: false });
  const { path, search, navigate } = usePath(); const [setupKey, setSetupKey] = useState(0); const [onboarding, setOnboarding] = useState(role === "admin" ? undefined as boolean | undefined : false); const [mobileNavOpen, setMobileNavOpen] = useState(false); const [integrations, setIntegrations] = useState<IntegrationCapabilities>(disabledCapabilities); const [preferenceError, setPreferenceError] = useState(""); const mobileMenuButton = useRef<HTMLButtonElement>(null); const primaryNavigation = useRef<HTMLElement>(null); const mobileNavScrim = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (role !== "admin") return; void api<{ completedSteps: { step: string }[] }>("/admin/setup/progress").then((result) => setOnboarding(!setupStepIds.every((step) => result.completedSteps.some((item) => item.step === step)))).catch(() => setOnboarding(false)); }, [role, setupKey]);
  useEffect(() => { if (onboarding) window.requestAnimationFrame(() => { window.scrollTo({ top: 0, behavior: "auto" }); document.getElementById("dashboard-content")?.focus(); }); }, [onboarding, setupKey]);
  useEffect(() => { setMobileNavOpen(false); }, [path]);
  useEffect(() => {
    if (!mobileNavOpen || walkthrough.open) return;
    const focusable = () => [mobileNavScrim.current, ...Array.from(primaryNavigation.current?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [])].filter((item): item is HTMLButtonElement | HTMLAnchorElement => Boolean(item));
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMobileNavOpen(false); return; }
      if (event.key !== "Tab") return;
      const items = focusable(); const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    window.requestAnimationFrame(() => primaryNavigation.current?.querySelector<HTMLAnchorElement>("a[href]")?.focus());
    return () => { document.removeEventListener("keydown", keydown); mobileMenuButton.current?.focus(); };
  }, [mobileNavOpen, walkthrough.open]);
  useEffect(() => { if (onboarding) return; void api<{ integrations: IntegrationCapabilities }>("/integrations/capabilities").then((result) => setIntegrations(result.integrations)).catch(() => setIntegrations(disabledCapabilities)); }, [onboarding]);
  function openSetup() { setOnboarding(true); window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" })); }
  const primary = [["/dashboard", "Dashboard"], ["/roster", "Roster"], ["/reports", "Reports"], ["/kiosks", "Kiosks"], [role === "admin" ? "/settings/organization" : "/settings/session", "Settings"]] as [string, string][];
  const settings = [["/settings/organization", "Organization"], ["/settings/configuration", "Configuration"], ["/settings/attendance", "Attendance"], ["/settings/access", "Access"], ["/settings/integrations", "Integrations"], ["/settings/data", "Data"], ["/settings/guided-setup", "Guided Setup"], ["/settings/updates", "Updates"]] as const;
  const viewingSettings = path.startsWith("/settings/");
  const pageWalkthrough = pageWalkthroughForPath(path, role);
  const wideDashboardLayout = onboarding === false && (["/dashboard", "/roster", "/kiosks"].includes(path) || path.startsWith("/reports") || path.startsWith("/meetings/") || path.startsWith("/roster/"));
  let page: React.ReactNode;
  if (role === "admin" && onboarding) page = <SetupWorkspace key={setupKey} initialBranding={branding} onBrandingChanged={onBrandingChanged} onSignedOut={onSignedOut} embedded onComplete={() => { setOnboarding(false); navigate("/dashboard"); }} />;
  else if (path === "/dashboard") page = <HomePage onWalkthroughChange={setWalkthrough} role={role} navigate={navigate} discordEnabled={integrations.discord.configured} debugMode={debugMode} />;
  else if (path === "/meetings") page = <LegacyMeetingsRedirect navigate={navigate} />;
  else if (path.startsWith("/meetings/") && path.slice("/meetings/".length)) page = <AttendanceWorkspace meetingId={decodeURIComponent(path.slice("/meetings/".length))} role={role} />;
  else if (path === "/attendance") page = <LegacyAttendanceRedirect search={search} navigate={navigate} />;
  else if (path === "/reports" || path === "/reports/new" || path.startsWith("/reports/view/")) page = <ReportsPage discordEnabled={integrations.discord.configured} debugMode={debugMode} onWalkthroughChange={setWalkthrough} />;
  else if (path === "/roster") page = <RosterPage role={role} debugMode={debugMode} />;
  else if (path.startsWith("/roster/")) page = <MemberDetailPage role={role} memberId={decodeURIComponent(path.slice("/roster/".length))} discordEnabled={integrations.discord.enabled} debugMode={debugMode} />;
  else if (path === "/kiosks") page = <KiosksPage role={role} discordConfigured={integrations.discord.configured} walkthroughOpen={walkthrough.open} />;
  else if (role === "admin" && path === "/simulator") page = <SimulatorPage branding={branding} />;
  else if (path === "/settings/session") page = <section className="settings-page" aria-labelledby="session-title"><div className="page-intro"><h1 id="session-title">Settings</h1><p>Choose your display theme or sign out of this browser.</p></div></section>;
  else if (role === "admin" && path === "/settings/organization") page = <OrganizationSettings initialBranding={branding} onChanged={onBrandingChanged} />;
  else if (role === "admin" && path === "/settings/configuration") page = <ConfigurationSettings initialBranding={branding} onChanged={onBrandingChanged} />;
  else if (path === "/settings/attendance") page = <AttendanceSettings role={role} />;
  else if (role === "admin" && path === "/settings/access") page = <AccessSettings />;
  else if (role === "admin" && path === "/settings/integrations") page = <IntegrationSettings onEnabledChanged={(provider, enabled, configured) => setIntegrations((current) => ({ ...current, [provider]: { enabled, configured } }))} />;
  else if (role === "admin" && path === "/settings/data") page = <DataSettings />;
  else if (role === "admin" && path === "/settings/guided-setup") page = <GuidedSetupSettings onOpenSetup={openSetup} />;
  else if (role === "admin" && path === "/settings/updates") page = <UpdatesPage />;
  else page = <section className="ui-card empty-page unavailable-page" aria-labelledby="unavailable-page-title"><h1 id="unavailable-page-title">Page unavailable</h1><p>This page does not exist or your role cannot open it.</p><button type="button" onClick={() => navigate("/dashboard")}>Return to Dashboard</button></section>;
  return <div className="dashboard-shell" data-layout={wideDashboardLayout ? "wide" : "readable"}>{!onboarding && <header className="dashboard-toolbar" data-walkthrough="navigation"><a className="brand-home-link dashboard-brand" href="/dashboard" aria-label="Go to Dashboard">{branding.logoData ? <AdaptiveBrandLogo src={branding.logoData} alt="" backdrop={branding.logoBackdrop} className="header-logo" /> : <div className="brand-mark" aria-hidden="true">L</div>}<span className="brand-heading"><strong>{branding.organizationName}</strong>{branding.subtitle && <span>{branding.subtitle}</span>}</span></a>{!mobileNavOpen && <button ref={mobileMenuButton} className="mobile-menu-toggle" type="button" aria-label="Open navigation" aria-controls="primary-dashboard-navigation" aria-expanded={false} onClick={() => setMobileNavOpen(true)}><span /><span /><span /></button>}{mobileNavOpen && <button ref={mobileNavScrim} className="mobile-nav-scrim" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}<nav ref={primaryNavigation} id="primary-dashboard-navigation" className={`ui-control-group primary-navigation${mobileNavOpen || walkthrough.navigation ? " mobile-open" : ""}`} aria-label="Primary dashboard navigation" onClick={(event) => { if ((event.target as Element).closest("a")) setMobileNavOpen(false); }}>{primary.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate} className={label === "Settings" && viewingSettings && path !== href ? "active" : ""}>{label}</RouteLink>)}</nav><div className="toolbar-end"><ContestIndicator enabled={integrations.discord.configured} />{role === "admin" && <UpdateIndicator openUpdates={() => navigate("/settings/updates")} />}</div></header>}{role === "admin" && !onboarding && <UpdateAvailablePopup suppressed={walkthrough.open} openUpdates={() => navigate("/settings/updates")} />}{!onboarding && viewingSettings && <section className="settings-toolbar ui-card"><nav className="ui-control-group settings-navigation" aria-label="Settings categories">{role === "admin" ? settings.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate}>{label}</RouteLink>) : <><RouteLink href="/settings/session" currentPath={path} navigate={navigate}>Session</RouteLink><RouteLink href="/settings/attendance" currentPath={path} navigate={navigate}>Attendance</RouteLink></>}</nav><div className="settings-session-actions" aria-label="Dashboard preferences">{themeControl}<button className="theme-toggle debug-mode-toggle" type="button" role="switch" aria-checked={debugMode} aria-label="Debug mode" onClick={() => { setPreferenceError(""); void onDebugModeChanged(!debugMode).catch(() => setPreferenceError("Could not save Debug mode.")); }}><span className="theme-toggle-label" aria-hidden="true">Debug</span><span className="theme-toggle-track" aria-hidden="true"><span /></span></button><button className="sign-out-button" type="button" onClick={onSignedOut}>Sign out</button>{preferenceError && <span className="ui-status" data-tone="error" role="alert">{preferenceError}</span>}</div></section>}<main id="dashboard-content" className={`dashboard-page${onboarding ? " onboarding-page" : ""}`} tabIndex={-1}>{onboarding === undefined ? <p className="ui-status auth-check" role="status">Loading setup progress…</p> : <>{page}{pageWalkthrough && pageWalkthrough.pageId !== "reports" && <PageWalkthroughExperience key={pageWalkthrough.pageId} definition={pageWalkthrough} debugMode={debugMode} onStateChange={setWalkthrough} />}</>}</main></div>;
}

function AccessSettings() { const [members, setMembers] = useState<import("./user-settings").RosterMember[]>([]); useEffect(() => { void api<{ members: import("./user-settings").RosterMember[] }>("/admin/members").then((result) => setMembers(result.members)); }, []); return <section className="settings-page settings-access" aria-labelledby="access-title"><div className="page-intro"><h1 id="access-title">Dashboard access</h1><p>Manage authenticated staff accounts, roster links, and Admin or Operator roles.</p></div><UserSettings members={members} /></section>; }
function LegacyAttendanceRedirect({ search, navigate }: { search: string; navigate: (path: string, replace?: boolean) => void }) { const meetingId = new URLSearchParams(search).get("meetingId"); useEffect(() => { navigate(meetingId ? `/meetings/${encodeURIComponent(meetingId)}` : "/dashboard", true); }, [meetingId, navigate]); return <p className="auth-check" role="status">Opening the meeting workspace…</p>; }
function LegacyMeetingsRedirect({ navigate }: { navigate: (path: string, replace?: boolean) => void }) { useEffect(() => { window.localStorage.setItem(dashboardMeetingViewKey, "table"); navigate("/dashboard", true); }, [navigate]); return <p className="auth-check" role="status">Opening the Dashboard meeting table…</p>; }
function GuidedSetupSettings({ onOpenSetup }: { onOpenSetup: () => void }) { return <section className="settings-page settings-guided-setup" aria-labelledby="guided-setup-title"><div className="page-intro"><h1 id="guided-setup-title">Guided Setup</h1><p>Revisit the installation checklist without resetting completed work.</p></div><article className="settings-callout"><div><h2>Reopen setup</h2><p>Return to the guided onboarding workflow without resetting completed steps or deleting installation data.</p></div><button className="primary-button" type="button" onClick={onOpenSetup}>Open guided setup</button></article></section>; }
