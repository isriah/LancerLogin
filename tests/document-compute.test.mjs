import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {documentComputeProof} from '../apps/api/src/document-compute-proof.ts';
import {DOCUMENT_COMPUTE_CONFIG,documentComputeApproval,documentComputeManifest,computeServiceConfig,inspectDocumentCompute,inspectComputeIngress,prepareHostedComputeProof,prepareDocumentCompute,verifyDocumentComputeBundle} from '../scripts/document-compute-config.mjs';
import {buildDevelopmentConfig} from '../scripts/development-bundle.mjs';
const confirmation={confirmation:'RUN FIXED SYNTHETIC DOCUMENT COMPUTE'};
test('current Admin, exact development mode and bounded allowlisted proof forwarding',async()=>{
 let active=true,calls=0;const actor={userId:'admin',expiresAt:Date.now()+60000};const env={ALLOWED_ORIGIN:'https://lancerlogin-v2-example-dashboard.pages.dev',DOCUMENT_COMPUTE_PROOF_MODE:'synthetic',DB:{prepare:()=>({bind:()=>({first:async()=>active?{id:'admin'}:null})})},DOCUMENT_COMPUTE:{fetch:async()=>{calls++;return Response.json({id:'proof-png-v1',state:'queued',attempts:0,private:'not forwarded'});}}};
 const req=()=>new Request('https://app/admin/document-compute/proofs/png-v1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(confirmation)});
 assert.deepEqual(await(await documentComputeProof(req(),env,actor)).json(),{id:'proof-png-v1',state:'queued',attempts:0});
 for(const patch of [{ALLOWED_ORIGIN:'https://production.invalid'},{DOCUMENT_COMPUTE_PROOF_MODE:undefined},{DOCUMENT_COMPUTE:undefined}])await assert.rejects(()=>documentComputeProof(req(),{...env,...patch},actor),e=>e.status===404);
 active=false;await assert.rejects(()=>documentComputeProof(req(),env,actor),e=>e.status===403);active=true;
 env.DOCUMENT_COMPUTE.fetch=async()=>{active=false;return Response.json({id:'proof-png-v1',state:'queued',attempts:0});};await assert.rejects(()=>documentComputeProof(req(),env,actor),e=>e.status===403);assert.equal(calls,1);
});
test('optional approved compute identity is pinned, preserved, private and never silently stripped',async()=>{
 const approved={...DOCUMENT_COMPUTE_CONFIG,namespaceId:'a'.repeat(32),proofMode:'synthetic'},identity={documentCompute:approved};assert.equal(documentComputeApproval(identity),approved);
 for(const patch of [{namespaceId:null},{worker:'production'},{proofMode:'arbitrary'}])assert.throws(()=>documentComputeApproval({documentCompute:{...approved,...patch}}));assert.throws(()=>documentComputeManifest(identity,{}));
 const config=computeServiceConfig('./compute.mjs','b'.repeat(32));assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);assert.deepEqual(config.vars,{});assert.equal(config.limits.cpu_ms,30000);
 const core=buildDevelopmentConfig({...identity,resources:[{name:'lancerlogin-v2-example-data',id:'synthetic'}]},{documentCompute:approved},'.provision/fixture');assert.deepEqual(core.services,[{binding:'DOCUMENT_COMPUTE',service:approved.worker}]);assert.equal(core.vars.DOCUMENT_COMPUTE_PROOF_MODE,'synthetic');
 await assert.rejects(()=>inspectDocumentCompute(()=>{}, {},[{name:'DOCUMENT_COMPUTE',type:'service'}],[]),/refusing/);
 const namespace={id:approved.namespaceId,script:approved.worker,class:approved.className,use_sqlite:true};const bindings=[{name:'DOCUMENT_COMPUTE_QUEUE',type:'durable_object_namespace',class_name:approved.className,namespace_id:approved.namespaceId},{name:'DOCUMENT_COMPUTE_PROOF_MODE',type:'plain_text',text:'synthetic'}];
 const api=async p=>p.endsWith('/settings')?{bindings,limits:{cpu_ms:30000}}:p.endsWith('/subdomain')?{enabled:false,previews_enabled:false}:{default_environment:{script:{id:approved.worker,migration_tag:approved.migrationTag}}};await inspectDocumentCompute(api,identity,[],[namespace]);
 bindings.push({name:'SESSION_KEY',type:'secret_text'});await assert.rejects(()=>inspectDocumentCompute(api,identity,[],[namespace]),/secrets/);
});
test('proof adapter rejects malformed bodies/results and never repeats uncertain writes',async()=>{
 let calls=0;const actor={userId:'admin',expiresAt:Date.now()+60000};const env={ALLOWED_ORIGIN:'https://lancerlogin-v2-example-dashboard.pages.dev',DOCUMENT_COMPUTE_PROOF_MODE:'synthetic',DB:{prepare:()=>({bind:()=>({first:async()=>({id:'admin'})})})},DOCUMENT_COMPUTE:{fetch:async()=>{calls++;throw Error('synthetic uncertain result');}}};
 const req=body=>new Request('https://app/admin/document-compute/proofs/png-v1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 await assert.rejects(()=>documentComputeProof(req({...confirmation,bytes:'forbidden'}),env,actor),e=>e.status===400);assert.equal(calls,0);
 await assert.rejects(()=>documentComputeProof(req(confirmation),env,actor),e=>e.status===503);assert.equal(calls,1);
 env.DOCUMENT_COMPUTE.fetch=async()=>Response.json({id:'proof-other',state:'complete',attempts:1});await assert.rejects(()=>documentComputeProof(req(confirmation),env,actor),e=>e.status===503);
 env.DOCUMENT_COMPUTE.fetch=async()=>new Response('x'.repeat(8193));await assert.rejects(()=>documentComputeProof(req(confirmation),env,actor),e=>e.status===503);
});
test('hosted proof preparation requires complete fresh private route/domain inventory',async()=>{
 const accountId='a'.repeat(32),zoneId='b'.repeat(32),identity={accountId,documentCompute:{...DOCUMENT_COMPUTE_CONFIG,namespaceId:'c'.repeat(32),proofMode:'synthetic'}};
 const envelope=result=>({success:true,result,result_info:{page:1,per_page:100,total_count:result.length,count:result.length}});
 let domains=[],routes=[];const read=async path=>path.includes('/workers/domains')?envelope(domains):path.startsWith('/zones?')?envelope([{id:zoneId,account:{id:accountId}}]):{success:true,result:routes};
 assert.equal((await prepareHostedComputeProof(read,identity,'cpu-fault-v1')).evidence.privateIngress,true);
 domains=[{service:DOCUMENT_COMPUTE_CONFIG.worker}];await assert.rejects(()=>inspectComputeIngress(read,accountId),/domain/);domains=[];
 routes=[{id:'route',script:DOCUMENT_COMPUTE_CONFIG.worker}];await assert.rejects(()=>inspectComputeIngress(read,accountId),/route/);
 await assert.rejects(()=>inspectComputeIngress(async()=>({success:true,result:[]}),accountId),/Incomplete/);
});
test('uncertain proof deadline aborts once without retry',async()=>{
 let aborted=false,calls=0;const env={ALLOWED_ORIGIN:'https://lancerlogin-v2-example-dashboard.pages.dev',DOCUMENT_COMPUTE_PROOF_MODE:'synthetic',DB:{prepare:()=>({bind:()=>({first:async()=>({id:'admin'})})})},DOCUMENT_COMPUTE:{fetch:req=>{calls++;req.signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});}}};
 await assert.rejects(()=>documentComputeProof(new Request('https://app/admin/document-compute/proofs/png-v1'),env,{userId:'admin',expiresAt:Date.now()+60000}),e=>e.status===503);assert.equal(aborted,true);assert.equal(calls,1);
});
test('local reviewed compute bundle refuses overwrite and altered artifacts',async t=>{
 await mkdir('.provision',{recursive:true});const root=await mkdtemp(resolve('.provision/compute-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'source.mjs');await writeFile(source,'export default {fetch(){return new Response("synthetic")}}');
 const args={output:join(root,'bundle'),bundleFile:source,accountId:'a'.repeat(32),sourceCommit:'b'.repeat(40),proofMode:'synthetic'};const prepared=await prepareDocumentCompute(args);
 assert.equal(prepared.approval,false);const check={directory:args.output,digest:prepared.manifestSha256,accountId:args.accountId,proofMode:args.proofMode};await verifyDocumentComputeBundle(check);await assert.rejects(()=>prepareDocumentCompute(args));
 await writeFile(join(args.output,'compute.mjs'),'altered');await assert.rejects(()=>verifyDocumentComputeBundle(check),/changed/);
});
