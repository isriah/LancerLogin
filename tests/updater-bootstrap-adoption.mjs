import { sha256 } from '../packages/shared/src/updater/application-release.mjs';
import { bootstrapPagesConfiguration } from '../apps/updater/src/bootstrap-preflight.mjs';
export const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export async function bootstrapAdoption(pins,{apiDeploymentId,apiVersionId,pagesDeploymentId,config,secretBindings=[]}){
 const {installationId,accountId,applicationDatabaseId,worker,pagesProject,productionBranch}=pins;
 return {contract:'exclusive-installed-release-adoption-v1',recordSha256:'b'.repeat(64),installationId,accountId,applicationDatabaseId,worker,pagesProject,productionBranch,apiDeploymentId,apiVersionId,pagesDeploymentId,secretBindings,pagesWorkerSha256:await sha256(new TextEncoder().encode('export default {}')),pagesConfigurationSha256:await sha256(new TextEncoder().encode(canonical(bootstrapPagesConfiguration(config))))};
}
