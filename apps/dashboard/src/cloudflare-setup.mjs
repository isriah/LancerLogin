import { validateProvisionPlan } from "../../../scripts/provision-plan.mjs";

export const cloudflareSetupSteps = Object.freeze([
  { id: "private-deployment-repository", title: "Create a private deployment repository", detail: "Use the public LancerLogin template and choose Private so deployment history and credentials are not public." },
  { id: "cloudflare-account", title: "Create or sign in to Cloudflare", href: "https://dash.cloudflare.com/sign-up", detail: "Use an account owned by your organization." },
  { id: "cloudflare-token", title: "Create a narrowly scoped Account API Token", href: "https://dash.cloudflare.com/", detail: "Open Manage account → Account API Tokens. Allow Account Settings read plus Workers Scripts, D1, and Pages edit." },
  { id: "cloudflare-account-id", title: "Copy the selected Account ID", detail: "Find it on the Cloudflare account overview. Do not put it in source code." },
  { id: "github-secrets", title: "Add private deployment secrets", detail: "Save CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and LANCERLOGIN_SETUP_CODE in the private repository’s production environment." },
  { id: "provision", title: "Run Install or upgrade LancerLogin", detail: "Choose a reviewed public release tag and review the generated resource names before creation." },
]);

export function setupProgress(state = {}) {
  return cloudflareSetupSteps.map((step) => ({ ...step, complete: state[step.id] === true }));
}

export function previewProvision(input) {
  try { return { ok: true, ...validateProvisionPlan({ ...input, operation: "create", confirmation: `CREATE ${input.installationSlug}` }) }; }
  catch (error) { return { ok: false, message: error.message }; }
}

export function renderCloudflareSetup({ state = {}, installationSlug = "" }) {
  const steps = setupProgress(state).map((step) => `<li data-complete="${step.complete}"><strong>${step.complete ? "✓" : "○"} ${step.title}</strong><p>${step.detail}</p>${step.href ? `<a href="${step.href}" target="_blank" rel="noreferrer">Open ${step.title}</a>` : ""}</li>`).join("");
  const preview = previewProvision({ installationSlug });
  const preflight = preview.ok ? `<p role="status">Create preview ready. Planned resources: ${preview.plannedResources.join(", ")}.</p>` : `<p role="alert">${preview.message}</p>`;
  return `<section aria-labelledby="cloudflare-heading"><h2 id="cloudflare-heading">Connect Cloudflare</h2><p>LancerLogin deploys only to your organization’s selected account. This screen never asks for, sends, or stores your Account ID or API token.</p><ol>${steps}</ol><label for="installation-slug">Installation slug</label><input id="installation-slug" value="${escapeAttribute(installationSlug)}" autocomplete="off">${preflight}<a href="#cloudflare-help">Cloudflare setup help</a></section>`;
}

function escapeAttribute(value) { return String(value).replace(/[&"']/g, (character) => ({ "&": "&amp;", '"': "&quot;", "'": "&#39;" })[character]); }
