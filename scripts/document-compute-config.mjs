import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
export const DOCUMENT_COMPUTE_CONFIG=Object.freeze({worker:'lancerlogin-v2-example-document-compute',binding:'DOCUMENT_COMPUTE',className:'DocumentComputeQueue',migrationTag:'document-compute-v1'});
export function documentComputeApproval(identity){const v=identity.documentCompute;if(v===undefined)return null;
 if(!v||Object.keys(v).sort().join(',')!==[...Object.keys(DOCUMENT_COMPUTE_CONFIG),'namespaceId','proofMode'].sort().join(',')||Object.entries(DOCUMENT_COMPUTE_CONFIG).some(([k,x])=>v[k]!==x)||!/^[a-f0-9]{32}$/.test(v.namespaceId??'')||!['disabled','synthetic'].includes(v.proofMode))throw Error('Invalid document compute approval; independently captured namespace ID required');return v;}
export function documentComputeManifest(identity,manifest){const approved=documentComputeApproval(identity);if(JSON.stringify(manifest.documentCompute??null)!==JSON.stringify(approved))throw Error('Document compute artifact approval mismatch');return approved;}
export async function inspectDocumentCompute(api,identity,coreBindings,namespaces){const approved=documentComputeApproval(identity),bindings=coreBindings.filter(b=>b.name==='DOCUMENT_COMPUTE'),modes=coreBindings.filter(b=>b.name==='DOCUMENT_COMPUTE_PROOF_MODE');
 if(!approved){if(bindings.length||modes.length)throw Error('Document compute approval required; refusing binding removal');return;}
 if(bindings.length>1||bindings.some(b=>b.type!=='service'||b.service!==approved.worker||b.environment&&b.environment!=='production'||b.entrypoint)||modes.length>1||modes.some(b=>b.type!=='plain_text'||b.text!=='synthetic')||approved.proofMode==='disabled'&&modes.length)throw Error('Document compute API binding mismatch');
 const owned=namespaces.filter(n=>n.script===approved.worker);if(owned.length!==1||owned[0].id!==approved.namespaceId||owned[0].class!==approved.className||owned[0].use_sqlite!==true)throw Error('Document compute namespace capture mismatch');
 const settings=await api('workers/scripts/'+approved.worker+'/settings');const bs=settings?.bindings;
 if(settings?.limits?.cpu_ms!==30000)throw Error('Document compute CPU limit mismatch');
 if(!Array.isArray(bs)||bs.some(b=>!['DOCUMENT_COMPUTE_QUEUE','DOCUMENT_COMPUTE_PROOF_MODE'].includes(b.name)))throw Error('Document compute unexpected bindings or secrets');
 const q=bs.filter(b=>b.name==='DOCUMENT_COMPUTE_QUEUE'),p=bs.filter(b=>b.name==='DOCUMENT_COMPUTE_PROOF_MODE');
 if(q.length!==1||q[0].type!=='durable_object_namespace'||q[0].class_name!==approved.className||q[0].namespace_id!==approved.namespaceId||q[0].script_name&&q[0].script_name!==approved.worker||q[0].environment||p.length!==(approved.proofMode==='synthetic'?1:0)||p.some(b=>b.type!=='plain_text'||b.text!=='synthetic'))throw Error('Document compute service configuration mismatch');
 const service=await api('workers/services/'+approved.worker);if(service?.default_environment?.script?.id!==approved.worker||service.default_environment.script.migration_tag!==approved.migrationTag)throw Error('Document compute service migration mismatch');
 const domain=await api('workers/scripts/'+approved.worker+'/subdomain');if(domain?.enabled!==false||domain?.previews_enabled!==false)throw Error('Document compute public ingress must be disabled');
}
export function computeServiceConfig(main,accountId,proofMode='disabled'){
 if(!/^[a-f0-9]{32}$/.test(accountId)||!['disabled','synthetic'].includes(proofMode))throw Error('Invalid reviewed compute configuration');
 return {name:DOCUMENT_COMPUTE_CONFIG.worker,account_id:accountId,main,compatibility_date:'2026-09-04',workers_dev:false,preview_urls:false,limits:{cpu_ms:30000},
  durable_objects:{bindings:[{name:'DOCUMENT_COMPUTE_QUEUE',class_name:DOCUMENT_COMPUTE_CONFIG.className}]},migrations:[{tag:DOCUMENT_COMPUTE_CONFIG.migrationTag,new_sqlite_classes:[DOCUMENT_COMPUTE_CONFIG.className]}],
  vars:proofMode==='synthetic'?{DOCUMENT_COMPUTE_PROOF_MODE:'synthetic'}:{},routes:[],triggers:{crons:[]}};
}
// Purely local preparation. No provider client, dispatch, namespace capture or deployment.
export async function prepareDocumentCompute({output,bundleFile,accountId,sourceCommit,proofMode='disabled'}){
 const root=resolve('.provision'),target=resolve(output);if(!target.startsWith(root+'/')&&!target.startsWith(root+'\\'))throw Error('Preparation output must be inside .provision');if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('Invalid source commit');
 const bytes=await readFile(bundleFile),config=computeServiceConfig('./compute.mjs',accountId,proofMode);await mkdir(target);await writeFile(join(target,'compute.mjs'),bytes);const configBytes=JSON.stringify(config,null,2)+'\n';await writeFile(join(target,'wrangler.json'),configBytes);
 const hash=b=>createHash('sha256').update(b).digest('hex');const manifest={version:1,sourceCommit,resources:DOCUMENT_COMPUTE_CONFIG,proofMode,accountId,approval:false,files:[{path:'compute.mjs',sha256:hash(bytes)},{path:'wrangler.json',sha256:hash(configBytes)}]};const body=JSON.stringify(manifest,null,2)+'\n';await writeFile(join(target,'manifest.json'),body);return {manifestSha256:hash(body),approval:false};
}
export async function verifyDocumentComputeBundle({directory,digest,accountId,proofMode='disabled'}){
 const hash=b=>createHash('sha256').update(b).digest('hex'),raw=await readFile(join(directory,'manifest.json'));
 if(!/^[a-f0-9]{64}$/.test(digest??'')||hash(raw)!==digest)throw Error('Compute manifest digest mismatch');const m=JSON.parse(raw);
 if(m.version!==1||m.approval!==false||m.accountId!==accountId||m.proofMode!==proofMode||!/^[a-f0-9]{40}$/.test(m.sourceCommit??'')||JSON.stringify(m.resources)!==JSON.stringify(DOCUMENT_COMPUTE_CONFIG)||!Array.isArray(m.files)||m.files.length!==2||(await readdir(directory)).sort().join(',')!=='compute.mjs,manifest.json,wrangler.json')throw Error('Compute bundle approval mismatch');
 for(const [i,path]of ['compute.mjs','wrangler.json'].entries())if(m.files[i]?.path!==path||m.files[i].sha256!==hash(await readFile(join(directory,path))))throw Error('Compute artifact changed');
 const config=JSON.parse(await readFile(join(directory,'wrangler.json'),'utf8'));if(JSON.stringify(config)!==JSON.stringify(computeServiceConfig('./compute.mjs',accountId,proofMode)))throw Error('Compute configuration changed');return m;
}
// Read-only hosted prerequisite. Caller supplies an authorized Cloudflare GET adapter returning
// the complete {success,result,result_info} envelope; any missing permission fails closed.
export async function inspectComputeIngress(read,accountId){
 if(!/^[a-f0-9]{32}$/.test(accountId))throw Error('Invalid account');
 const list=async path=>{const values=[];let total;for(let page=1;page<=100;page++){
  const separator=path.includes('?')?'&':'?';const r=await read(path+separator+'page='+page+'&per_page=100');const info=r?.result_info;
  if(r?.success!==true||!Array.isArray(r.result)||!info||info.page!==page||info.per_page!==100||!Number.isInteger(info.total_count)||info.total_count<0||info.total_count>10000||info.count!==r.result.length||r.result.length!==Math.min(100,Math.max(0,info.total_count-(page-1)*100))||total!==undefined&&total!==info.total_count)throw Error('Incomplete document compute ingress inventory');
  total=info.total_count;values.push(...r.result);if(values.length===total)return values;
 }throw Error('Ingress inventory limit');};
 const domains=await list('/accounts/'+accountId+'/workers/domains');
 if(domains.some(d=>!d||typeof d.service!=='string'||d.service===DOCUMENT_COMPUTE_CONFIG.worker))throw Error('Document compute custom-domain ingress present or unverified');
 const zones=await list('/zones?account.id='+accountId);let routesChecked=0;
 for(const zone of zones){if(!zone||!/^[a-f0-9]{32}$/.test(zone.id??'')||zone.account?.id!==accountId)throw Error('Unverified account zone');
  const r=await read('/zones/'+zone.id+'/workers/routes');if(r?.success!==true||!Array.isArray(r.result)||r.result.some(route=>!route||typeof route.id!=='string'||!(route.script===null||typeof route.script==='string')||route.script===DOCUMENT_COMPUTE_CONFIG.worker))throw Error('Document compute route ingress present or unverified');routesChecked+=r.result.length;
 }
 return {accountId,worker:DOCUMENT_COMPUTE_CONFIG.worker,checkedAt:Date.now(),zonesChecked:zones.length,domainsChecked:domains.length,routesChecked,privateIngress:true};
}
export async function prepareHostedComputeProof(read,identity,caseId){
 const approved=documentComputeApproval(identity);if(!approved||approved.proofMode!=='synthetic'||!['png-v1','jpeg-v1','modern-pdf-v1','mixed-v1','recovery-v1','cpu-fault-v1','memory-fault-v1'].includes(caseId))throw Error('Synthetic proof approval required');
 const evidence=await inspectComputeIngress(read,identity.accountId);
 return {evidence,approval:false,method:'POST',path:'/admin/document-compute/proofs/'+caseId,body:{confirmation:'RUN FIXED SYNTHETIC DOCUMENT COMPUTE'}};
}
