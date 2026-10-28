import { api, apiBaseUrl, transientApiFailure } from "./dashboard-api";
import { installedDashboardModules } from "./installed-dashboard-modules";
import { resolveDashboardPublicPage } from "./module-contributions.ts";
import { loadModuleNavigation } from "./module-navigation";
import { normalizePath } from "./router";

export type DashboardSession = { id: string; role: "admin" | "operator"; debugMode: boolean };

/** The signed-in user, or undefined when signed out. A transient failure (network, rate limit, server error) rejects, so a valid session is not mistaken for a sign-out. */
export async function loadDashboardSession(): Promise<DashboardSession | undefined> {
  try { return (await api<{ user: DashboardSession }>("/auth/session")).user; }
  catch (error) { if (transientApiFailure(error)) throw error; return undefined; }
}

// These are independent authenticated reads. Only the entry component that has
// verified setup and session may consume module access or mount protected pages.
// Promises belong to one entry mount, never a cross-session response cache.
export function startDashboardEntry<T>() {
  const setup = api<T>("/setup/status");
  // A module's public page, at its base path or any path below it, never reads protected access.
  const protectedEntry = Boolean(apiBaseUrl) && !resolveDashboardPublicPage(installedDashboardModules, normalizePath(window.location.pathname));
  const session = protectedEntry ? loadDashboardSession() : undefined;
  // The entry may be discarded unconsumed (first setup, public pages); its consumer still sees the rejection.
  session?.catch(() => undefined);
  return {
    setup,
    session,
    modules: protectedEntry ? loadModuleNavigation() : undefined,
  };
}
