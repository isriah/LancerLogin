import { sha256 } from '../../../packages/shared/src/updater/application-release.mjs';
import { readDashboard } from '../../../packages/shared/src/updater/dashboard-archive.mjs';
import { selectSnapshotCatalog } from './snapshot-catalog-registry.mjs';
const check=(value,code='bootstrap-preflight')=>{if(!value)throw Error(code);};
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const same=(a,b)=>canonical(a)===canonical(b),hash=value=>sha256(new TextEncoder().encode(canonical(value)));
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const order=items=>[...items].sort((a,b)=>a.name.localeCompare(b.name));
const settingsKeys=['compatibility_date','compatibility_flags','usage_model','logpush','tail_consumers','observability','placement','limits','tags'];
const schemaSql="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE (name NOT GLOB 'sqlite_*' OR type='index' OR name='sqlite_sequence') AND name NOT IN ('_cf_KV','_cf_METADATA') AND tbl_name NOT IN ('_cf_KV','_cf_METADATA') ORDER BY type,name LIMIT 512";
export function bootstrapPagesConfiguration(value){
 check(value&&typeof value==='object'&&!Array.isArray(value));const allowed=['compatibility_date','compatibility_flags','env_vars','d1_databases','durable_object_namespaces','kv_namespaces','r2_buckets','services','analytics_engine_datasets','ai_bindings','vectorize_bindings','hyperdrive_bindings','placement','usage_model','build_image_major_version'];check(Object.keys(value).every(k=>allowed.includes(k)),'bootstrap-pages-config');const result=structuredClone(value);
 if(result.env_vars){for(const [name,item]of Object.entries(result.env_vars)){check(item&&['plain_text','secret_text'].includes(item.type));result.env_vars[name]=item.type==='secret_text'?{type:item.type}:{type:item.type,value:item.value};}}
 return result;
}
export function createBootstrapPreflight({pins:input,database,store,verifier,token,fetch:fetcher=globalThis.fetch}){
 const pins=structuredClone(input),key='runtime-bootstrap-preflight',base=`https://api.cloudflare.com/client/v4/accounts/${pins.accountId}`,worker=`${base}/workers/scripts/${pins.worker}`,pages=`${base}/pages/projects/${pins.pagesProject}`;
 const primary=()=>database.withSession?database.withSession('first-primary'):database;
 async function identity(release,adoption){
  check(adoption&&Object.keys(adoption).sort().join(',')===['contract','recordSha256','installationId','accountId','applicationDatabaseId','worker','pagesProject','productionBranch','apiDeploymentId','apiVersionId','pagesDeploymentId','pagesWorkerSha256','secretBindings','pagesConfigurationSha256'].sort().join(','));
  check(adoption.contract==='exclusive-installed-release-adoption-v1'&&['recordSha256','pagesWorkerSha256','pagesConfigurationSha256'].every(k=>hex(adoption[k])));
  for(const k of ['installationId','accountId','applicationDatabaseId','worker','pagesProject','productionBranch'])check(adoption[k]===pins[k]);
  for(const k of ['apiDeploymentId','apiVersionId','pagesDeploymentId'])check(typeof adoption[k]==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(adoption[k]));
  check(Array.isArray(adoption.secretBindings)&&adoption.secretBindings.length<=64&&new Set(adoption.secretBindings.map(x=>x.name)).size===adoption.secretBindings.length);
  for(const binding of adoption.secretBindings)check(Object.keys(binding).sort().join(',')==='name,type'&&typeof binding.name==='string'&&['secret_text','secret_key'].includes(binding.type));
  const catalog=selectSnapshotCatalog(`schema-${release.manifest.targetSchema}-v1`).catalog;check([46,49].includes(catalog.schema)&&same(release.manifest.migrations.map(({id,sha256})=>({id,sha256})),catalog.ledger));
  return hash({pins,adoption,manifestSha256:release.manifestSha256,catalogSha256:await sha256(new TextEncoder().encode(JSON.stringify(catalog)))});
 }
 async function schema(release){const catalog=selectSnapshotCatalog(`schema-${release.manifest.targetSchema}-v1`).catalog,db=primary();check(same((await db.prepare(schemaSql).all()).results,catalog.objects),'bootstrap-schema');check(same((await db.prepare('SELECT name FROM d1_migrations ORDER BY id LIMIT 255').all()).results.map(row=>row.name),catalog.ledger.map(row=>row.id)),'bootstrap-ledger');}
 async function bytes(url,limit,provider=true){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const response=await fetcher(url,{method:'GET',redirect:'manual',cache:'no-store',signal:controller.signal,headers:provider?{Authorization:`Bearer ${token}`,'Cache-Control':'no-cache'}:{'Cache-Control':'no-cache'}});check(response.ok&&response.body,'bootstrap-provider');const reader=response.body.getReader(),chunks=[];let size=0;for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit){await reader.cancel();throw Error('bootstrap-size');}chunks.push(part.value);}const output=new Uint8Array(size);let at=0;for(const chunk of chunks){output.set(chunk,at);at+=chunk.length;}return {bytes:output,headers:response.headers};}finally{clearTimeout(timer);controller.abort();}}
 async function api(url){const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode((await bytes(url,262144)).bytes));check(value.success===true&&value.result,'bootstrap-provider');return value.result;}
 async function current(release,adoption){
  const deployment=(await api(worker+'/deployments')).deployments?.[0];check(deployment?.id===adoption.apiDeploymentId&&deployment.versions?.length===1&&deployment.versions[0].version_id===adoption.apiVersionId&&deployment.versions[0].percentage===100,'bootstrap-deployment');
  const settings=await api(worker+'/settings');check(Array.isArray(settings.bindings),'bootstrap-settings');const secrets=settings.bindings.filter(x=>['secret_text','secret_key'].includes(x.type)).map(({name,type})=>({name,type})),nonsecret=settings.bindings.filter(x=>!['secret_text','secret_key'].includes(x.type));
  check(same(order(secrets),order(adoption.secretBindings))&&same(order(nonsecret),order(pins.nonsecretBindings.map(x=>x.name==='RELEASE_VERSION'?{...x,text:release.manifest.version}:x))),'bootstrap-bindings');for(const k of settingsKeys)check(Object.hasOwn(settings,k)===Object.hasOwn(pins.workerSettings,k)&&(!Object.hasOwn(settings,k)||same(settings[k],pins.workerSettings[k])),'bootstrap-settings');
  const project=await api(pages),active=project.canonical_deployment,metadata=active?.deployment_trigger?.metadata;check(project.name===pins.pagesProject&&project.production_branch===pins.productionBranch&&!project.source&&active?.id===adoption.pagesDeploymentId&&active.environment==='production'&&active.latest_stage?.name==='deploy'&&active.latest_stage.status==='success'&&metadata?.branch===pins.productionBranch&&metadata.commit_hash===release.manifest.sourceCommit&&typeof metadata.commit_message==='string'&&metadata.commit_message.endsWith(' '+release.manifestSha256),'bootstrap-pages');check(await hash(bootstrapPagesConfiguration(project.deployment_configs?.production))===adoption.pagesConfigurationSha256,'bootstrap-pages-config');
 }
 async function guard(release,adoption){const digest=await identity(release,adoption),row=await store.operation(key);check(row?.value.phase==='ready'&&row.value.identity===digest,'bootstrap-preparation');await schema(release);await current(release,adoption);return digest;}
 return Object.freeze({identity,guard,async advance(release,adoption){
  const digest=await identity(release,adoption);let row=await store.operation(key);
  if(!row){await schema(release);await store.claim(key,{identity:digest,phase:'api'});return {outcome:'pending'};}check(row.value.identity===digest,'bootstrap-identity');const next=structuredClone(row.value);
  if(next.phase==='api'){await current(release,adoption);check((await api(worker+'/versions/'+adoption.apiVersionId)).id===adoption.apiVersionId,'bootstrap-version');const content=await bytes(worker+'/content/v2',17825792);let value=content.bytes;if(content.headers.get('content-type')?.startsWith('multipart/')){const parts=[...(await new Response(value,{headers:content.headers}).formData()).values()];check(parts.length===1&&typeof parts[0]!=='string','bootstrap-modules');value=new Uint8Array(await parts[0].arrayBuffer());}const descriptor=release.manifest.artifacts.find(x=>x.role==='api');await verifier.verifyArtifact(release,descriptor.name,value);await current(release,adoption);next.phase='archive';next.index=0;}
  else if(next.phase==='archive'){
   const descriptor=release.manifest.artifacts.find(x=>x.role==='dashboard'),archive=await verifier.verifyArtifact(release,descriptor.name,await store.read(`${release.manifestSha256}:${descriptor.name}`)),files=readDashboard(archive),pageWorker=files.find(x=>x.path==='_worker.js');
   check(pageWorker&&await sha256(pageWorker.bytes)===adoption.pagesWorkerSha256,'bootstrap-worker-provenance');
   const entries=await Promise.all(files.filter(x=>!['_worker.js','_routes.json','_headers','_redirects'].includes(x.path)).map(async file=>({path:file.path,bytes:file.bytes.length,sha256:await sha256(file.bytes)})));
   // At most eight encrypted pages of 256 authenticated descriptors, each <64KiB.
   for(let start=0;start<entries.length;start+=256){const pageKey=`runtime-bootstrap-assets:${start/256}`,value={identity:digest,entries:entries.slice(start,start+256)};check(new TextEncoder().encode(JSON.stringify(value)).length<=65536,'bootstrap-index-size');if(!await store.claim(pageKey,value))check(same((await store.operation(pageKey))?.value,value),'bootstrap-index-conflict');}
   next.phase='assets';next.count=entries.length;
  }
  else if(next.phase==='assets'){
   if(next.index<next.count){const page=await store.operation(`runtime-bootstrap-assets:${Math.floor(next.index/256)}`);check(page?.value.identity===digest,'bootstrap-index');const file=page.value.entries[next.index%256];check(file,'bootstrap-index');const result=await bytes(pins.dashboardOrigin+(file.path==='index.html'?'/':'/'+file.path),file.bytes+1,false);check(result.bytes.length===file.bytes&&await sha256(result.bytes)===file.sha256,'bootstrap-asset');next.index++;}
   if(next.index===next.count)next.phase='ready';
  }
  else{check(next.phase==='ready');return {outcome:'ready'};}
  check(await store.replace(key,row.revision,next),'bootstrap-conflict');return {outcome:'pending'};
 }});
}
