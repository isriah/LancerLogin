import test from "node:test";
import assert from "node:assert/strict";
import { buildPagesProxy } from "../scripts/prepare-pages-proxy.mjs";

test("Pages proxy keeps dashboard authentication same-origin", async () => {
  const source = buildPagesProxy("https://example-club-api.example.workers.dev/");
  assert.match(source, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /env\.ASSETS\.fetch\(request\)/);
  assert.doesNotMatch(source, /cookie|authorization/i);
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  let upstream;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request) => { upstream = request; return new Response("ok", { headers: { "set-cookie": "session=opaque; Secure" } }); };
  try {
    const request = new Request("https://example-club-dashboard.pages.dev/api/auth/session?fresh=1", { headers: { cookie: "session=opaque", origin: "https://example-club-dashboard.pages.dev" } });
    const response = await module.default.fetch(request, { ASSETS: { fetch: () => new Response("asset") } });
    assert.equal(upstream.url, "https://example-club-api.example.workers.dev/auth/session?fresh=1");
    assert.equal(upstream.headers.get("cookie"), "session=opaque");
    assert.equal(response.headers.get("set-cookie"), "session=opaque; Secure");
  } finally { globalThis.fetch = originalFetch; }
});

test("Pages proxy rejects non-origin and non-HTTPS upstream values", () => {
  assert.throws(() => buildPagesProxy("http://api.example.test"), /HTTPS origin/);
  assert.throws(() => buildPagesProxy("https://api.example.test/path"), /HTTPS origin/);
  assert.throws(() => buildPagesProxy("https://user:secret@api.example.test/"), /HTTPS origin/);
});

test("Pages proxy serves the app shell for deep-link navigation", async () => {
  const source = buildPagesProxy("https://api.example.test");
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const requested = [];
  const response = await module.default.fetch(
    new Request("https://dashboard.example.test/settings/data", { headers: { accept: "text/html" } }),
    {
      ASSETS: {
        fetch(request) {
          requested.push(new URL(request.url).pathname);
          return Promise.resolve(requested.length === 1 ? new Response("missing", { status: 404 }) : new Response("app shell"));
        }
      }
    }
  );
  assert.deepEqual(requested, ["/settings/data", "/index.html"]);
  assert.equal(await response.text(), "app shell");
});
import { deriveHoursProxyKey, createHoursAssertion, verifyHoursAssertion, HOURS_ASSERTION_HEADER, trustedPagesSource } from '../packages/shared/src/hours-proxy.ts';
const api='https://api.example.test',pages='https://dashboard.example.test',session='A'.repeat(43),at=Date.parse('2026-09-09T12:00:00Z');
test('Hours assertions bind body, canonical Unicode query, method, origins, installation and freshness',async()=>{
 const secret=await deriveHoursProxyKey(session,'primary',pages,api),body=new TextEncoder().encode('{}');
 const url=api+'/public/hours/teams?q='+encodeURIComponent('界'.repeat(100))+'&after='+('x'.repeat(128));
 const request=new Request(url,{method:'POST',body});
 const assertion=await createHoursAssertion(request,secret,pages,api,'192.0.2.1',body,at);
 assert.ok(assertion.length<=1024);request.headers.set(HOURS_ASSERTION_HEADER,assertion);
 const source=await verifyHoursAssertion(request,session,'primary',pages,body,at);assert.match(source,/^[\w-]{43}$/);
 assert.equal(await verifyHoursAssertion(request,session,'primary',pages,body,at+30000),source,'exact replay remains valid and admission must charge it');
 for(const [r,s,i,p,b,t] of [
  [request,session,'primary',pages,body,at+30001],[request,session,'primary',pages,body,at-5001],
  [request,'B'.repeat(43),'primary',pages,body,at],[request,session,'foreign',pages,body,at],
  [request,session,'primary','https://other.test',body,at],[request,session,'primary',pages,new Uint8Array([1]),at],
  [new Request(url+'z',{method:'POST',headers:request.headers}),session,'primary',pages,body,at],
  [new Request(url,{headers:request.headers}),session,'primary',pages,body,at],
  [new Request(url.replace(api,'https://other.test'),{method:'POST',headers:request.headers}),session,'primary',pages,body,at]
 ])assert.equal(await verifyHoursAssertion(r,s,i,p,b,t),null);
 request.headers.set(HOURS_ASSERTION_HEADER,'x'.repeat(1025));assert.equal(await verifyHoursAssertion(request,session,'primary',pages,body,at),null);
});

test('Pages source provenance rejects Worker ingress, sentinel, malformed and missing metadata',()=>{
 const trusted=(ip,cf={},extra={})=>{const r=new Request(pages,{headers:{'cf-connecting-ip':ip,...extra}});if(cf!==null)Object.defineProperty(r,'cf',{value:cf});return trustedPagesSource(r);};
 assert.equal(trusted('192.0.2.1'),'192.0.2.1');assert.equal(trusted('2001:0db8::1'),'2001:db8::1');
 assert.equal(trusted('::ffff:c000:201'),'192.0.2.1');
 for(const value of ['2a06:98c0:3600::103','not-an-ip','192.0.2.1, 192.0.2.2','256.0.0.1','[::1]','::1%lo0',''])assert.equal(trusted(value),null);
 assert.equal(trusted('192.0.2.1',null),null);assert.equal(trusted('192.0.2.1',[],{}),null);
 assert.equal(trusted('192.0.2.1',{}, {'cf-worker':''}),null);
});

test('actual generated Pages proxy strips supplied assertions and signs only trusted bounded public traffic',async()=>{
 const module=await import(`data:text/javascript,${encodeURIComponent(buildPagesProxy(api))}`),secret=await deriveHoursProxyKey(session,'primary',pages,api);
 const original=globalThis.fetch;let upstream,calls=0;
 globalThis.fetch=async r=>{calls++;upstream=r;return new Response('ok',{headers:{[HOURS_ASSERTION_HEADER]:'not-reflected'}});};
 try{
  const send=async({cf={},ip='192.0.2.1',extra={},key=secret,body='{}',origin=pages}={})=>{
   const r=new Request(pages+'/api/public/hours/entries',{method:'POST',headers:{'content-type':'application/json',origin,'cf-connecting-ip':ip,[HOURS_ASSERTION_HEADER]:'spoof',...extra},body});
   if(cf!==null)Object.defineProperty(r,'cf',{value:cf});return module.default.fetch(r,{HOURS_PROXY_KEY:key});
  };
  const response=await send();assert.equal(response.headers.get(HOURS_ASSERTION_HEADER),null);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(upstream.url,api+'/public/hours/entries');assert.equal(upstream.redirect,'manual');
  assert.ok(await verifyHoursAssertion(upstream,session,'primary',pages,new TextEncoder().encode('{}')));
  for(const options of [{cf:null},{ip:'2a06:98c0:3600::103'},{extra:{'cf-worker':'other.test'}},{key:undefined},{key:'invalid'}]){
   if(Object.hasOwn(options,'key')&&options.key===undefined)options.key=null;
   await send(options);assert.equal(upstream.headers.get(HOURS_ASSERTION_HEADER),null);
  }
  let before=calls;assert.equal((await send({body:'x'.repeat(16385)})).status,413);assert.equal(calls,before);
  assert.equal((await send({origin:'https://attacker.test'})).status,403);assert.equal(calls,before);
 }finally{globalThis.fetch=original;}
});


test('generated public proxy bounds a stalled read and never forwards rejected input',async()=>{
 const module=await import(`data:text/javascript,${encodeURIComponent(buildPagesProxy(api))}`);
 const originalFetch=globalThis.fetch,originalTimer=globalThis.setTimeout;let calls=0,canceled=false;
 globalThis.fetch=async()=>{calls++;return new Response('unexpected');};
 globalThis.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms===10000?5:ms,...args);
 try{
  const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){canceled=true;return new Promise(()=>{});}});
  const response=await module.default.fetch(new Request(pages+'/api/public/hours/entries',{method:'POST',headers:{origin:pages,'content-type':'application/json'},body,duplex:'half'}),{});
  assert.equal(response.status,408);assert.equal(canceled,true);assert.equal(calls,0);
  const malformed=await module.default.fetch(new Request(pages+'/api/public/hours/entries',{method:'POST',headers:{origin:pages,'content-type':'text/plain'},body:'{}'}),{});
  assert.equal(malformed.status,415);assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch;globalThis.setTimeout=originalTimer;}
});
