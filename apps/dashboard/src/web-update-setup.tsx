import { useState } from "react";
import { credentialLinkKinds, dispatchSecretName, fixLinks, selectionSecretName, type CredentialStatus, type FixLink, type UpdateSetup } from "./web-update";

type Tone = "success" | "warning" | "error" | "neutral";
const formatDate = (value: string) => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

export const notSetUpTitle = "Dashboard updates are not set up yet";
export const manualUpgradeText = "This installation can still be updated: run the \"Install or upgrade LancerLogin\" workflow with operation \"upgrade\" in the private deployment repository.";
export const enableDashboardUpdatesText = `To update from this page instead, create a GitHub fine-grained token scoped to the deployment repository with Actions: Read and write, store it as the production environment secret ${dispatchSecretName}, then run the "Refresh web update credential" workflow.`;

export function FixLinks({ links, label }: { links: FixLink[]; label: string }) {
  if (!links.length) return null;
  return <ul className="update-fix-links" aria-label={label}>{links.map((link) => <li key={link.href}><a href={link.href} target="_blank" rel="noreferrer">{link.label}</a></li>)}</ul>;
}

/** Without WEB_UPDATE_TOKEN the installation is healthy; updates run from the deployment repository instead. */
export function DashboardUpdatesNotSetUp({ repository }: { repository: string | null }) {
  return <div className="update-not-set-up" role="group" aria-labelledby="update-not-set-up-title">
    <p id="update-not-set-up-title"><strong>{notSetUpTitle}</strong></p>
    <p>{manualUpgradeText}</p>
    <p>{enableDashboardUpdatesText}</p>
    <FixLinks label="Set up dashboard updates" links={fixLinks(["install", ...credentialLinkKinds], repository)} />
  </div>;
}

type Row = { id: string; label: string; badge: string; tone: Tone; detail: string; links: FixLink[] };
function credentialRow(id: string, label: string, status: CredentialStatus, secret: string, steps: string, missing: string, repository: string | null): Row {
  const expiry = status.expiresAt ? `Expires ${formatDate(status.expiresAt)}.` : "No expiry.";
  const renew = `Replace the production environment secret ${secret} with a new token, then run the "Refresh web update credential" workflow.`;
  const links = fixLinks(credentialLinkKinds, repository);
  switch (status.state) {
    case "ready": return { id, label, badge: "Ready", tone: "success", detail: expiry, links: [] };
    case "expiring": return { id, label, badge: "Expiring soon", tone: "warning", detail: `${expiry} ${renew}`, links };
    case "expired": return { id, label, badge: "Expired", tone: "error", detail: `${status.expiresAt ? `Expired ${formatDate(status.expiresAt)}. ` : ""}${steps}`, links };
    case "rejected": return { id, label, badge: "Rejected by GitHub", tone: "error", detail: `GitHub rejected ${secret}: it was revoked, regenerated or has expired. ${steps}`, links };
    default: return { id, label, badge: "Not set up", tone: "neutral", detail: missing, links };
  }
}
export function setupRows(setup: UpdateSetup): Row[] {
  const repository = setup.repository;
  const dispatchSteps = `Create a GitHub fine-grained token scoped to the deployment repository with Actions: Read and write, store it as the production environment secret ${dispatchSecretName}, then run the "Refresh web update credential" workflow.`;
  const selectionSteps = `Create a GitHub fine-grained token scoped to the deployment repository with Contents: Read and write, store it as the production environment secret ${selectionSecretName}, then run the "Refresh web update credential" workflow.`;
  const controllerLinks = fixLinks(["controller"], repository);
  const controller: Row = setup.controller === "current" ? { id: "controller", label: "Update controller workflow", badge: "Ready", tone: "success", detail: "upgrade-web.yml in the deployment repository supports stable and beta updates.", links: [] }
    : setup.controller === "upgrade_required" ? { id: "controller", label: "Update controller workflow", badge: "Update needed", tone: "warning", detail: "Stable updates work. Beta updates need the current controller: replace .github/workflows/upgrade-web.yml in the deployment repository with this release's version and commit it to main.", links: controllerLinks }
    : setup.controller === "missing" ? { id: "controller", label: "Update controller workflow", badge: "Missing", tone: "error", detail: "upgrade-web.yml is missing or disabled in the deployment repository, or the dashboard update credential cannot read it. Copy .github/workflows/upgrade-web.yml from this release's template, commit it to main and enable it.", links: controllerLinks }
    : { id: "controller", label: "Update controller workflow", badge: "Not checked", tone: "neutral", detail: "The controller is checked with the dashboard update credential once that credential is ready.", links: [] };
  return [
    credentialRow("dispatch", "Dashboard update credential", setup.dispatchCredential, dispatchSecretName, dispatchSteps, `Optional. ${manualUpgradeText} ${enableDashboardUpdatesText}`, repository),
    controller,
    credentialRow("selection", "Plugin management credential", setup.selectionCredential, selectionSecretName, selectionSteps, `Optional. Without it, edit lancerlogin.modules.json in the deployment repository to change plugins. To change plugins from Settings > Modules, ${selectionSteps.charAt(0).toLowerCase()}${selectionSteps.slice(1)}`, repository),
  ];
}

/** Settings > Updates: readiness of each piece dashboard updates depend on, with the fix for any that is not ready. */
export function UpdateSetupPanel({ setup }: { setup?: UpdateSetup }) {
  if (!setup) return null;
  return <section className="ui-card update-setup-card" aria-labelledby="update-setup-title">
    <div className="panel-heading"><h2 id="update-setup-title">Setup status</h2></div>
    <ul className="update-setup-list">{setupRows(setup).map((row) => <li key={row.id} className="update-setup-row" data-setup={row.id} aria-labelledby={`update-setup-${row.id}`}>
      <div className="update-setup-row-heading"><strong id={`update-setup-${row.id}`}>{row.label}</strong><span className="ui-status update-setup-badge" data-tone={row.tone}>{row.badge}</span></div>
      <p>{row.detail}</p>
      <FixLinks label={`Fix ${row.label.toLowerCase()}`} links={row.links} />
    </li>)}</ul>
  </section>;
}

const dismissalKey = "lancerlogin-update-credential-warning-dismissed";
function readDismissal(): string { try { return localStorage.getItem(dismissalKey) ?? ""; } catch { return ""; } }
/** A dismissible warning while the dashboard update credential expires within 14 days. Dismissal lasts until the expiry changes. */
export function CredentialExpiryBanner({ setup }: { setup?: UpdateSetup }) {
  const [dismissed, setDismissed] = useState(readDismissal);
  const credential = setup?.dispatchCredential;
  if (credential?.state !== "expiring" || !credential.expiresAt || dismissed === credential.expiresAt) return null;
  const expiresAt = credential.expiresAt;
  return <div className="ui-status settings-notice update-credential-banner" data-tone="warning">
    <p role="status">The dashboard update credential expires {formatDate(expiresAt)}. Before then, replace the production environment secret {dispatchSecretName} with a new token and run the "Refresh web update credential" workflow, or updates from this page will stop working.</p>
    <FixLinks label="Renew the dashboard update credential" links={fixLinks(credentialLinkKinds, setup!.repository)} />
    <button className="ui-button" type="button" aria-label="Dismiss credential expiry warning" onClick={() => { try { localStorage.setItem(dismissalKey, expiresAt); } catch { /* per-viewer convenience only */ } setDismissed(expiresAt); }}>Dismiss</button>
  </div>;
}
export const credentialExpiryNotice = (credential?: CredentialStatus) => credential?.state === "expiring" && credential.expiresAt ? `The dashboard update credential expires ${formatDate(credential.expiresAt)}. Renew it before then.` : "";
