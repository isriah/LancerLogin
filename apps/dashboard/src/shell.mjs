import { can } from "../../../packages/shared/src/policy.mjs";

const baseNavigation = [
  ["Dashboard", "view-dashboard"], ["Reports", "view-reports"], ["Roster", "view-roster"], ["Kiosks", "view-kiosk-status"],
];
const adminNavigation = [["Settings", "manage-security"]];
const steps = [
  ["branding", "Set organization branding"], ["roster", "Add your roster"],
  ["pair-kiosk", "Pair hardware or simulator"], ["fingerprint-test", "Test kiosk input"], ["confirm-attendance", "Confirm attendance"],
];

export function navigationFor(role) {
  return [...baseNavigation, ...adminNavigation]
    .filter(([, capability]) => can(role, capability))
    .map(([label]) => label);
}

export function checklistFor(completed = []) {
  const complete = new Set(completed);
  return steps.map(([id, label]) => ({ id, label, complete: complete.has(id) }));
}

export function renderDashboard({ role, branding, completedSteps = [], checklistVisible = true }) {
  const navigation = navigationFor(role).map((label) => `<a href="#${label.toLowerCase()}" class="nav-link">${label}</a>`).join("");
  const checklist = checklistFor(completedSteps).map(({ id, label, complete }) =>
    `<li><a href="#setup-${id}" ${complete ? 'aria-label="Completed: ' : 'aria-label="Incomplete: '}${label}">${complete ? "✓" : "○"} ${label}</a></li>`).join("");
  const setup = checklistVisible ? `<section aria-labelledby="setup-heading"><h2 id="setup-heading">Setup checklist</h2><p>Shared across all administrators. Complete it in any order.</p><ol>${checklist}</ol></section>` :
    `<a href="#setup" aria-label="Open completed setup checklist">Setup and help</a>`;
  return `<!doctype html><html lang="en" data-theme="${branding.appearance}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(branding.organizationName)} | LancerLogin</title></head><body style="--primary:${escapeHtml(branding.primaryColor)};--secondary:${escapeHtml(branding.secondaryColor)}"><a href="#main" class="skip-link">Skip to main content</a><header><h1>${escapeHtml(branding.organizationName)}</h1>${branding.subtitle ? `<p>${escapeHtml(branding.subtitle)}</p>` : ""}<nav aria-label="Primary">${navigation}</nav></header><main id="main" tabindex="-1"><p>Signed in as ${escapeHtml(role)}.</p>${setup}</main></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
