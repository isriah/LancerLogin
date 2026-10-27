// Synthetic dashboard contribution. It imports only the SDK; React comes from the composed dashboard.
import type { DashboardModuleContribution, DashboardSetupProps } from "@lancerlogin/module-sdk/dashboard";

function ExampleWorkspace() {
  return <section className="ui-card" aria-labelledby="example-title"><h1 id="example-title">Example</h1><p>Synthetic plugin workspace.</p></section>;
}

function ExampleSettings() {
  return <section className="ui-card" aria-labelledby="example-settings-title"><h1 id="example-settings-title">Example settings</h1></section>;
}

function ExampleSetup({ module }: DashboardSetupProps) {
  return <section className="ui-card" aria-labelledby="example-setup-title"><h1 id="example-setup-title">Set up {module.label}</h1><p>Add the first Example item to finish setup.</p></section>;
}

const dashboard: DashboardModuleContribution = {
  moduleId: "example",
  routes: [{ path: "/example", render: () => <ExampleWorkspace /> }],
  settingsPages: [{ path: "/settings/example", render: () => <ExampleSettings /> }],
  setup: ExampleSetup,
};

export default dashboard;
