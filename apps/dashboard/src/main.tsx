import { StrictMode, useMemo, useState } from "react";
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

function App() {
  const [completed, setCompleted] = useState<string[]>([]);
  const [slug, setSlug] = useState("my-organization");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const validSlug = /^[a-z][a-z0-9-]{2,40}$/.test(slug);
  const plannedResources = useMemo(() => validSlug ? [`${slug}-api`, `${slug}-data`, `${slug}-dashboard`] : [], [slug, validSlug]);
  const toggle = (id: string) => setCompleted((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

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

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
