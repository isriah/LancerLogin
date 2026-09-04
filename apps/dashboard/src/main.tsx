import { FormEvent, StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/bebas-neue/latin-400.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-700.css";
import "./styles.css";
import type { Branding } from "./setup-workspace";
import { AppShell } from "./app-shell";
import { AdaptiveBrandLogo } from "./adaptive-brand-logo";
import { brandTheme } from "./theme";

type CloudflareStep = { id: string; title: string; detail: string; action?: { label: string; href: string } };

const cloudflareSteps: CloudflareStep[] = [
  { id: "private-repository", title: "Create a private deployment repository", detail: "Use the public LancerLogin template, choose Private, and keep deployment runs and Cloudflare credentials there." },
  { id: "account", title: "Create or sign in to Cloudflare", detail: "Use an account owned by your organization—not a developer’s personal deployment.", action: { label: "Open Cloudflare", href: "https://dash.cloudflare.com/sign-up" } },
  { id: "token", title: "Create a scoped Account API Token", detail: "In Manage account → Account API Tokens, allow Account Settings read plus Workers Scripts, D1, and Pages edit.", action: { label: "Open Cloudflare", href: "https://dash.cloudflare.com/" } },
  { id: "account-id", title: "Copy the selected Account ID", detail: "Find it on the Cloudflare account overview. Keep it out of source code." },
  { id: "secrets", title: "Link the private deployment secrets", detail: "Store the account ID, token, and a private one-time setup code in the private repository’s production environment. LancerLogin never displays saved values." },
  { id: "provision", title: "Run the private setup workflow", detail: "Keep Latest stable selected. GitHub validates the account and resource names before it creates anything." },
];

const installationSteps = ["Organization & brand", "Roster", "Pair hardware or simulator", "Kiosk input test", "Confirm attendance"];
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const googleOAuthGuideUrl = "https://isriah.github.io/LancerLogin/setup.html#google-oauth";

type SetupStatus = { configured: boolean; installation?: { authMode: "google" | "local" | "both" }; settings?: Branding };
const themeStorageKey = "lancerlogin-theme";
function savedTheme(): "light" | "dark" { try { return localStorage.getItem(themeStorageKey) === "light" ? "light" : "dark"; } catch { return "dark"; } }

function ThemeToggle({ theme, onTheme }: { theme: "light" | "dark"; onTheme: (theme: "light" | "dark") => void }) {
  const dark = theme === "dark";
  return <button className="theme-toggle" type="button" role="switch" aria-checked={dark} aria-label="Dark mode" onClick={() => onTheme(dark ? "light" : "dark")}>
    <span className="theme-toggle-label" aria-hidden="true">{dark ? "Dark" : "Light"}</span>
    <span className="theme-toggle-track" aria-hidden="true"><span /></span>
  </button>;
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="copy-value"><span>{label}</span><code>{value}</code><button type="button" onClick={() => void navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); })}>{copied ? "Copied" : "Copy"}</button></div>;
}

function App() {
  const [completed, setCompleted] = useState<string[]>([]);
  const [slug, setSlug] = useState("my-organization");
  const [theme, setTheme] = useState<"light" | "dark">(savedTheme);
  const [remoteStatus, setRemoteStatus] = useState<SetupStatus | "loading" | "unavailable">(apiBaseUrl ? "loading" : "unavailable");
  const validSlug = /^[a-z][a-z0-9-]{2,40}$/.test(slug);
  const plannedResources = useMemo(() => validSlug ? [`${slug}-api`, `${slug}-data`, `${slug}-dashboard`] : [], [slug, validSlug]);
  const toggle = (id: string) => setCompleted((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  useEffect(() => {
    if (!apiBaseUrl) return;
    fetch(`${apiBaseUrl}/setup/status`, { credentials: "include" })
      .then(async (result) => result.ok ? result.json() as Promise<SetupStatus> : Promise.reject(new Error("Setup API unavailable")))
      .then(setRemoteStatus)
      .catch(() => setRemoteStatus("unavailable"));
  }, []);

  function chooseTheme(next: "light" | "dark") {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(themeStorageKey, next); } catch { /* Browser storage can be unavailable in private contexts. */ }
  }

  if (apiBaseUrl) return <ProvisionedEntry status={remoteStatus} onConfigured={(status) => setRemoteStatus(status)} theme={theme} onTheme={chooseTheme} />;

  return <div className="app" data-theme={theme}>
    <a className="skip-link" href="#main">Skip to main content</a>
    <aside className="sidebar" aria-label="Product navigation">
      <div className="brand-mark" aria-hidden="true">L</div>
      <div className="brand-copy"><strong>LancerLogin</strong><span>Community Edition</span></div>
      <nav aria-label="Primary">
        <a className="nav-item active" href="#setup" aria-current="page"><span>01</span> Setup</a>
        <span className="nav-item disabled" aria-disabled="true"><span>02</span> Dashboard</span>
        <span className="nav-item disabled" aria-disabled="true"><span>03</span> Meetings</span>
        <span className="nav-item disabled" aria-disabled="true"><span>04</span> Attendance</span>
        <span className="nav-item disabled" aria-disabled="true"><span>05</span> Reports</span>
      </nav>
      <div className="sidebar-footer"><span className="status-dot" /> Local preview · no cloud linked</div>
    </aside>

    <main id="main" className="main">
      <header className="topbar">
        <div><p className="kicker">Installation setup</p><h1>Connect your own Cloudflare account</h1></div>
        <ThemeToggle theme={theme} onTheme={chooseTheme} />
      </header>

      <section className="notice" aria-labelledby="privacy-title">
        <div className="notice-icon" aria-hidden="true">✓</div>
        <div><h2 id="privacy-title">Public source. Private deployment. Your data.</h2><p>The public project contains no adopter credentials. Your private repository deploys a reviewed release into only the Cloudflare account you link.</p></div>
      </section>

      <div className="content-grid">
        <section className="panel setup-panel" aria-labelledby="connect-title">
          <div className="panel-heading"><div><p className="step-label">Before first sign-in</p><h2 id="connect-title">Link Cloudflare</h2></div><span className="progress-count">{completed.length} / {cloudflareSteps.length}</span></div>
          <ol className="steps">
            {cloudflareSteps.map((step, index) => <li key={step.id} className={completed.includes(step.id) ? "step complete" : "step"}>
              <button className="step-toggle" type="button" onClick={() => toggle(step.id)} aria-label={`${completed.includes(step.id) ? "Mark incomplete" : "Mark complete"}: ${step.title}`}>{completed.includes(step.id) ? "✓" : index + 1}</button>
              <div className="step-content"><h3>{step.title}</h3><p>{step.detail}</p>{step.action && <a href={step.action.href} target="_blank" rel="noreferrer">{step.action.label}<span aria-hidden="true"> ↗</span></a>}</div>
            </li>)}
          </ol>
        </section>

        <aside className="panel preview-panel" aria-labelledby="preview-title">
          <p className="step-label">Dry-run preview</p><h2 id="preview-title">Resource plan</h2>
          <label htmlFor="slug">Installation slug</label>
          <input id="slug" value={slug} onChange={(event) => setSlug(event.target.value)} aria-describedby="slug-help" aria-invalid={!validSlug} />
          <p id="slug-help" className={validSlug ? "field-help" : "field-help error"}>{validSlug ? "Lowercase letters, numbers, and hyphens." : "Start with a letter; use 3–41 lowercase letters, numbers, or hyphens."}</p>
          <div className="resource-list" aria-live="polite">{validSlug ? plannedResources.map((resource, index) => <div key={resource}><span>{["Worker API", "D1 database", "Pages dashboard"][index]}</span><code>{resource}</code></div>) : <p>Enter a valid slug to preview resources.</p>}</div>
          <button type="button" className="primary-button" disabled={!validSlug || completed.length < 3}>Preview GitHub workflow</button>
          <p className="button-note">This preview does not create resources or transmit a token.</p>
        </aside>
      </div>

      <section className="after-setup" aria-labelledby="after-title"><div><p className="step-label">After deployment</p><h2 id="after-title">Your shared setup checklist</h2><p>Any Admin can resume these required steps. Optional integrations stay separate and never block launch.</p></div><ol>{installationSteps.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, "0")}</span>{step}</li>)}</ol></section>
    </main>
  </div>;
}

function ProvisionedEntry({ status, onConfigured, theme, onTheme }: { status: SetupStatus | "loading" | "unavailable"; onConfigured: (status: SetupStatus) => void; theme: "light" | "dark"; onTheme: (theme: "light" | "dark") => void }) {
  if (status === "loading") return <CenteredState theme={theme} title="Checking your installation…" detail="LancerLogin is securely reading setup status." />;
  if (status === "unavailable") return <CenteredState theme={theme} title="Setup service unavailable" detail="The dashboard cannot reach its Worker API. Check the deployment workflow and try again." />;
  const branding = status.configured ? status.settings : undefined;
  const style = branding ? brandTheme(branding.primaryColor, branding.secondaryColor) : undefined;
  return <div className="app" data-theme={theme} style={style}><a className="skip-link" href="#dashboard-content">Skip to main content</a><div className="provisioned-main"><header className="setup-header"><a className="brand-home-link" href="/dashboard" aria-label="Go to Dashboard">{branding?.logoData ? <AdaptiveBrandLogo src={branding.logoData} alt="" backdrop={branding.logoBackdrop} className="header-logo" /> : <div className="brand-mark" aria-hidden="true">L</div>}<span className="brand-heading"><strong>{branding?.organizationName ?? "LancerLogin"}</strong><span>{branding?.subtitle || "Community Edition"}</span></span></a><ThemeToggle theme={theme} onTheme={onTheme} /></header>{status.configured ? <ConfiguredInstallation status={status} onStatusChange={onConfigured} /> : <FirstAdminSetup onConfigured={onConfigured} />}</div></div>;
}

function CenteredState({ theme, title, detail }: { theme: "light" | "dark"; title: string; detail: string }) {
  return <div className="app" data-theme={theme}><main className="centered-state" aria-live="polite" aria-busy={title.startsWith("Checking")}><div className="brand-mark" aria-hidden="true">L</div><p className="kicker">LancerLogin dashboard</p><h1>{title}</h1><p>{detail}</p></main></div>;
}

function FirstAdminSetup({ onConfigured }: { onConfigured: (status: SetupStatus) => void }) {
  const [setupCode, setSetupCode] = useState("");
  const [authMode, setAuthMode] = useState<"google" | "local" | "both">("local");
  const [organizationName, setOrganizationName] = useState("");
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [adminEmail, setAdminEmail] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [localUsername, setLocalUsername] = useState("");
  const [localPassword, setLocalPassword] = useState("");
  const [localPasswordConfirmation, setLocalPasswordConfirmation] = useState("");
  const [telemetryAccepted, setTelemetryAccepted] = useState(true);
  const [result, setResult] = useState<{ busy?: boolean; error?: string }>({});
  const usesGoogle = authMode === "google" || authMode === "both";
  const usesLocal = authMode === "local" || authMode === "both";

  async function submit(event: FormEvent) {
    event.preventDefault(); setResult({ busy: true });
    if (usesLocal && localPassword !== localPasswordConfirmation) { setResult({ error: "The password confirmation does not match. Re-enter both password fields." }); return; }
    const response = await fetch(`${apiBaseUrl}/setup/bootstrap`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode, organizationName, timeZone, authMode, adminEmail: usesGoogle ? adminEmail : undefined, googleClientId: usesGoogle ? googleClientId : undefined, googleClientSecret: usesGoogle ? googleClientSecret : undefined, localUsername: usesLocal ? localUsername : undefined, localPassword: usesLocal ? localPassword : undefined, telemetryAccepted }) });
    const body = await response.json() as { error?: string; details?: string[] };
    if (!response.ok) { setResult({ error: body.details?.join(" ") ?? body.error ?? "Setup failed" }); return; }
    onConfigured({ configured: true, installation: { authMode }, settings: { organizationName, subtitle: "", logoData: "", primaryColor: "#7c3aed", secondaryColor: "#0f766e", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 } });
  }

  const setupErrorId = result.error ? "first-admin-error" : undefined;
  return <main id="dashboard-content" className="first-admin-card ui-card" aria-labelledby="first-admin-title"><div className="form-intro"><p className="kicker">First-time setup</p><h1 id="first-admin-title">Create your installation</h1><p>This creates the first Admin in your organization’s new database. You can change branding and add more users afterward.</p></div><form className="ui-form" onSubmit={submit} aria-describedby={setupErrorId}>
    <label htmlFor="setup-code">One-time setup code<span id="setup-code-help" className="field-help">Enter the private code you saved as the LANCERLOGIN_SETUP_CODE deployment secret.</span><input id="setup-code" required minLength={16} type="password" value={setupCode} onChange={(event) => setSetupCode(event.target.value)} autoComplete="one-time-code" aria-describedby={`setup-code-help${setupErrorId ? ` ${setupErrorId}` : ""}`} aria-invalid={Boolean(result.error)} /></label>
    <div className="form-grid"><label>Organization name<input required maxLength={100} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} autoComplete="organization" /></label><label>Time zone<input required value={timeZone} onChange={(event) => setTimeZone(event.target.value)} /></label></div>
    <fieldset><legend>Dashboard sign-in</legend><div className="choice-grid">{(["local", "google", "both"] as const).map((mode) => <label className={authMode === mode ? "choice selected" : "choice"} key={mode}><input type="radio" name="auth-mode" value={mode} checked={authMode === mode} onChange={() => setAuthMode(mode)} /><strong>{mode === "local" ? "Username and password" : mode === "google" ? "Google OAuth" : "Both methods"}</strong><span>{mode === "local" ? "Works without an identity provider." : mode === "google" ? "Use your organization’s Google accounts." : "Let each Admin use either method."}</span></label>)}</div></fieldset>
    {usesGoogle && <fieldset><legend>Google OAuth guided setup</legend><div className="oauth-walkthrough"><p>Use an organization-owned Google Cloud project. In Google Auth Platform, configure Branding, Audience, Data Access, and one <strong>Web application</strong> client.</p><a className="oauth-guide-link" href={googleOAuthGuideUrl} target="_blank" rel="noreferrer">Open the complete Google OAuth guide<span aria-hidden="true"> ↗</span></a><CopyValue label="Authorized redirect URI" value={`${window.location.origin}/api/auth/google/callback`} /><p className="field-help">Register this exact value under Authorized redirect URIs. LancerLogin does not need an Authorized JavaScript origin. Saved secrets are encrypted and never displayed again.</p></div><label>First Admin Google email<input type="email" required value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} autoComplete="email" /></label><div className="form-grid"><label>OAuth client ID<input required maxLength={500} value={googleClientId} onChange={(event) => setGoogleClientId(event.target.value)} autoComplete="off" /></label><label>OAuth client secret<input required maxLength={500} type="password" value={googleClientSecret} onChange={(event) => setGoogleClientSecret(event.target.value)} autoComplete="off" /></label></div></fieldset>}
    {usesLocal && <><div className="form-grid"><label>Admin username<input required value={localUsername} onChange={(event) => setLocalUsername(event.target.value)} autoComplete="username" /></label><label>Admin password<input type="password" minLength={12} required value={localPassword} onChange={(event) => setLocalPassword(event.target.value)} autoComplete="new-password" /><span className="field-help">At least 12 characters. Recovery uses the local setup tool.</span></label></div><label>Confirm Admin password<input type="password" minLength={12} required value={localPasswordConfirmation} onChange={(event) => setLocalPasswordConfirmation(event.target.value)} autoComplete="new-password" aria-invalid={Boolean(localPasswordConfirmation && localPassword !== localPasswordConfirmation)} aria-describedby="password-confirmation-help" /></label>{localPasswordConfirmation && localPassword !== localPasswordConfirmation && <p id="password-confirmation-help" className="inline-field-error" role="alert">Passwords do not match.</p>}</>}
    <label className="telemetry-choice"><input type="checkbox" checked={telemetryAccepted} onChange={(event) => setTelemetryAccepted(event.target.checked)} /><span><strong>Allow anonymous usage reporting</strong><small>Enabled by default; uncheck to opt out. Anonymous usage data only. No roster or user data is ever shared.</small></span></label>
    {result.error && <p id="first-admin-error" className="ui-status form-error" data-tone="error" role="alert" tabIndex={-1}>{result.error}</p>}<button className="primary-button" disabled={result.busy} type="submit">{result.busy ? "Creating installation…" : "Create first Admin"}</button>
  </form></main>;
}

function ConfiguredInstallation({ status, onStatusChange }: { status: SetupStatus; onStatusChange: (status: SetupStatus) => void }) {
  const [session, setSession] = useState<{ role: "admin" | "operator" }>();
  const [checking, setChecking] = useState(true);
  useEffect(() => { fetch(`${apiBaseUrl}/auth/session`, { credentials: "include" }).then(async (result) => { if (result.ok) setSession((await result.json() as { user: { role: "admin" | "operator" } }).user); }).finally(() => setChecking(false)); }, []);
  if (checking) return <section className="centered-state auth-check" aria-live="polite" aria-busy="true"><p className="kicker">Secure sign-in</p><h1>Checking your session…</h1><p>Confirming whether this browser already has an active dashboard session.</p></section>;
  if (session) return <AppShell role={session.role} branding={status.settings ?? { organizationName: "LancerLogin", subtitle: "", logoData: "", primaryColor: "#7c3aed", secondaryColor: "#0f766e", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 }} onBrandingChanged={(settings) => onStatusChange({ ...status, settings })} onSignedOut={() => { void fetch(`${apiBaseUrl}/auth/logout`, { method: "POST", credentials: "include" }).finally(() => setSession(undefined)); }} />;
  return <LocalLogin status={status} onSignedIn={(role) => setSession({ role })} />;
}

function LocalLogin({ status, onSignedIn }: { status: SetupStatus; onSignedIn: (role: "admin" | "operator") => void }) {
  const mode = status.installation?.authMode ?? "local";
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setMessage(""); setBusy(true); try { const response = await fetch(`${apiBaseUrl}/auth/local`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) }); if (response.ok) onSignedIn((await response.json() as { user: { role: "admin" | "operator" } }).user.role); else setMessage("Invalid username or password. Check your details or wait before trying again."); } catch { setMessage("Sign-in service unavailable. Check your connection and try again."); } finally { setBusy(false); } }
  const messageId = message ? "sign-in-message" : undefined;
  return <main id="dashboard-content" className="login-card ui-card" aria-labelledby="sign-in-title"><div className="form-intro"><p className="kicker">{status.settings?.organizationName ?? "LancerLogin"}</p><h1 id="sign-in-title">Welcome back</h1><p>Sign in to manage attendance and finish setup.</p></div>{mode !== "google" && <form className="ui-form" onSubmit={submit} aria-describedby={messageId}><label htmlFor="sign-in-username">Username<input id="sign-in-username" required autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} aria-invalid={Boolean(message)} aria-describedby={messageId} /></label><label htmlFor="sign-in-password">Password<input id="sign-in-password" required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={Boolean(message)} aria-describedby={messageId} /></label><button className="primary-button" disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}</button></form>}{mode === "both" && <div className="auth-divider" aria-hidden="true"><span>or</span></div>}{mode !== "local" && <a className="google-button action-link" href={`${apiBaseUrl}/auth/google/start`}>Continue with Google</a>}{message && <p id="sign-in-message" className="ui-status auth-message" data-tone="error" role="alert" tabIndex={-1}>{message}</p>}</main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
