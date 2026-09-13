import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveDocumentationProxyKey,createDocumentationAssertion,verifyDocumentationAssertion,DOCUMENTATION_ASSERTION_HEADER,readDocumentationProxyBody} from '../packages/shared/src/documentation-proxy.ts';
import {deriveHoursProxyKey,createHoursAssertion,verifyHoursAssertion,HOURS_ASSERTION_HEADER,readHoursProxyBody} from '../packages/shared/src/hours-proxy.ts';
import {buildPagesProxy} from '../scripts/prepare-pages-proxy.mjs';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',pages='https://fixture.pages.dev',api='https://fixture.workers.dev',now=100000,body=new TextEncoder().encode('{"text":"synthetic"}');
test('Documentation transport key is shared but signatures, path, query and limits remain purpose bound',async()=>{
 const key=await deriveDocumentationProxyKey(secret,'primary',pages,api);assert.equal(key,await deriveHoursProxyKey(secret,'primary',pages,api));
 const request=new Request(api+'/public/documentation/notes?q=one',{method:'POST'}),hours=new Request(api+'/public/hours/entries?q=one',{method:'POST'});
 const docSig=await createDocumentationAssertion(request,key,pages,api,'192.0.2.1',body,now),hourSig=await createHoursAssertion(hours,key,pages,api,'192.0.2.1',body,now);
 request.headers.set(DOCUMENTATION_ASSERTION_HEADER,docSig);assert.ok(await verifyDocumentationAssertion(request,secret,'primary',pages,body,now));
 request.headers.set(DOCUMENTATION_ASSERTION_HEADER,hourSig);assert.equal(await verifyDocumentationAssertion(request,secret,'primary',pages,body,now),null);
 hours.headers.set(HOURS_ASSERTION_HEADER,docSig);assert.equal(await verifyHoursAssertion(hours,secret,'primary',pages,body,now),null);
 // Same exact Documentation payload/path/body with only the wrong signature purpose.
 const payload=docSig.split('.')[0],rawKey=Uint8Array.from(atob(key.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
 const hmac=await crypto.subtle.importKey('raw',rawKey,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const wrongBytes=new Uint8Array(await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(JSON.stringify(['lancerlogin-hours-assertion',payload]))));
 const wrongPurpose=payload+'.'+btoa(String.fromCharCode(...wrongBytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 request.headers.set(DOCUMENTATION_ASSERTION_HEADER,wrongPurpose);assert.equal(await verifyDocumentationAssertion(request,secret,'primary',pages,body,now),null);
 request.headers.set(DOCUMENTATION_ASSERTION_HEADER,docSig);
 for(const target of ['/public/documentation/notes?q=two','/public/documentation/activities?q=one','/public/hours/notes?q=one'])assert.equal(await verifyDocumentationAssertion(new Request(api+target,request),secret,'primary',pages,body,now),null);
 assert.equal(await verifyDocumentationAssertion(request,secret,'primary',pages,new Uint8Array([1]),now),null);
 assert.equal(await verifyDocumentationAssertion(request,secret,'primary',pages,body,now+30001),null);
 await assert.rejects(()=>createHoursAssertion(request,key,pages,api,'192.0.2.1',body,now));
 const large='x'.repeat(24000),jsonRequest=v=>new Request(api+'/public/documentation/notes',{method:'POST',headers:{'content-type':'application/json'},body:v});
 assert.equal((await readDocumentationProxyBody(jsonRequest(large))).length,24000);await assert.rejects(()=>readHoursProxyBody(jsonRequest(large)),e=>e.status===413);await assert.rejects(()=>readDocumentationProxyBody(jsonRequest('x'.repeat(40001))),e=>e.status===413);
});
test('Pages Documentation transport strips spoofed assertions and uses restrictive unknown ingress',async()=>{
 const source=buildPagesProxy(api),module=await import('data:text/javascript,'+encodeURIComponent(source)),prior=globalThis.fetch;let forwarded;
 globalThis.fetch=async r=>{forwarded=r;return new Response('ok',{headers:{[DOCUMENTATION_ASSERTION_HEADER]:'never-return'}});};
 try{const request=new Request(pages+'/api/public/documentation/notes',{method:'POST',headers:{origin:pages,'content-type':'application/json',[DOCUMENTATION_ASSERTION_HEADER]:'spoof',[HOURS_ASSERTION_HEADER]:'spoof'},body:'{}'});
 const response=await module.default.fetch(request,{HOURS_PROXY_KEY:await deriveHoursProxyKey(secret,'primary',pages,api)});assert.equal(response.status,200);assert.equal(forwarded.headers.get(DOCUMENTATION_ASSERTION_HEADER),null);assert.equal(forwarded.headers.get(HOURS_ASSERTION_HEADER),null);assert.equal(response.headers.get(DOCUMENTATION_ASSERTION_HEADER),null);
 assert.equal((await module.default.fetch(new Request(pages+'/api/public/documentation/notes',{method:'POST',headers:{origin:'https://foreign.test','content-type':'application/json'},body:'{}'}),{})).status,403);
 }finally{globalThis.fetch=prior;}
});
