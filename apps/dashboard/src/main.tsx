import { FormEvent, StrictMode, useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/bebas-neue/latin-400.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-700.css";
import "./styles.css";
import type { Branding } from "./branding";
import { AppShell } from "./app-shell";
import { AdaptiveBrandLogo } from "./adaptive-brand-logo";
import { brandTheme } from "./theme";
import { loadDashboardSession, startDashboardEntry, type DashboardSession } from "./dashboard-startup";
import type { ModuleNavigationResult } from "./module-navigation";
import { installedDashboardModules } from "./installed-dashboard-modules";
import { resolveDashboardPublicPage } from "./module-contributions.ts";
import { ModuleRoot } from "./module-slots";
import { normalizePath, usePath } from "./router";
import { WalkthroughSessionProvider } from "./page-walkthrough";
import { AppErrorFallback, ErrorBoundary } from "./error-boundary";
import { clearWalkthroughSession } from "./walkthrough-session";
import { product, type ThemeColors } from "../../../packages/shared/src/product.ts";
// Loaded last so desktop consistency rules follow every page and mobile stylesheet.
import "./desktop-layout.css";

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const googleOAuthGuideUrl = "https://isriah.github.io/LancerLogin/setup.html#google-oauth";
const setupGuideUrl = "https://isriah.github.io/LancerLogin/setup.html";
const recoverAccessUrl = "https://isriah.github.io/LancerLogin/operations.html";

// justCreated is client-only: this browser just ran first-Admin setup, so the sign-in form asks the new Admin to finish setup.
type SetupStatus = { configured: boolean; installation?: { authMode: "google" | "local" | "both" }; settings?: Branding; justCreated?: boolean; defaultTheme?: ThemeColors };
/** The Worker's starting organization colors, or the release colors when the Worker did not report them. */
const startingTheme = (status: SetupStatus): ThemeColors => status.defaultTheme ?? product.defaultTheme;
const themeStorageKey = "lancerlogin-theme";
function savedTheme(): "light" | "dark" { try { return localStorage.getItem(themeStorageKey) === "light" ? "light" : "dark"; } catch { return "dark"; } }

function ThemeToggle({ theme, onTheme }: { theme: "light" | "dark"; onTheme: (theme: "light" | "dark") => void }) {
  const dark = theme === "dark";
  return <button className="theme-toggle" type="button" role="switch" aria-checked={!dark} aria-label="Light mode" onClick={() => onTheme(dark ? "light" : "dark")}>
    <span className="theme-toggle-label" aria-hidden="true">Light mode</span>
    <span className="theme-toggle-track" aria-hidden="true"><span /></span>
  </button>;
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="copy-value"><span>{label}</span><code>{value}</code><button type="button" onClick={() => void navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); })}>{copied ? "Copied" : "Copy"}</button></div>;
}

function App() {
  const [theme, setTheme] = useState<"light" | "dark">(savedTheme);
  const [remoteStatus, setRemoteStatus] = useState<SetupStatus | "loading" | "unavailable">(apiBaseUrl ? "loading" : "unavailable");
  const startup = useRef<ReturnType<typeof startDashboardEntry<SetupStatus>> | undefined>(undefined);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (!apiBaseUrl) return;
    let active = true;
    const entry = startup.current ??= startDashboardEntry<SetupStatus>();
    void entry.setup.then((status) => {
      if (!active) return;
      // Setup completion creates a new session. Discard pre-bootstrap reads.
      if (!status.configured) startup.current = undefined;
      setRemoteStatus(status);
    }).catch(() => { if (active) setRemoteStatus("unavailable"); });
    return () => { active = false; };
  }, []);

  function chooseTheme(next: "light" | "dark") {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(themeStorageKey, next); } catch { /* Browser storage can be unavailable in private contexts. */ }
  }

  // A build without a Worker API address cannot reach setup. Deployed builds always set one, so this only appears in an unconfigured local preview.
  if (!apiBaseUrl) return <CenteredState theme={theme} title="Setup service not configured" detail="This dashboard build has no Worker API address. Set VITE_API_BASE_URL for a local preview, or deploy with the private setup workflow." link={{ label: "Open the setup guide", href: setupGuideUrl }} />;
  return <ProvisionedEntry startup={startup.current} status={remoteStatus} onConfigured={(status) => setRemoteStatus(status)} theme={theme} onTheme={chooseTheme} />;
}

function ProvisionedEntry({ startup, status, onConfigured, theme, onTheme }: { startup?: ReturnType<typeof startDashboardEntry<SetupStatus>>; status: SetupStatus | "loading" | "unavailable"; onConfigured: (status: SetupStatus) => void; theme: "light" | "dark"; onTheme: (theme: "light" | "dark") => void }) {
  if (status === "loading") return <CenteredState theme={theme} title="Checking your installation…" detail="LancerLogin is securely reading setup status." />;
  if (status === "unavailable") return <CenteredState theme={theme} title="Setup service unavailable" detail="The dashboard cannot reach its Worker API. Check the deployment workflow and try again." />;
  const branding = status.configured ? status.settings : undefined;
  const style = branding ? brandTheme(branding.primaryColor, branding.secondaryColor) : undefined;
  if (status.configured && resolveDashboardPublicPage(installedDashboardModules, normalizePath(window.location.pathname))) return <PublicModuleEntry branding={branding} style={style} theme={theme} onTheme={onTheme} />;
  return <div className="app" data-theme={theme} style={style}><a className="skip-link" href="#dashboard-content">Skip to main content</a><div className="provisioned-main">{status.configured ? <ConfiguredInstallation initialSession={startup?.session} initialModules={startup?.modules} status={status} onStatusChange={onConfigured} theme={theme} onTheme={onTheme} /> : <><EntryHeader branding={branding} theme={theme} onTheme={onTheme} /><FirstAdminSetup defaultTheme={startingTheme(status)} onConfigured={onConfigured} /></>}</div></div>;
}

/**
 * A module's public page (such as Outreach's submission form), rendered without signing in inside its module root. It owns
 * its base path and every path below it, so it follows in-place navigation between its sub pages. Leaving every public
 * page reloads, because this entry never started the signed-in session and module reads.
 */
function PublicModuleEntry({ branding, style, theme, onTheme }: { branding?: Branding; style?: CSSProperties; theme: "light" | "dark"; onTheme: (theme: "light" | "dark") => void }) {
  const { path, navigate } = usePath();
  const publicPage = resolveDashboardPublicPage(installedDashboardModules, path);
  const leaving = !publicPage;
  useEffect(() => { if (leaving) window.location.reload(); }, [leaving]);
  if (!publicPage) return null;
  return <div className="app" data-theme={theme} style={style}><a className="skip-link" href="#dashboard-content">{publicPage.page.skipLinkLabel}</a><div className="provisioned-main"><EntryHeader branding={branding} theme={theme} onTheme={onTheme} /><ModuleRoot moduleId={publicPage.moduleId}>{publicPage.page.render({ subpath: publicPage.subpath, navigate })}</ModuleRoot></div></div>;
}

function EntryHeader({ branding, theme, onTheme }: { branding?: Branding; theme: "light" | "dark"; onTheme: (theme: "light" | "dark") => void }) { return <header className="setup-header"><a className="brand-home-link" href="/dashboard" aria-label="Go to Dashboard">{branding?.logoData ? <AdaptiveBrandLogo src={branding.logoData} alt="" backdrop={branding.logoBackdrop} className="header-logo" /> : <div className="brand-mark" aria-hidden="true">L</div>}<span className="brand-heading"><strong>{branding?.organizationName ?? "LancerLogin"}</strong>{branding?.subtitle && <span>{branding.subtitle}</span>}</span></a><ThemeToggle theme={theme} onTheme={onTheme} /></header>; }

function CenteredState({ theme, title, detail, link }: { theme: "light" | "dark"; title: string; detail: string; link?: { label: string; href: string } }) {
  return <div className="app" data-theme={theme}><main className="centered-state" aria-live="polite" aria-busy={title.startsWith("Checking")}><div className="brand-mark" aria-hidden="true">L</div><p className="kicker">LancerLogin dashboard</p><h1>{title}</h1><p>{detail}</p>{link && <a href={link.href} target="_blank" rel="noreferrer">{link.label}<span aria-hidden="true"> ↗</span></a>}</main></div>;
}

const authModeChoices = [
  { mode: "local", title: "Username and password", detail: "Works without an identity provider." },
  { mode: "google", title: "Google OAuth", detail: "Use your organization’s Google accounts." },
  { mode: "both", title: "Both methods", detail: "Let each Admin use either method." },
] as const;

/** IANA zones this browser supports, keeping the browser's own zone when the list omits it (some engines omit UTC). */
function supportedTimeZones(current: string): string[] | undefined {
  const supportedValuesOf = (Intl as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  let zones: string[];
  try { zones = supportedValuesOf?.("timeZone") ?? []; } catch { return undefined; }
  if (!zones.length) return undefined;
  return zones.includes(current) ? zones : [current, ...zones];
}

function FirstAdminSetup({ defaultTheme, onConfigured }: { defaultTheme: ThemeColors; onConfigured: (status: SetupStatus) => void }) {
  const [setupCode, setSetupCode] = useState("");
  const [authMode, setAuthMode] = useState<"google" | "local" | "both">("local");
  const [organizationName, setOrganizationName] = useState("");
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [timeZones] = useState(() => supportedTimeZones(timeZone));
  const [adminEmail, setAdminEmail] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [localUsername, setLocalUsername] = useState("");
  const [localPassword, setLocalPassword] = useState("");
  const [localPasswordConfirmation, setLocalPasswordConfirmation] = useState("");
  const [result, setResult] = useState<{ busy?: boolean; error?: string }>({});
  const usesGoogle = authMode === "google" || authMode === "both";
  const usesLocal = authMode === "local" || authMode === "both";

  async function submit(event: FormEvent) {
    event.preventDefault(); setResult({ busy: true });
    if (usesLocal && localPassword !== localPasswordConfirmation) { setResult({ error: "The password confirmation does not match. Re-enter both password fields." }); return; }
    let response: Response;
    try { response = await fetch(`${apiBaseUrl}/setup/bootstrap`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode, organizationName, timeZone, authMode, adminEmail: usesGoogle ? adminEmail : undefined, googleClientId: usesGoogle ? googleClientId : undefined, googleClientSecret: usesGoogle ? googleClientSecret : undefined, localUsername: usesLocal ? localUsername : undefined, localPassword: usesLocal ? localPassword : undefined }) }); }
    catch { setResult({ error: "Setup service unavailable. Check your connection and try again; your entries are kept." }); return; }
    const body = await response.json().catch(() => ({})) as { error?: string; details?: string[] };
    if (!response.ok) { setResult({ error: body.details?.join(" ") ?? body.error ?? (response.status >= 500 ? "Setup service unavailable. Try again; your entries are kept." : "Setup failed") }); return; }
    // A local-password setup sets the first Admin's session cookie, so the session check that follows signs them in.
    onConfigured({ configured: true, justCreated: true, installation: { authMode }, defaultTheme, settings: { organizationName, subtitle: "", logoData: "", primaryColor: defaultTheme.primary, secondaryColor: defaultTheme.secondary, appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 } });
  }

  const setupErrorId = result.error ? "first-admin-error" : undefined;
  const passwordMismatch = Boolean(localPasswordConfirmation && localPassword !== localPasswordConfirmation);
  return <main id="dashboard-content" className="first-admin-card ui-card" aria-labelledby="first-admin-title"><div className="form-intro"><p className="kicker">First-time setup</p><h1 id="first-admin-title">Create your installation</h1><p>This creates the first Admin in your organization’s new database. You can change branding and add more users afterward.</p></div><form className="ui-form" onSubmit={submit} aria-describedby={setupErrorId}>
    <label htmlFor="setup-code">One-time setup code<span id="setup-code-help" className="field-help">Enter the private code you saved as the LANCERLOGIN_SETUP_CODE deployment secret.</span><input id="setup-code" required minLength={16} type="password" value={setupCode} onChange={(event) => setSetupCode(event.target.value)} autoComplete="one-time-code" aria-describedby={`setup-code-help${setupErrorId ? ` ${setupErrorId}` : ""}`} aria-invalid={Boolean(result.error)} /></label>
    <div className="form-grid"><label htmlFor="organization-name">Organization name<input id="organization-name" required maxLength={100} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} autoComplete="organization" /></label><label htmlFor="time-zone">Time zone{timeZones ? <select id="time-zone" className="ui-native-select" required value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>{timeZones.map((zone) => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}</select> : <input id="time-zone" required value={timeZone} onChange={(event) => setTimeZone(event.target.value)} placeholder="America/New_York" autoComplete="off" />}</label></div>
    <fieldset><legend id="auth-mode-legend">Dashboard sign-in</legend><div className="choice-grid" role="radiogroup" aria-labelledby="auth-mode-legend">{authModeChoices.map(({ mode, title, detail }) => <label htmlFor={`auth-mode-${mode}`} className={authMode === mode ? "choice selected" : "choice"} key={mode}><input id={`auth-mode-${mode}`} type="radio" name="auth-mode" value={mode} checked={authMode === mode} onChange={() => setAuthMode(mode)} aria-labelledby={`auth-mode-${mode}-title`} aria-describedby={`auth-mode-${mode}-detail`} /><strong id={`auth-mode-${mode}-title`}>{title}</strong><span id={`auth-mode-${mode}-detail`}>{detail}</span></label>)}</div></fieldset>
    {usesGoogle && <fieldset><legend>Google OAuth guided setup</legend><div className="oauth-walkthrough"><p>Use an organization-owned Google Cloud project. In Google Auth Platform, configure Branding, Audience, Data Access, and one <strong>Web application</strong> client.</p><a className="oauth-guide-link" href={googleOAuthGuideUrl} target="_blank" rel="noreferrer">Open the complete Google OAuth guide<span aria-hidden="true"> ↗</span></a><CopyValue label="Authorized redirect URI" value={`${window.location.origin}/api/auth/google/callback`} /><p className="field-help">Register this exact value under Authorized redirect URIs. LancerLogin does not need an Authorized JavaScript origin. Saved secrets are encrypted and never displayed again.</p></div><label htmlFor="admin-email">First Admin Google email<input id="admin-email" type="email" required value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} autoComplete="email" /></label><div className="form-grid"><label htmlFor="google-client-id">OAuth client ID<input id="google-client-id" required maxLength={500} value={googleClientId} onChange={(event) => setGoogleClientId(event.target.value)} autoComplete="off" /></label><label htmlFor="google-client-secret">OAuth client secret<input id="google-client-secret" required maxLength={500} type="password" value={googleClientSecret} onChange={(event) => setGoogleClientSecret(event.target.value)} autoComplete="off" /></label></div></fieldset>}
    {usesLocal && <><div className="form-grid"><label htmlFor="admin-username">Admin username<input id="admin-username" required value={localUsername} onChange={(event) => setLocalUsername(event.target.value)} autoComplete="username" /></label><div className="field-with-help"><label htmlFor="admin-password">Admin password<input id="admin-password" type="password" minLength={12} required value={localPassword} onChange={(event) => setLocalPassword(event.target.value)} autoComplete="new-password" aria-describedby="admin-password-help" /></label><p id="admin-password-help" className="field-help">At least 12 characters. If every Admin loses their password, see <a href={recoverAccessUrl} target="_blank" rel="noreferrer">Recover access<span aria-hidden="true"> ↗</span></a> in the docs.</p></div></div><label htmlFor="admin-password-confirmation">Confirm Admin password<input id="admin-password-confirmation" type="password" minLength={12} required value={localPasswordConfirmation} onChange={(event) => setLocalPasswordConfirmation(event.target.value)} autoComplete="new-password" aria-invalid={passwordMismatch} aria-describedby={passwordMismatch ? "password-confirmation-help" : undefined} /></label>{passwordMismatch && <p id="password-confirmation-help" className="inline-field-error" role="alert">Passwords do not match.</p>}</>}
    {result.error && <p id="first-admin-error" className="ui-status form-error" data-tone="error" role="alert" tabIndex={-1}>{result.error}</p>}<button className="primary-button" disabled={result.busy} type="submit">{result.busy ? "Creating installation…" : "Create first Admin"}</button>
  </form></main>;
}

function ConfiguredInstallation({ initialSession, initialModules, status, onStatusChange, theme, onTheme }: { initialSession?: Promise<DashboardSession | undefined>; initialModules?: Promise<ModuleNavigationResult>; status: SetupStatus; onStatusChange: (status: SetupStatus) => void; theme: "light" | "dark"; onTheme: (theme: "light" | "dark") => void }) {
  const [session, setSession] = useState<DashboardSession>();
  const [moduleRequest, setModuleRequest] = useState(() => initialModules);
  const [checking, setChecking] = useState(true);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const mounted = useRef(true);
  function checkSession(request: Promise<DashboardSession | undefined>) {
    setChecking(true); setSessionUnavailable(false);
    void request.then((user) => {
      if (!mounted.current) return;
      setSession(user); setChecking(false);
      if (!user) setModuleRequest(undefined);
    }, () => {
      // A transient failure is not a sign-out: keep the session cookie and offer a retry instead of the sign-in form.
      if (!mounted.current) return;
      setModuleRequest(undefined); setSessionUnavailable(true); setChecking(false);
    });
  }
  useEffect(() => {
    mounted.current = true;
    checkSession(initialSession ?? loadDashboardSession());
    return () => { mounted.current = false; };
  }, []);
  if (checking) return <section className="centered-state auth-check" aria-live="polite" aria-busy="true"><p className="kicker">Secure sign-in</p><h1>Checking your session…</h1><p>Confirming whether this browser already has an active dashboard session.</p></section>;
  if (sessionUnavailable) return <section className="centered-state auth-check" aria-live="polite"><p className="kicker">Secure sign-in</p><h1>Session check unavailable</h1><p>LancerLogin could not confirm your session. Check your connection and try again.</p><button className="primary-button" type="button" onClick={() => checkSession(loadDashboardSession())}>Try again</button></section>;
  if (session) return <WalkthroughSessionProvider userId={session.id}><AppShell initialModules={moduleRequest} themeControl={<ThemeToggle theme={theme} onTheme={onTheme} />} role={session.role} debugMode={session.debugMode} onDebugModeChanged={async (debugMode) => { const response = await fetch(`${apiBaseUrl}/auth/preferences`, { method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ debugMode }) }); if (!response.ok) throw new Error("Could not save Debug mode."); setSession((current) => current ? { ...current, debugMode } : current); }} branding={status.settings ?? { organizationName: "LancerLogin", subtitle: "", logoData: "", primaryColor: startingTheme(status).primary, secondaryColor: startingTheme(status).secondary, appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 }} onBrandingChanged={(settings) => onStatusChange({ ...status, settings })} onSessionExpired={() => { setModuleRequest(undefined); setSession(undefined); }} onSignedOut={() => { void fetch(`${apiBaseUrl}/auth/logout`, { method: "POST", credentials: "include" }).finally(() => { clearWalkthroughSession(session.id); setModuleRequest(undefined); setSession(undefined); }); }} /></WalkthroughSessionProvider>;
  return <><EntryHeader branding={status.settings} theme={theme} onTheme={onTheme} /><LocalLogin status={status} onSignedIn={setSession} /></>;
}

function signInFailureMessage(status: number) {
  if (status === 429) return "Too many sign-in attempts. Wait a few minutes before trying again.";
  if (status >= 500) return "Sign-in service unavailable. Try again shortly.";
  return "Invalid username or password. Check your details or wait before trying again.";
}

function LocalLogin({ status, onSignedIn }: { status: SetupStatus; onSignedIn: (user: { id: string; role: "admin" | "operator"; debugMode: boolean }) => void }) {
  const mode = status.installation?.authMode ?? "local";
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setMessage(""); setBusy(true); try { const response = await fetch(`${apiBaseUrl}/auth/local`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) }); if (response.ok) onSignedIn((await response.json() as { user: { id: string; role: "admin" | "operator"; debugMode: boolean } }).user); else setMessage(signInFailureMessage(response.status)); } catch { setMessage("Sign-in service unavailable. Check your connection and try again."); } finally { setBusy(false); } }
  const messageId = message ? "sign-in-message" : undefined;
  return <main id="dashboard-content" className="login-card ui-card" aria-labelledby="sign-in-title"><div className="form-intro"><p className="kicker">{status.settings?.organizationName ?? "LancerLogin"}</p><h1 id="sign-in-title">{status.justCreated ? "Sign in to finish setup" : "Sign in"}</h1><p>{status.justCreated ? mode === "google" ? "Your installation is ready. Continue with Google using the first Admin email to finish setup." : "Your installation is ready. Sign in with the Admin account you just created to finish setup." : "Sign in to manage attendance."}</p></div>{mode !== "google" && <form className="ui-form" onSubmit={submit} aria-describedby={messageId}><label htmlFor="sign-in-username">Username<input id="sign-in-username" required autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} aria-invalid={Boolean(message)} aria-describedby={messageId} /></label><label htmlFor="sign-in-password">Password<input id="sign-in-password" required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={Boolean(message)} aria-describedby={messageId} /></label><button className="primary-button" disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}</button></form>}{mode === "both" && <div className="auth-divider" aria-hidden="true"><span>or</span></div>}{mode !== "local" && <a className="google-button action-link" href={`${apiBaseUrl}/auth/google/start`}>Continue with Google</a>}{message && <p id="sign-in-message" className="ui-status auth-message" data-tone="error" role="alert" tabIndex={-1}>{message}</p>}</main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><ErrorBoundary fallback={() => <AppErrorFallback />}><App /></ErrorBoundary></StrictMode>);
