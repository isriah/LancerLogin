import { FormEvent, StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type CloudflareStep = { id: string; title: string; detail: string; action?: { label: string; href: string } };

const cloudflareSteps: CloudflareStep[] = [
  { id: "account", title: "Create or sign in to Cloudflare", detail: "Use an account owned by your organization—not a developer’s personal deployment.", action: { label: "Open Cloudflare", href: "https://dash.cloudflare.com/sign-up" } },
  { id: "token", title: "Create a scoped API token", detail: "Allow only Workers Scripts, D1, and Pages for the account you chose.", action: { label: "Create token", href: "https://dash.cloudflare.com/profile/api-tokens" } },
  { id: "secret", title: "Link the token through GitHub", detail: "Save it as CLOUDFLARE_API_TOKEN in this repository’s Actions secrets. LancerLogin never receives or displays it." },
  { id: "provision", title: "Run the setup workflow", detail: "GitHub Actions previews the new resource names before it creates anything." },
];

const installationSteps = ["Branding", "Roster", "Pair kiosk", "Fingerprint test", "Test meeting", "Confirm attendance"];
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

type SetupStatus = { configured: boolean; installation?: { authMode: "google" | "local" | "both" }; settings?: { organizationName?: string } };

function App() {
  const [completed, setCompleted] = useState<string[]>([]);
  const [slug, setSlug] = useState("my-organization");
  const [theme, setTheme] = useState<"light" | "dark">("light");
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

  if (apiBaseUrl) return <ProvisionedEntry status={remoteStatus} onConfigured={(status) => setRemoteStatus(status)} theme={theme} onTheme={() => setTheme(theme === "light" ? "dark" : "light")} />;

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
        <button className="theme-button" type="button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>{theme === "light" ? "Dark" : "Light"} mode</button>
      </header>

      <section className="notice" aria-labelledby="privacy-title">
        <div className="notice-icon" aria-hidden="true">✓</div>
        <div><h2 id="privacy-title">Your account. Your data. Your installation.</h2><p>The setup workflow creates a new Worker, D1 database, and Pages dashboard only inside the account you link. It cannot see or reuse another LancerLogin installation.</p></div>
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

function ProvisionedEntry({ status, onConfigured, theme, onTheme }: { status: SetupStatus | "loading" | "unavailable"; onConfigured: (status: SetupStatus) => void; theme: "light" | "dark"; onTheme: () => void }) {
  if (status === "loading") return <CenteredState theme={theme} title="Checking your installation…" detail="LancerLogin is securely reading setup status." />;
  if (status === "unavailable") return <CenteredState theme={theme} title="Setup service unavailable" detail="The dashboard cannot reach its Worker API. Check the deployment workflow and try again." />;
  return <div className="app" data-theme={theme}><main className="provisioned-main"><header className="setup-header"><div className="brand-mark" aria-hidden="true">L</div><div><strong>LancerLogin</strong><span>Community Edition</span></div><button className="theme-button" type="button" onClick={onTheme}>{theme === "light" ? "Dark" : "Light"} mode</button></header>{status.configured ? <LocalLogin status={status} /> : <FirstAdminSetup onConfigured={onConfigured} />}</main></div>;
}

function CenteredState({ theme, title, detail }: { theme: "light" | "dark"; title: string; detail: string }) {
  return <div className="app" data-theme={theme}><main className="centered-state" aria-live="polite"><div className="brand-mark" aria-hidden="true">L</div><h1>{title}</h1><p>{detail}</p></main></div>;
}

function FirstAdminSetup({ onConfigured }: { onConfigured: (status: SetupStatus) => void }) {
  const [authMode, setAuthMode] = useState<"google" | "local" | "both">("local");
  const [organizationName, setOrganizationName] = useState("");
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [adminEmail, setAdminEmail] = useState("");
  const [localUsername, setLocalUsername] = useState("");
  const [localPassword, setLocalPassword] = useState("");
  const [telemetryAccepted, setTelemetryAccepted] = useState(false);
  const [result, setResult] = useState<{ busy?: boolean; error?: string }>({});
  const usesGoogle = authMode === "google" || authMode === "both";
  const usesLocal = authMode === "local" || authMode === "both";

  async function submit(event: FormEvent) {
    event.preventDefault(); setResult({ busy: true });
    const response = await fetch(`${apiBaseUrl}/setup/bootstrap`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationName, timeZone, authMode, adminEmail: usesGoogle ? adminEmail : undefined, localUsername: usesLocal ? localUsername : undefined, localPassword: usesLocal ? localPassword : undefined, telemetryAccepted }) });
    const body = await response.json() as { error?: string; details?: string[] };
    if (!response.ok) { setResult({ error: body.details?.join(" ") ?? body.error ?? "Setup failed" }); return; }
    onConfigured({ configured: true, installation: { authMode }, settings: { organizationName } });
  }

  return <section className="first-admin-card" aria-labelledby="first-admin-title"><div className="form-intro"><p className="kicker">First-time setup</p><h1 id="first-admin-title">Create your installation</h1><p>This creates the first Admin in your organization’s new database. You can change branding and add more users afterward.</p></div><form onSubmit={submit}>
    <div className="form-grid"><label>Organization name<input required maxLength={100} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} autoComplete="organization" /></label><label>Time zone<input required value={timeZone} onChange={(event) => setTimeZone(event.target.value)} /></label></div>
    <fieldset><legend>Dashboard sign-in</legend><div className="choice-grid">{(["local", "google", "both"] as const).map((mode) => <label className={authMode === mode ? "choice selected" : "choice"} key={mode}><input type="radio" name="auth-mode" value={mode} checked={authMode === mode} onChange={() => setAuthMode(mode)} /><strong>{mode === "local" ? "Username and password" : mode === "google" ? "Google OAuth" : "Both methods"}</strong><span>{mode === "local" ? "Works without an identity provider." : mode === "google" ? "Use your organization’s Google accounts." : "Let each Admin use either method."}</span></label>)}</div></fieldset>
    {usesGoogle && <label>First Admin Google email<input type="email" required value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} autoComplete="email" /></label>}
    {usesLocal && <div className="form-grid"><label>Admin username<input required value={localUsername} onChange={(event) => setLocalUsername(event.target.value)} autoComplete="username" /></label><label>Admin password<input type="password" minLength={12} required value={localPassword} onChange={(event) => setLocalPassword(event.target.value)} autoComplete="new-password" /><span className="field-help">At least 12 characters. Recovery uses the local setup tool.</span></label></div>}
    <label className="telemetry-choice"><input type="checkbox" checked={telemetryAccepted} onChange={(event) => setTelemetryAccepted(event.target.checked)} /><span><strong>Share privacy-preserving telemetry</strong><small>Optional. Sends a random install ID, release version, active kiosk count, scrubbed errors, and approximate metro only. Never sends organization, roster, attendance, fingerprint, or raw IP data.</small></span></label>
    {result.error && <p className="form-error" role="alert">{result.error}</p>}<button className="primary-button" disabled={result.busy} type="submit">{result.busy ? "Creating installation…" : "Create first Admin"}</button>
  </form></section>;
}

function LocalLogin({ status }: { status: SetupStatus }) {
  const mode = status.installation?.authMode ?? "local";
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [message, setMessage] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); setMessage(""); const response = await fetch(`${apiBaseUrl}/auth/local`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) }); setMessage(response.ok ? "Signed in. Loading your dashboard…" : "Invalid username or password."); }
  return <section className="login-card"><p className="kicker">{status.settings?.organizationName ?? "LancerLogin"}</p><h1>Welcome back</h1><p>Sign in to manage attendance and finish setup.</p>{mode !== "google" && <form onSubmit={submit}><label>Username<input required autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>Password<input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="primary-button" type="submit">Sign in</button></form>}{mode !== "local" && <button className="google-button" type="button">Continue with Google</button>}{message && <p role="status">{message}</p>}</section>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
