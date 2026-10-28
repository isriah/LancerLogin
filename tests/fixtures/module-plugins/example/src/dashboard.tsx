// Synthetic dashboard contribution. It imports only the SDK; React comes from the composed dashboard.
import type { DashboardModuleContribution, DashboardPublicPageContext, DashboardSetupProps } from "@lancerlogin/module-sdk/dashboard";

function ExampleWorkspace() {
  return <section className="ui-card" aria-labelledby="example-title"><h1 id="example-title">Example</h1><p>Synthetic plugin workspace.</p></section>;
}

function ExampleSettings() {
  return <section className="ui-card" aria-labelledby="example-settings-title"><h1 id="example-settings-title">Example settings</h1></section>;
}

function ExampleSetup({ module }: DashboardSetupProps) {
  return <section className="ui-card" aria-labelledby="example-setup-title"><h1 id="example-setup-title">Set up {module.label}</h1><p>Add the first Example item to finish setup.</p></section>;
}

// A public page owns its base path and every path below it: the request page at /example-request and its status sub page.
function ExamplePublicRequest({ subpath }: DashboardPublicPageContext) {
  const title = subpath === "" ? "Request an Example item" : subpath === "status" ? "Example request status" : "Page unavailable";
  return <main id="dashboard-content"><section className="ui-card" aria-labelledby="example-public-title"><h1 id="example-public-title">{title}</h1></section></main>;
}

const dashboard: DashboardModuleContribution = {
  moduleId: "example",
  routes: [{ path: "/example", render: () => <ExampleWorkspace /> }],
  settingsPages: [{ path: "/settings/example", render: () => <ExampleSettings /> }],
  setup: ExampleSetup,
  publicPages: [{ path: "/example-request", skipLinkLabel: "Skip to Example request", render: (context) => <ExamplePublicRequest {...context} /> }],
};

export default dashboard;
