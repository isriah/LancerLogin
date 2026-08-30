import { validateProvisionPlan } from "../../../scripts/provision-plan.mjs";

export const cloudflareSetupSteps = Object.freeze([
  { id: "cloudflare-account", title: "Create or sign in to Cloudflare", href: "https://dash.cloudflare.com/sign-up", detail: "Use an account owned by your organization." },
  { id: "cloudflare-token", title: "Create a narrowly scoped API token", href: "https://dash.cloudflare.com/profile/api-tokens", detail: "Limit it to Workers, D1, and Pages for this installation." },
  { id: "github-secret", title: "Add the token to GitHub Actions", detail: "GitHub repository → Settings → Secrets and variables → Actions → CLOUDFLARE_API_TOKEN." },
  { id: "provision", title: "Run Provision adopter installation", detail: "Review the generated resource names before creation." },
]);

export function setupProgress(state = {}) {
  return cloudflareSetupSteps.map((step) => ({ ...step, complete: state[step.id] === true }));
}

export function previewProvision(input) {
  try { return { ok: true, ...validateProvisionPlan({ ...input, dryRun: true }) }; }
  catch (error) { return { ok: false, message: error.message }; }
}

export function renderCloudflareSetup({ state = {}, installationSlug = "" }) {
  const steps = setupProgress(state).map((step) => `<li data-complete="${step.complete}"><strong>${step.complete ? "✓" : "○"} ${step.title}</strong><p>${step.detail}</p>${step.href ? `<a href="${step.href}" target="_blank" rel="noreferrer">Open ${step.title}</a>` : ""}</li>`).join("");
  const preview = previewProvision({ installationSlug });
  const preflight = preview.ok ? `<p role="status">Dry-run ready. Planned resources: ${preview.plannedResources.join(", ")}.</p>` : `<p role="alert">${preview.message}</p>`;
  return `<section aria-labelledby="cloudflare-heading"><h2 id="cloudflare-heading">Connect Cloudflare</h2><p>LancerLogin deploys only to your organization’s account. This screen never asks for, sends, or stores your API token.</p><ol>${steps}</ol><label for="installation-slug">Installation slug</label><input id="installation-slug" value="${escapeAttribute(installationSlug)}" autocomplete="off">${preflight}<a href="#cloudflare-help">Cloudflare setup help</a></section>`;
}

function escapeAttribute(value) { return String(value).replace(/[&"']/g, (character) => ({ "&": "&amp;", '"': "&quot;", "'": "&#39;" })[character]); }
