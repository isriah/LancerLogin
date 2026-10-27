import { useEffect, useMemo, useRef, useState } from "react";
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
import { FingerprintSharingPage } from "./fingerprint-sharing-page";
import { KiosksPage } from "./kiosks-page";
import { api } from "./dashboard-api";
import { RouteLink, usePath } from "./router";
import { AttendanceSettingsSections } from "./settings-section-navigation";
import "./mobile-settings.css";
import { SettingsModuleNavigation } from "./settings-module-navigation";
import { UpdateAvailablePopup, UpdateIndicator } from "./update-indicator";
import { AdaptiveBrandLogo } from "./adaptive-brand-logo";
import { ContestIndicator } from "./contest-indicator";
import { PageWalkthroughExperience } from "./page-walkthrough";
import { pageWalkthroughForPath } from "./page-walkthrough-definitions";
import { useModuleNavigation, type ModuleNavigationResult } from "./module-navigation";
import { ModuleSettings } from "./module-controls";
import { CoreHomePage } from "./core-home-page";
import { CoreMemberPage } from "./core-member-page";
import { ModuleSetupWorkspace } from "./module-setup-workspace";
import { SchedulerControls } from "./scheduler-controls";
import { installedDashboardModules } from "./installed-dashboard-modules";
import { contributedModules, dashboardModuleWideLayout, decodeDashboardPathParams, resolveDashboardModulePage } from "./module-contributions.ts";
import { DashboardModuleRuntime, ModuleRoot } from "./module-slots";
import { FingerprintResetPanel } from "./fingerprint-reset-panel";

type IntegrationCapabilities = Record<"google" | "resend" | "discord", { enabled: boolean; configured: boolean }>;
type AdminPreferences = { developerSchedulerEnabled: boolean; revision: number };
const deferredSetupKey = "lancerlogin-module-setup-deferred";
function setupDeferralId(module: { id: string; generation: number }) { return `${module.id}:${module.generation}`; }
function readDeferredSetups() { try { const value = JSON.parse(localStorage.getItem(deferredSetupKey) ?? "[]") as unknown; return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []); } catch { return new Set<string>(); } }
function saveDeferredSetups(value: Set<string>) { try { localStorage.setItem(deferredSetupKey, JSON.stringify([...value])); } catch { /* Browser storage can be unavailable; the choice lasts for this visit. */ } }
const disabledCapabilities: IntegrationCapabilities = { google: { enabled: false, configured: false }, resend: { enabled: false, configured: false }, discord: { enabled: false, configured: false } };

export function AppShell({ initialModules, role, branding, onBrandingChanged, onSignedOut, themeControl, debugMode, onDebugModeChanged }: { initialModules?: Promise<ModuleNavigationResult>; themeControl: React.ReactNode; role: "admin" | "operator"; branding: Branding; onBrandingChanged: (branding: Branding) => void; onSignedOut: () => void; debugMode: boolean; onDebugModeChanged: (enabled: boolean) => Promise<void> }) {
  const moduleAccess = useModuleNavigation(initialModules);
  const [settingsNavigationOpen, setSettingsNavigationOpen] = useState(false);
  const settingsNavigationButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { setSettingsNavigationOpen(false); }, [window.location.pathname]);
  useEffect(() => { if (!settingsNavigationOpen) return; const close = (event: KeyboardEvent) => { if (event.key === "Escape" && settingsNavigationButton.current?.closest(".settings-toolbar")?.contains(event.target as Node) && !document.querySelector('.settings-module-toggle[aria-expanded="true"]')) { setSettingsNavigationOpen(false); settingsNavigationButton.current?.focus(); } }; document.addEventListener("keydown", close); return () => document.removeEventListener("keydown", close); }, [settingsNavigationOpen]);
  const [walkthrough, setWalkthrough] = useState({ open: false, navigation: false });
  const { path, search, navigate } = usePath(); const [moduleSetupOpen, setModuleSetupOpen] = useState<string | null>(null); const [mobileNavOpen, setMobileNavOpen] = useState(false); const [integrations, setIntegrations] = useState<IntegrationCapabilities>(disabledCapabilities); const [preferences, setPreferences] = useState<AdminPreferences | null>(); const [preferenceError, setPreferenceError] = useState(""); const mobileMenuButton = useRef<HTMLButtonElement>(null); const primaryNavigation = useRef<HTMLElement>(null); const mobileNavScrim = useRef<HTMLButtonElement>(null);
  const attendance = moduleAccess.module("attendance");
  const attendanceReady = Boolean(attendance?.workspaceReady);
  const moduleReady = (moduleId: string) => Boolean(moduleAccess.module(moduleId)?.workspaceReady);
  const readyModules = contributedModules(installedDashboardModules, moduleReady);
  const enabledModules = moduleAccess.snapshot?.modules.filter((item) => item.enabled).map((item) => item.id).join(",");
  const moduleRuntime = useMemo(() => ({ modules: installedDashboardModules, ready: (moduleId: string) => Boolean(moduleAccess.snapshot?.modules.find((item) => item.id === moduleId)?.workspaceReady) }), [moduleAccess.snapshot]);
  const selectionRequired = role === "admin" && Boolean(moduleAccess.snapshot && !moduleAccess.snapshot.selectionCompleted);
  const [deferredSetups, setDeferredSetups] = useState(readDeferredSetups);
  const unfinishedSetups = role === "admin" ? moduleAccess.snapshot?.modules.filter((item) => item.enabled && !item.setup.ready && !item.unavailable) ?? [] : [];
  const requiredSetup = unfinishedSetups.find((item) => !deferredSetups.has(setupDeferralId(item)));
  const deferredUnfinishedSetups = unfinishedSetups.filter((item) => deferredSetups.has(setupDeferralId(item)));
  const reopenedSetup = moduleSetupOpen ? moduleAccess.module(moduleSetupOpen) : undefined;
  const setupModule = requiredSetup ?? (role === "admin" && reopenedSetup?.enabled ? reopenedSetup : undefined);
  const moduleSetupVisible = Boolean(setupModule);
  useEffect(() => { if (moduleSetupOpen && !moduleAccess.module(moduleSetupOpen)?.enabled) setModuleSetupOpen(null); }, [moduleSetupOpen, enabledModules]);
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
  const primary = [["/dashboard", attendanceReady ? "Meetings" : "Dashboard"], ...readyModules.flatMap(({ manifest }) => manifest.navigation.map((item) => [item.path, item.label])), ["/roster", "Roster"], ["/reports", "Reports"], ...(attendanceReady ? [["/kiosks", "Kiosks"]] : []), [role === "admin" ? "/settings/organization" : "/settings/session", "Settings"]] as [string, string][];
  const settingsBeforeModules = [["/settings/organization", "Organization"]] as [string, string][];
  const settingsAfterModules = [["/settings/access", "Access"], ["/settings/integrations", "Integrations"], ...(preferences?.developerSchedulerEnabled ? [["/settings/background-scheduler", "Background scheduler"]] : []), ["/settings/data", "Data"], ["/settings/updates", "Updates"]] as [string, string][];
  const moduleSettings = readyModules.flatMap(({ manifest, contribution }) => manifest.settings.map((item) => ({ id: item.path, label: item.label, href: item.path, operator: Boolean(contribution.settingsPages?.find((page) => page.path === item.path)?.operator) })));
  const moduleSettingsLabel = contributedModules(installedDashboardModules).flatMap(({ manifest }) => manifest.settings).find((item) => path === item.path || path.startsWith(`${item.path}/`))?.label;
  const viewingSettings = path.startsWith("/settings/");
  const pageWalkthrough = attendanceReady || !["/dashboard", "/reports"].includes(path) ? pageWalkthroughForPath(path, role, readyModules.flatMap(({ contribution }) => contribution.walkthroughs ?? [])) : undefined;
  const wideDashboardLayout = !moduleSetupVisible && (["/dashboard", "/roster", "/kiosks"].includes(path) || path.startsWith("/reports") || path.startsWith("/meetings/") || path.startsWith("/roster/") || dashboardModuleWideLayout(installedDashboardModules, path));
  const modulePage = resolveDashboardModulePage(installedDashboardModules, path, role, moduleReady);
  let page: React.ReactNode;
  if (moduleAccess.loading) page = <p className="ui-status auth-check" role="status">Loading module access...</p>;
  else if (moduleAccess.error || !moduleAccess.snapshot) page = <section className="ui-card unavailable-page"><h1>Module access unavailable</h1><p>The application could not verify current module state. Reload this page before continuing.</p></section>;
  else if (selectionRequired) page = <ModuleSettings selection snapshot={moduleAccess.snapshot} onChanged={moduleAccess.reload} />;
  else if (moduleSetupVisible && setupModule) page = <ModuleSetupWorkspace key={`${setupModule.id}:${setupModule.generation}`} setup={installedDashboardModules.get(setupModule.id)?.setup} moduleRoot={!installedDashboardModules.get(setupModule.id)?.coreShell} module={setupModule} navigate={navigate} onReady={async () => { setModuleSetupOpen(null); await moduleAccess.reload(); }} onFinishLater={setupModule.setup.ready ? undefined : () => { const next = new Set(deferredSetups).add(setupDeferralId(setupModule)); saveDeferredSetups(next); setDeferredSetups(next); setModuleSetupOpen(null); navigate("/dashboard"); }} />;
  else if (path === "/dashboard") page = attendanceReady ? <HomePage onWalkthroughChange={setWalkthrough} role={role} navigate={navigate} discordEnabled={integrations.discord.configured} debugMode={debugMode} /> : <CoreHomePage moduleCount={moduleAccess.snapshot.modules.filter((module) => module.enabled).length} />;
  else if (path === "/meetings") page = <LegacyMeetingsRedirect navigate={navigate} />;
  else if (path.startsWith("/meetings/") && path.slice("/meetings/".length)) page = <AttendanceWorkspace meetingId={decodeURIComponent(path.slice("/meetings/".length))} role={role} />;
  else if (path === "/attendance") page = <LegacyAttendanceRedirect search={search} navigate={navigate} />;
  else if (path === "/reports" || path === "/reports/new" || path.startsWith("/reports/view/")) page = <ReportsPage discordEnabled={attendanceReady && integrations.discord.configured} debugMode={debugMode} onWalkthroughChange={setWalkthrough} />;
  else if (path === "/roster") page = <RosterPage role={role} attendanceEnabled={attendanceReady} />;
  else if (path.startsWith("/roster/")) page = attendanceReady ? <MemberDetailPage role={role} memberId={decodeURIComponent(path.slice("/roster/".length))} discordEnabled={integrations.discord.enabled} debugMode={debugMode} /> : <CoreMemberPage memberId={decodeURIComponent(path.slice("/roster/".length))} />;
  else if (attendanceReady && /^\/kiosks\/[^/]+\/manage$/.test(path)) page = <KiosksPage role={role} discordConfigured={integrations.discord.configured} walkthroughOpen={walkthrough.open} kioskId={decodeURIComponent(path.split("/")[2]!)} />;
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
  else if (attendanceReady && role === "admin" && path === "/settings/fingerprint-sharing") page = <FingerprintSharingPage />;
  else if (attendanceReady && role === "admin" && path === "/settings/fingerprint-recovery") page = <section className="settings-page" aria-labelledby="fingerprint-recovery-title"><div className="page-intro"><h1 id="fingerprint-recovery-title">Fingerprint recovery</h1><p>Last-resort recovery for fingerprint enrollments. Use routine sharing controls in Fingerprint sharing.</p></div><AttendanceSettingsSections /><FingerprintResetPanel onSharingChanged={() => undefined} /></section>;
  else if (role === "admin" && path === "/settings/updates") page = <UpdatesPage />;
  else if (modulePage) page = <ModuleRoot moduleId={modulePage.moduleId}>{modulePage.render({ role, navigate, params: decodeDashboardPathParams(modulePage.params), openSetup: () => openSetup(modulePage.moduleId) })}</ModuleRoot>;
  else page = <section className="ui-card empty-page unavailable-page" aria-labelledby="unavailable-page-title"><h1 id="unavailable-page-title">Page unavailable</h1><p>This page does not exist or your role cannot open it.</p><button type="button" onClick={() => navigate("/dashboard")}>Return to Dashboard</button></section>;
  return <DashboardModuleRuntime value={moduleRuntime}><div className="dashboard-shell" data-layout={wideDashboardLayout ? "wide" : "readable"}>{!moduleSetupVisible && !selectionRequired && <header className="dashboard-toolbar" data-walkthrough="navigation"><a className="brand-home-link dashboard-brand" href="/dashboard" aria-label="Go to Dashboard">{branding.logoData ? <AdaptiveBrandLogo src={branding.logoData} alt="" backdrop={branding.logoBackdrop} className="header-logo" /> : <div className="brand-mark" aria-hidden="true">L</div>}<span className="brand-heading"><strong>{branding.organizationName}</strong>{branding.subtitle && <span>{branding.subtitle}</span>}</span></a>{!mobileNavOpen && <button ref={mobileMenuButton} className="mobile-menu-toggle" type="button" aria-label="Open navigation" aria-controls="primary-dashboard-navigation" aria-expanded={false} onClick={() => setMobileNavOpen(true)}><span /><span /><span /></button>}{mobileNavOpen && <button ref={mobileNavScrim} className="mobile-nav-scrim" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}<nav ref={primaryNavigation} id="primary-dashboard-navigation" className={`ui-control-group primary-navigation${mobileNavOpen || walkthrough.navigation ? " mobile-open" : ""}`} aria-label="Primary dashboard navigation" onClick={(event) => { if ((event.target as Element).closest("a")) setMobileNavOpen(false); }}>{primary.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate} className={(label === "Settings" && viewingSettings && path !== href || href === "/kiosks" && path.startsWith("/kiosks/")) ? "active" : ""}>{label}</RouteLink>)}</nav><div className="toolbar-end"><ContestIndicator enabled={attendanceReady && integrations.discord.configured} />{role === "admin" && <UpdateIndicator openUpdates={() => navigate("/settings/updates")} />}</div></header>}{role === "admin" && !moduleSetupVisible && !selectionRequired && <UpdateAvailablePopup suppressed={walkthrough.open || path === "/settings/updates"} openUpdates={() => navigate("/settings/updates")} />}{!moduleSetupVisible && !selectionRequired && viewingSettings && <section className="settings-toolbar ui-card" data-open={settingsNavigationOpen}><button ref={settingsNavigationButton} type="button" className="settings-navigation-toggle" aria-expanded={settingsNavigationOpen} aria-controls="settings-navigation-content" onClick={() => setSettingsNavigationOpen(value => !value)}>Settings · {moduleSettingsLabel ?? (["/settings/attendance", "/settings/configuration", "/settings/fingerprint-sharing", "/settings/fingerprint-recovery", "/settings/guided-setup"].includes(path) ? "Attendance" : [...settingsBeforeModules, ["/settings/modules", "Modules"], ...settingsAfterModules].find(([href]) => href === path)?.[1] ?? "Session")}<span aria-hidden="true">{settingsNavigationOpen ? "▴" : "▾"}</span></button><div id="settings-navigation-content" className="settings-navigation-content"><nav className="ui-control-group settings-navigation" aria-label="Settings categories">{role === "admin" ? <>{settingsBeforeModules.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate}>{label}</RouteLink>)}<SettingsModuleNavigation currentPath={path} navigate={navigate} attendanceReady={attendanceReady} modules={moduleSettings} />{settingsAfterModules.map(([href, label]) => <RouteLink key={href} href={href} currentPath={path} navigate={navigate}>{label}</RouteLink>)}</> : <><RouteLink href="/settings/session" currentPath={path} navigate={navigate}>Session</RouteLink>{moduleSettings.filter((item) => item.operator).map((item) => <RouteLink key={item.href} href={item.href} currentPath={path} navigate={navigate}>{item.label}</RouteLink>)}{attendanceReady && <RouteLink href="/settings/attendance" currentPath={path} navigate={navigate}>Attendance</RouteLink>}</>}</nav><div className="settings-session-actions" aria-label="Dashboard preferences">{themeControl}<button className="theme-toggle debug-mode-toggle" type="button" role="switch" aria-checked={debugMode} aria-label="Debug mode" onClick={() => { setPreferenceError(""); void onDebugModeChanged(!debugMode).catch(() => setPreferenceError("Could not save Debug mode.")); }}><span className="theme-toggle-label" aria-hidden="true">Debug</span><span className="theme-toggle-track" aria-hidden="true"><span /></span></button><button className="sign-out-button" type="button" onClick={onSignedOut}>Sign out</button>{preferenceError && <span className="ui-status" data-tone="error" role="alert">{preferenceError}</span>}</div></div></section>}{!moduleSetupVisible && !selectionRequired && deferredUnfinishedSetups.map((item) => <section key={item.id} className="settings-callout module-setup-deferred" aria-labelledby={`module-setup-deferred-${item.id}`}><div><h2 id={`module-setup-deferred-${item.id}`}>{item.label} setup is not finished</h2><p>{item.label} stays unavailable until its required setup steps are complete.</p></div><button className="primary-button" type="button" onClick={() => openSetup(item.id)}>Continue {item.label} setup</button></section>)}<div id="page-help-tools" /><main id="dashboard-content" className={`dashboard-page${moduleSetupVisible ? " onboarding-page" : ""}`} tabIndex={-1}>{page}{pageWalkthrough && pageWalkthrough.pageId !== "reports" && !selectionRequired && !moduleSetupVisible && <PageWalkthroughExperience key={pageWalkthrough.pageId} definition={pageWalkthrough} debugMode={debugMode} onStateChange={setWalkthrough} />}</main></div></DashboardModuleRuntime>;
}

function AccessSettings({ preferences, onPreferenceChanged }: { preferences: AdminPreferences | null | undefined; onPreferenceChanged: (enabled: boolean) => Promise<AdminPreferences> }) { const [members, setMembers] = useState<import("./user-settings").RosterMember[]>([]), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""); useEffect(() => { void api<{ members: import("./user-settings").RosterMember[] }>("/admin/members").then((result) => setMembers(result.members)); }, []); async function change(enabled: boolean) { setBusy(true); setNotice(""); try { await onPreferenceChanged(enabled); setNotice(enabled ? "Background scheduler settings are now visible." : "Background scheduler settings are hidden."); } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); } } return <section className="settings-page settings-access" aria-labelledby="access-title"><div className="page-intro"><h1 id="access-title">Dashboard access</h1><p>Manage authenticated staff accounts, roster links, and Admin or Operator roles.</p></div><UserSettings members={members} /><section className="ui-card developer-options" aria-labelledby="developer-options-title"><h2 id="developer-options-title">Developer options</h2><p>Show diagnostic and development controls for this Admin account on every device where it signs in.</p>{preferences === null ? <p className="ui-status" data-tone="error" role="alert">Developer options could not be loaded. Reload the page to try again.</p> : <label className="settings-checkbox"><input type="checkbox" role="switch" checked={preferences?.developerSchedulerEnabled ?? false} disabled={busy || preferences === undefined} onChange={(event) => void change(event.target.checked)} /> Show Background scheduler in Settings</label>}{notice && <p className="ui-status" role="status">{notice}</p>}</section></section>; }
function BackgroundSchedulerSettings() { return <section className="settings-page" aria-labelledby="background-scheduler-title"><div className="page-intro"><h1 id="background-scheduler-title">Background scheduler</h1><p>Inspect and control background job processing for development and diagnosis.</p></div><SchedulerControls /></section>; }
function LegacyAttendanceRedirect({ search, navigate }: { search: string; navigate: (path: string, replace?: boolean) => void }) { const meetingId = new URLSearchParams(search).get("meetingId"); useEffect(() => { navigate(meetingId ? `/meetings/${encodeURIComponent(meetingId)}` : "/dashboard", true); }, [meetingId, navigate]); return <p className="auth-check" role="status">Opening the meeting workspace…</p>; }
function LegacyMeetingsRedirect({ navigate }: { navigate: (path: string, replace?: boolean) => void }) { useEffect(() => { window.localStorage.setItem(dashboardMeetingViewKey, "table"); navigate("/dashboard", true); }, [navigate]); return <p className="auth-check" role="status">Opening the Dashboard meeting table…</p>; }
function GuidedSetupSettings({ onOpenSetup }: { onOpenSetup: () => void }) { return <section className="settings-page settings-guided-setup" aria-labelledby="guided-setup-title"><div className="page-intro"><h1 id="guided-setup-title">Attendance Setup</h1><p>Revisit Attendance rules, the first meeting, browser input, and optional integration checks without resetting completed work.</p></div><AttendanceSettingsSections /><article className="settings-callout"><div><h2>Reopen Attendance setup</h2><p>Review one setup card at a time. Existing meetings and attendance records remain unchanged.</p></div><button className="primary-button" type="button" onClick={onOpenSetup}>Open Attendance setup</button></article></section>; }
