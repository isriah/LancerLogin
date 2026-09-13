import { parseStrictJson, createApplicationVerifier } from '../../packages/shared/src/updater/application-release.mjs';
const check=ok=>{if(!ok)throw Error('updater-configuration');};
const exact=(value,keys)=>check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(','));
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const decode=value=>{check(hex(value));return Uint8Array.from(value.match(/../g),x=>parseInt(x,16));};
const origin=value=>{const url=new URL(value);check(url.protocol==='https:'&&url.origin===value&&!url.username&&!url.password);};
export function updaterConfiguration(env){
  exact(env,['UPDATER_CONFIG','APPLICATION_DB','UPDATER_DB','VALIDATION_DB','CHECKPOINT_KEY','GITHUB_TOKEN','CLOUDFLARE_TOKEN','APP_HMAC','MAINTENANCE_HMAC','RECOVERY_CREDENTIAL_SHA256']);
  check(typeof env.UPDATER_CONFIG==='string');const bytes=new TextEncoder().encode(env.UPDATER_CONFIG);check(bytes.length>0&&bytes.length<=131072);
  const config=parseStrictJson(bytes);exact(config,['format','pins','trust',...(Object.hasOwn(config,'fencePolicy')?['fencePolicy']:[])]);check(config.format===1);
  const pins=config.pins;exact(pins,['installationId','accountId','worker','pagesProject','productionBranch','applicationDatabaseId','updaterDatabaseId','validationDatabaseId','workerSettings','nonsecretBindings','apiOrigin','dashboardOrigin','recoveryOrigin']);
  const ids=['applicationDatabaseId','updaterDatabaseId','validationDatabaseId'].map(key=>pins[key]);check(ids.every(id=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))&&new Set(ids).size===3);
  for(const key of ['apiOrigin','dashboardOrigin','recoveryOrigin'])origin(pins[key]);
  exact(config.trust,['product','channel','repository','keyId','publicKey']);const trust={...config.trust,publicKey:decode(config.trust.publicKey)};createApplicationVerifier(trust);
  const bindings={application:env.APPLICATION_DB,updater:env.UPDATER_DB,validation:env.VALIDATION_DB};check(new Set(Object.values(bindings)).size===3&&Object.values(bindings).every(db=>typeof db?.prepare==='function'&&typeof db?.batch==='function'));
  check(hex(env.APP_HMAC)&&hex(env.MAINTENANCE_HMAC)&&env.APP_HMAC!==env.MAINTENANCE_HMAC&&hex(env.RECOVERY_CREDENTIAL_SHA256));
  check([env.GITHUB_TOKEN,env.CLOUDFLARE_TOKEN].every(value=>typeof value==='string'&&value.length>=16&&value.length<=4096&&!/[\r\n]/.test(value)));
  if(config.fencePolicy!==undefined)exact(config.fencePolicy,['maintenanceService','secretBindings','adoption','coverage']);
  return {pins,trust,bindings,secrets:{checkpointKey:decode(env.CHECKPOINT_KEY),githubToken:env.GITHUB_TOKEN,cloudflareToken:env.CLOUDFLARE_TOKEN,appHmac:env.APP_HMAC,maintenanceHmac:env.MAINTENANCE_HMAC,recoveryCredentialSha256:env.RECOVERY_CREDENTIAL_SHA256},...(config.fencePolicy!==undefined?{fencePolicy:config.fencePolicy}:{})};
}
