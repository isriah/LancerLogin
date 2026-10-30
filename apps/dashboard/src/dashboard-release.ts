import { api } from "./dashboard-api";
import { createCachedRead, isNewerRelease } from "./update-release";
import { compareReleaseVersions } from "../../../packages/shared/src/release-policy.mjs";

export type DashboardReleaseState = {
  worker: string;
  served: string;
  running: string;
  workflowUrl: string;
  converged: boolean;
  reloadAvailable: boolean;
};

const normalize = (value: string | undefined) => value?.replace(/^v/, "") ?? "";
export const sameStableVersion = (left: string, right: string) => compareReleaseVersions(left, right) === 0;
// The header check re-reads whenever the release check settles; one request serves those reads. Updates polls every 5 seconds, so each of its polls still reaches the server.
const readInstallation = createCachedRead(() => api<{ releaseVersion: string; workflowUrl?: string }>("/admin/update-info"), 3_000);

export async function readDashboardReleaseState(fetcher: typeof fetch = fetch): Promise<DashboardReleaseState> {
  const [installation, servedResponse] = await Promise.all([
    readInstallation(),
    fetcher("/__lancerlogin-release", { cache: "no-store", redirect: "error" }),
  ]);
  if (!servedResponse.ok) throw new Error("The dashboard deployment version is unavailable.");
  const servedBody = await servedResponse.json() as { releaseVersion?: unknown };
  const worker = normalize(installation.releaseVersion);
  const served = normalize(typeof servedBody.releaseVersion === "string" ? servedBody.releaseVersion : undefined);
  const running = normalize(__LANCERLOGIN_VERSION__);
  const converged = sameStableVersion(worker, served);
  return {
    worker,
    served,
    running,
    workflowUrl: installation.workflowUrl ?? "",
    converged,
    reloadAvailable: converged && isNewerRelease(served, running),
  };
}
