import { api, apiBaseUrl } from "./dashboard-api";
import { loadModuleNavigation } from "./module-navigation";

export type DashboardSession = { id: string; role: "admin" | "operator"; debugMode: boolean };

export async function loadDashboardSession(): Promise<DashboardSession | undefined> {
  try { return (await api<{ user: DashboardSession }>("/auth/session")).user; }
  catch { return undefined; }
}

// These are independent authenticated reads. Only the entry component that has
// verified setup and session may consume module access or mount protected pages.
// Promises belong to one entry mount, never a cross-session response cache.
export function startDashboardEntry<T>() {
  const setup = api<T>("/setup/status");
  const protectedEntry = Boolean(apiBaseUrl) && window.location.pathname !== "/submit-hours";
  return {
    setup,
    session: protectedEntry ? loadDashboardSession() : undefined,
    modules: protectedEntry ? loadModuleNavigation() : undefined,
  };
}
