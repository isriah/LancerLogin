import { useEffect, useRef, useState } from "react";
import type { Branding } from "./setup-workspace";
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
import { SettingsModuleNavigation } from "./settings-module-navigation";
import { UpdateAvailablePopup, UpdateIndicator } from "./update-indicator";
import { AdaptiveBrandLogo } from "./adaptive-brand-logo";
import { ContestIndicator } from "./contest-indicator";
import { PageWalkthroughExperience } from "./page-walkthrough";
import { pageWalkthroughForPath } from "./page-walkthrough-definitions";
import { useModuleNavigation } from "./module-navigation";
import { ModuleSettings } from "./module-controls";
import { CoreHomePage } from "./core-home-page";
import { CoreMemberPage } from "./core-member-page";
import { ModuleSetupWorkspace } from "./module-setup-workspace";
import { SchedulerControls } from "./scheduler-controls";
import { OutreachWorkspace } from "./outreach-workspace";
import { OutreachSettings } from "./outreach-settings";
import { CarpoolWorkspace } from "./carpool-workspace";
import { CarpoolSettings } from "./carpool-settings";

type IntegrationCapabilities = Record<"google" | "resend" | "discord", { enabled: boolean; configured: boolean }>;
type AdminPreferences = { developerSchedulerEnabled: boolean; revision: number };
const disabledCapabilities: IntegrationCapabilities = { google: { enabled: false, configured: false }, resend: { enabled: false, configured: false }, discord: { enabled: false, configured: false } };

export function AppShell({ role, branding, onBrandingChanged, onSignedOut, themeControl, debugMode, onDebugModeChanged }: { themeControl: React.ReactNode; role: "admin" | "operator"; branding: Branding; onBrandingChanged: (branding: Branding) => void; onSignedOut: () => void; debugMode: boolean; onDebugModeChanged: (enabled: boolean) => Promise<void> }) {
  const moduleAccess = useModuleNavigation();
  const [walkthrough, setWalkthrough] = useState({ open: false, navigation: false });
  const { path, search, navigate } = usePath(); const [moduleSetupOpen, setModuleSetupOpen] = useState<string | null>(null); const [mobileNavOpen, setMobileNavOpen] = useState(false); const [integrations, setIntegrations] = useState<IntegrationCapabilities>(disabledCapabilities); const [preferences, setPreferences] = useState<AdminPreferences | null>(); const [preferenceError, setPreferenceError] = useState(""); const mobileMenuButton = useRef<HTMLButtonElement>(null); const primaryNavigation = useRef<HTMLElement>(null); const mobileNavScrim = useRef<HTMLButtonElement>(null);
  const attendance = moduleAccess.module("attendance");
  const outreach = moduleAccess.module("hour-tracking");
  const carpool = moduleAccess.module("carpool");
  const attendanceEnabled = Boolean(attendance?.enabled);
  const attendanceReady = Boolean(attendance?.workspaceReady);
  const outreachReady = Boolean(outreach?.workspaceReady);
  const carpoolReady = Boolean(carpool?.workspaceReady);
  const selectionRequired = role === "admin" && Boolean(moduleAccess.snapshot && !moduleAccess.snapshot.selectionCompleted);
  const requiredSetup = role === "admin" ? moduleAccess.snapshot?.modules.find((item) => item.enabled && !item.setup.ready) : undefined;
  const reopenedSetup = moduleSetupOpen ? moduleAccess.module(moduleSetupOpen) : undefined;
  const setupModule = requiredSetup ?? (role === "admin" && reopenedSetup?.enabled ? reopenedSetup : undefined);
  const moduleSetupVisible = Boolean(setupModule);
  useEffect(() => { if (moduleSetupOpen && !moduleAccess.module(moduleSetupOpen)?.enabled) setModuleSetupOpen(null); }, [moduleSetupOpen, attendanceEnabled, outreach?.enabled, carpool?.enabled]);
  useEffect(() => { if (role === "admin") void api<AdminPreferences>("/admin/preferences").then(setPreferences).catch(() => setPreferences(null)); }, [role]);
  useEffect(() => { if (moduleSetupVisible) window.requestAnimationFrame(() => { window.scrollTo({ top: 0, behavior: "auto" }); document.getElementById("dashboard-content")?.focus(); }); }, [moduleSetupVisible]);
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
  useEffect(() => { if (moduleSetupVisible || selectionRequired || moduleAccess.loading) return; void api<{ integrations: IntegrationCapabilities }>("/integrations/capabilities").then((result) => setIntegrations(result.integrations)).catch(() => setIntegrations(disabledCapabilities)); }, [moduleSetupVisible, selectionRequired, moduleAccess.loading]);
  async function saveDeveloperSchedulerPreference(developerSchedulerEnabled: boolean) {
    if (!preferences) throw new Error("Developer options are unavailable. Reload the page and try again.");
    const next = await api<AdminPreferences>("/admin/preferences", { method: "PUT", body: JSON.stringify({ developerSchedulerEnabled, expectedRevision: preferences.revision }) });
    setPreferences(next); return next;
  }
  function openSetup(moduleId: string) { setModuleSetupOpen(moduleId); window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" })); }
  const primary = [["/dashboard", attendanceReady ? "Meetings" : "Dashboard"], ...(outreachReady ? [["/hours", "Outreach"]] : []), ...(carpoolReady ? [["/carpool", "Carpool"]] : []), ["/roster", "Roster"], ["/reports", "Reports"], ...(attendanceReady ? [["/kiosks", "Kiosks"]] : []), [role === "admin" ? "/settings/organization" : "/settings/session", "Settings"]] as [string, string][];
  const settingsBeforeModules = [["/settings/organization", "Organization"]] as [string, string][];
  const settingsAfterModules = [["/settings/access", "Access"], ["/settings/integrations", "Integrations"], ...(preferences?.developerSchedulerEnabled ? [["/settings/background-scheduler", "Background scheduler"]] : []), ["/settings/data", "Data"], ["/settings/updates", "Updates"]] as [string, string][];
  const viewingSettings = path.startsWith("/settings/");
  const pageWalkthrough = path === "/hours" && !outreachReady ? undefined : attendanceReady || !["/dashboard", "/reports"].includes(path) ? pageWalkthroughForPath(path, role) : undefined;
  const wideDashboardLayout = !moduleSetupVisible && (["/dashboard", "/hours", "/carpool", "/roster", "/kiosks"].includes(path) || path.startsWith("/reports") || path.startsWith("/meetings/") || path.startsWith("/hours/activities/") || path.startsWith("/carpool/plans/") || path.startsWith("/roster/"));
  let page: React.ReactNode;
  if (moduleAccess.loading) page = <p className="ui-status auth-check" role="status">Loading module access...</p>;
  else if (moduleAccess.error || !moduleAccess.snapshot) page = <section className="ui-card unavailable-page"><h1>Module access unavailable</h1><p>The application could not verify current module state. Reload this page before continuing.</p></section>;
  else if (selectionRequired) page = <ModuleSettings selection snapshot={moduleAccess.snapshot} onChanged={moduleAccess.reload} />;
  else if (moduleSetupVisible && setupModule) page = <ModuleSetupWorkspace key={`${setupModule.id}:${setupModule.generation}`} module={setupModule} navigate={navigate} onReady={async () => { setModuleSetupOpen(null); await moduleAccess.reload(); }} />;
  else if (path === "/dashboard") page = attendanceReady ? <HomePage onWalkthroughChange={setWalkthrough} role={role} navigate={navigate} discordEnabled={integrations.discord.configured} debugMode={debugMode} /> : <CoreHomePage moduleCount={moduleAccess.snapshot.modules.filter((module) => module.enabled).length} />;
  else if (path === "/meetings") page = <LegacyMeetingsRedirect navigate={navigate} />;
  else if (path.startsWith("/meetings/") && path.slice("/meetings/".length)) page = <AttendanceWorkspace meetingId={decodeURIComponent(path.slice("/meetings/".length))} role={role} />;
  else if (path === "/attendance") page = <LegacyAttendanceRedirect search={search} navigate={navigate} />;
  else if (outreachReady && (path === "/hours" || path.startsWith("/hours/activities/") && path.slice("/hours/activities/".length))) page = <OutreachWorkspace activityId={path.startsWith("/hours/activities/") ? decodeURIComponent(path.slice("/hours/activities/".length)) : undefined} isAdmin={role === "admin"} onOpenActivity={(id) => navigate(`/hours/activities/${encodeURIComponent(id)}`)} />;
  else if (carpoolReady && role === "admin" && path === "/settings/carpool") page = <CarpoolSettings />;
  else if (carpoolReady && (path === "/carpool" || path.startsWith("/carpool/plans/") && path.slice("/carpool/plans/".length))) page = <CarpoolWorkspace planId={path.startsWith("/carpool/plans/") ? decodeURIComponent(path.slice("/carpool/plans/".length)) : undefined} onOpenPlan={(id) => navigate(`/carpool/plans/${encodeURIComponent(id)}`)} onOpenMeeting={(id) => navigate(`/meetings/${encodeURIComponent(id)}`)} />;
  else if (path === "/reports" || path === "/reports/new" || path.startsWith("/reports/view/")) page = <ReportsPage discordEnabled={attendanceReady && integrations.discord.configured} debugMode={debugMode} onWalkthroughChange={setWalkthrough} />;
  else if (path === "/roster") page = <RosterPage role={role} debugMode={debugMode} attendanceEnabled={attendanceReady} />;
  else if (path.startsWith("/roster/")) page = attendanceReady ? <MemberDetailPage role={role} memberId={decodeURIComponent(path.slice("/roster/".length))} discordEnabled={integrations.discord.enabled} debugMode={debugMode} /> : <CoreMemberPage memberId={decodeURIComponent(path.slice("/roster/".length))} />;
  else if (attendanceReady && path === "/kiosks") page = <KiosksPage role={role} discordConfigured={integrations.discord.configured} walkthroughOpen={walkthrough.open} />;
  else if (attendanceReady && role === "admin" && ["/simulator", "/settings/kiosk-simulator"].includes(path)) page = <SimulatorPage branding={branding} />;
  else if (path === "/settings/session") page = <section className="settings-page" aria-labelledby="session-title"><div className="page-intro"><h1 id="session-title">Settings</h1><p>Choose your display theme or sign out of this browser.</p></div></section>;
  else if (role === "admin" && path === "/settings/organization") page = <OrganizationSettings initialBranding={branding} onChanged={onBrandingChanged} />;
  else if (role === "admin" && path === "/settings/modules") page = <ModuleSettings snapshot={moduleAccess.snapshot} onChanged={moduleAccess.reload} />;
  else if (attendanceReady && role === "admin" && path === "/settings/configuration") page = <ConfigurationSettings initialBranding={branding} onChanged={onBrandingChanged} />;
  else if (attendanceReady && path === "/settings/attendance") page = <AttendanceSettings role={role} />;
  else if (role === "admin" && path === "/settings/access") page = <AccessSettings preferences={preferences} onPreferenceChanged={saveDeveloperSchedulerPreference} />;
  else if (role === "admin" && path === "/settings/integrations") page = <IntegrationSettings onEnabledChanged={(provider, enabled, configured) => setIntegrations((current) => ({ ...current, [provider]: { enabled, configured } }))} />;
  else if (role === "admin" && preferences?.developerSchedulerEnabled && path === "/settings/background-scheduler") page = <BackgroundSchedulerSettings />;
  else if (role === "admin" && path === "/settings/data") page = <DataSettings />;
  else if (attendanceReady && role === "admin" && path === "/settings/guided-setup") page = <GuidedSetupSettings onOpenSetup={() => openSetup("attendance")} />;
  else if (outreachReady && role === "admin" && path === "/settings/outreach-setup") page = <OutreachSetupSettings onOpenSetup={() => openSetup("hour-tracking")} />;
  else if (role === "admin" && path === "/settings/updates") page = <UpdatesPage />;
  else page = <section className="ui-card empty-page unavailable-page" aria-labelledby="unavailable-page-title"><h1 id="unavailable-page-title">Page unavailable</h1><p>This page does not exist or your role cannot open it.</p><button type="button" onClick={() => navigate("/dashboard")}>Return to Dashboard</button></section>;
  return <div className="dashboard-shell" data-layout={wideDashboardLayout ? "wide" : "readable"}>{!moduleSetupVisible && !selectionRequired && <header className="dashboard-toolbar" data-walkthrough="navigation"><a className="brand-home-link dashboard-brand" href="/dashboard" aria-label="Go to Dashboard">{branding.logoData ? <AdaptiveBrandLogo src={branding.logoData} alt="" backdrop={branding.logoBackdrop} className="header-logo" /> : <div className="brand-mark" aria-hidden="true">L</div>}<span className="brand-heading"><strong>{branding.organizationName}</strong>{branding.subtitle && <span>{branding.subtitle}</span>}</span></a>{!mobileNavOpen && <button ref={mobileMenuButton} className="mobile-menu-toggle" type="button" aria-label="Open navigation" aria-controls="primary-dashboard-navigation" aria-expanded={false} onClick={() => setMobileNavOpen(true)}><span /><span /><span /></button>}{mobileNavOpen && <button ref={mobileNavScrim} className="mobile-nav-scrim" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}<nav ref={primaryNavigation} id="primary-dashboard-navigation" className={`ui-control-group primary-navigation${mobileNavOpen || walkthrough.navigation ? " mobile-open" : ""}`} aria-label="Primary dashboard navigation" onClick={(event) => { if ((event.target as Element).closest("a")) setMobileNavOpen(false); }}>{primary.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate} className={label === "Settings" && viewingSettings && path !== href ? "active" : ""}>{label}</RouteLink>)}</nav><div className="toolbar-end"><ContestIndicator enabled={attendanceReady && integrations.discord.configured} />{role === "admin" && <UpdateIndicator openUpdates={() => navigate("/settings/updates")} />}</div></header>}{role === "admin" && !moduleSetupVisible && !selectionRequired && <UpdateAvailablePopup suppressed={walkthrough.open || path === "/settings/updates"} openUpdates={() => navigate("/settings/updates")} />}{!moduleSetupVisible && !selectionRequired && viewingSettings && <section className="settings-toolbar ui-card"><nav className="ui-control-group settings-navigation" aria-label="Settings categories">{role === "admin" ? <>{settingsBeforeModules.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate}>{label}</RouteLink>)}<SettingsModuleNavigation currentPath={path} navigate={navigate} attendanceReady={attendanceReady} outreachReady={outreachReady} carpoolReady={carpoolReady} />{settingsAfterModules.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate}>{label}</RouteLink>)}</> : <><RouteLink href="/settings/session" currentPath={path} navigate={navigate}>Session</RouteLink>{attendanceReady && <RouteLink href="/settings/attendance" currentPath={path} navigate={navigate}>Attendance</RouteLink>}</>}</nav><div className="settings-session-actions" aria-label="Dashboard preferences">{themeControl}<button className="theme-toggle debug-mode-toggle" type="button" role="switch" aria-checked={debugMode} aria-label="Debug mode" onClick={() => { setPreferenceError(""); void onDebugModeChanged(!debugMode).catch(() => setPreferenceError("Could not save Debug mode.")); }}><span className="theme-toggle-label" aria-hidden="true">Debug</span><span className="theme-toggle-track" aria-hidden="true"><span /></span></button><button className="sign-out-button" type="button" onClick={onSignedOut}>Sign out</button>{preferenceError && <span className="ui-status" data-tone="error" role="alert">{preferenceError}</span>}</div></section>}<main id="dashboard-content" className={`dashboard-page${moduleSetupVisible ? " onboarding-page" : ""}`} tabIndex={-1}>{page}{pageWalkthrough && pageWalkthrough.pageId !== "reports" && !selectionRequired && !moduleSetupVisible && <PageWalkthroughExperience key={pageWalkthrough.pageId} definition={pageWalkthrough} debugMode={debugMode} onStateChange={setWalkthrough} />}</main></div>;
}

function AccessSettings({ preferences, onPreferenceChanged }: { preferences: AdminPreferences | null | undefined; onPreferenceChanged: (enabled: boolean) => Promise<AdminPreferences> }) { const [members, setMembers] = useState<import("./user-settings").RosterMember[]>([]), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""); useEffect(() => { void api<{ members: import("./user-settings").RosterMember[] }>("/admin/members").then((result) => setMembers(result.members)); }, []); async function change(enabled: boolean) { setBusy(true); setNotice(""); try { await onPreferenceChanged(enabled); setNotice(enabled ? "Background scheduler settings are now visible." : "Background scheduler settings are hidden."); } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); } } return <section className="settings-page settings-access" aria-labelledby="access-title"><div className="page-intro"><h1 id="access-title">Dashboard access</h1><p>Manage authenticated staff accounts, roster links, and Admin or Operator roles.</p></div><UserSettings members={members} /><section className="ui-card developer-options" aria-labelledby="developer-options-title"><h2 id="developer-options-title">Developer options</h2><p>Show diagnostic and development controls for this Admin account on every device where it signs in.</p>{preferences === null ? <p className="ui-status" data-tone="error" role="alert">Developer options could not be loaded. Reload the page to try again.</p> : <label className="settings-checkbox"><input type="checkbox" checked={preferences?.developerSchedulerEnabled ?? false} disabled={busy || preferences === undefined} onChange={(event) => void change(event.target.checked)} /> Show Background scheduler in Settings</label>}{notice && <p className="ui-status" role="status">{notice}</p>}</section></section>; }
function BackgroundSchedulerSettings() { return <section className="settings-page" aria-labelledby="background-scheduler-title"><div className="page-intro"><h1 id="background-scheduler-title">Background scheduler</h1><p>Inspect and control background job processing for development and diagnosis.</p></div><SchedulerControls /></section>; }
function LegacyAttendanceRedirect({ search, navigate }: { search: string; navigate: (path: string, replace?: boolean) => void }) { const meetingId = new URLSearchParams(search).get("meetingId"); useEffect(() => { navigate(meetingId ? `/meetings/${encodeURIComponent(meetingId)}` : "/dashboard", true); }, [meetingId, navigate]); return <p className="auth-check" role="status">Opening the meeting workspace…</p>; }
function LegacyMeetingsRedirect({ navigate }: { navigate: (path: string, replace?: boolean) => void }) { useEffect(() => { window.localStorage.setItem(dashboardMeetingViewKey, "table"); navigate("/dashboard", true); }, [navigate]); return <p className="auth-check" role="status">Opening the Dashboard meeting table…</p>; }
function GuidedSetupSettings({ onOpenSetup }: { onOpenSetup: () => void }) { return <section className="settings-page settings-guided-setup" aria-labelledby="guided-setup-title"><div className="page-intro"><h1 id="guided-setup-title">Attendance Setup</h1><p>Revisit Attendance rules, the first meeting, browser input, and optional integration checks without resetting completed work.</p></div><article className="settings-callout"><div><h2>Reopen Attendance setup</h2><p>Review one setup card at a time. Existing meetings and attendance records remain unchanged.</p></div><button className="primary-button" type="button" onClick={onOpenSetup}>Open Attendance setup</button></article></section>; }
function OutreachSetupSettings({ onOpenSetup }: { onOpenSetup: () => void }) { return <section className="settings-page settings-guided-setup" aria-labelledby="outreach-settings-title"><div className="page-intro"><h1 id="outreach-settings-title">Outreach</h1><p>Configure defaults and manage supported teams and labels.</p></div><OutreachSettings onOpenSetup={onOpenSetup} /></section>; }
