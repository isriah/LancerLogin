import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveUploadProxyKey,createUploadAssertion,verifyUploadAssertion,UPLOAD_ASSERTION_HEADER,readUploadProxyBody} from '../packages/shared/src/upload-proxy.ts';
import {createDocumentationAssertion,DOCUMENTATION_ASSERTION_HEADER} from '../packages/shared/src/documentation-proxy.ts';
import {buildPagesProxy} from '../scripts/prepare-pages-proxy.mjs';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',pages='https://fixture.pages.dev',api='https://fixture.workers.dev';
test('binary upload proxy preserves bounded bytes and isolated signature purpose',async()=>{
 const key=await deriveUploadProxyKey(secret,'primary',pages,api),body=new Uint8Array(262144),now=Date.now();
 const req=new Request(api+'/public/documentation/uploads/op/chunks/0',{method:'PUT'});req.headers.set(UPLOAD_ASSERTION_HEADER,await createUploadAssertion(req,key,pages,api,'192.0.2.1',body,now));assert.ok(await verifyUploadAssertion(req,secret,'primary',pages,body,now));
 const other=new Request(api+'/public/documentation/uploads/op/chunks/1',req);assert.equal(await verifyUploadAssertion(other,secret,'primary',pages,body,now),null);
 const post=new Request(api+'/public/documentation/uploads',{method:'POST'}),small=new TextEncoder().encode('{}');post.headers.set(UPLOAD_ASSERTION_HEADER,await createDocumentationAssertion(post,key,pages,api,'192.0.2.1',small,now));assert.equal(await verifyUploadAssertion(post,secret,'primary',pages,small,now),null);
 const built=await import('data:text/javascript,'+encodeURIComponent(buildPagesProxy(api))),prior=globalThis.fetch;let forwarded;
 globalThis.fetch=async r=>{forwarded=r;return new Response('ok');};try{
 const request=new Request(pages+'/api/public/documentation/uploads/op/chunks/0',{method:'PUT',headers:{origin:pages,'content-type':'application/octet-stream',[UPLOAD_ASSERTION_HEADER]:'forged',[DOCUMENTATION_ASSERTION_HEADER]:'forged'},body});Object.defineProperty(request,'cf',{value:{country:'US'}});request.headers.set('cf-connecting-ip','192.0.2.1');assert.equal((await built.default.fetch(request,{HOURS_PROXY_KEY:key})).status,200);const received=new Uint8Array(await forwarded.arrayBuffer());assert.deepEqual(received,body);assert.ok(await verifyUploadAssertion(forwarded,secret,'primary',pages,received));assert.equal(forwarded.headers.get(DOCUMENTATION_ASSERTION_HEADER),null);
 const make=(n,origin=pages)=>new Request(pages+'/api/public/documentation/uploads/op/chunks/0',{method:'PUT',headers:{origin,'content-type':'application/octet-stream'},body:new Uint8Array(n)});
 assert.equal((await built.default.fetch(make(1,'https://foreign.test'),{})).status,403);assert.equal((await built.default.fetch(make(262145),{})).status,413);
 let cancelled=false;const slow=new Request(api+'/public/documentation/uploads/op/chunks/0',{method:'PUT',headers:{'content-type':'application/octet-stream'},body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'});await assert.rejects(()=>readUploadProxyBody(slow,5),e=>e.status===408);assert.equal(cancelled,true);
 }finally{globalThis.fetch=prior;}
});
