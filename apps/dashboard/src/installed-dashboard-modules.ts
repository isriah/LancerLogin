import { createModuleRegistry, firstPartyModules } from "../../../packages/shared/src/module-platform.ts";
import { externalModuleManifests } from "../../../packages/shared/src/generated/external-manifests.ts";
import { composeDashboardModules } from "./module-contributions.ts";
import { attendanceDashboardModule } from "./attendance-dashboard-module";
import { externalDashboardModules } from "./generated/external-modules.ts";

/** First-party dashboard contributions plus the installation's valid composed plugins, validated against the module registry. */
export const installedDashboardModules = composeDashboardModules({
  firstParty: firstPartyModules,
  firstPartyContributions: [attendanceDashboardModule],
  externalManifests: externalModuleManifests,
  externalContributions: externalDashboardModules,
  createRegistry: createModuleRegistry,
  report: (moduleId, error) => console.error(`Module ${moduleId} dashboard pages are unavailable: ${error instanceof Error ? error.message : "invalid contribution"}`),
});
