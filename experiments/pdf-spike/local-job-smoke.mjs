// Usage: node local-job-smoke.mjs <absolute path to installed miniflare package>
// Uses local workerd only. The token below is explicitly synthetic and never deployed.
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
const require=createRequire(import.meta.url);
const {Miniflare,Log,LogLevel,convertV4MiniflareOptions}=require(resolve(process.argv[2]));
const root=fileURLToPath(new URL('.',import.meta.url));
const persistence=resolve(root,'output',`workerd-${Date.now()}`);await mkdir(persistence,{recursive:true});
const token='synthetic-local-test-only-000000000000';
const options=convertV4MiniflareOptions({name:'pdf-spike-local',modules:true,scriptPath:resolve(root,'dist/job-worker.mjs'),compatibilityDate:'2026-09-04',bindings:{SPIKE_TOKEN:token},durableObjects:{PDF_SPIKE_JOBS:{className:'PdfSpikeJob',useSQLite:true}},resourcePersistencePath:persistence,log:new Log(LogLevel.ERROR),telemetry:{enabled:false}});
const headers={authorization:`Bearer ${token}`};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let mf=new Miniflare(options);
const results=[];
try {
  assert.equal((await mf.dispatchFetch('https://example.invalid/jobs/mixed-1')).status,401);
  for(const id of ['mixed-1','png-1','jpeg-1','vector-1']) {
    const response=await mf.dispatchFetch(`https://example.invalid/jobs/${id}`,{method:'POST',headers});
    assert.equal(response.status,202);assert.equal((await response.json()).state,'queued');
    // No request, browser, or waitUntil remains alive while the alarm assembles.
    await wait(2000);
    let status;
    for(let i=0;i<40;i++) {
      status=await (await mf.dispatchFetch(`https://example.invalid/jobs/${id}`,{headers})).json();
      if(['complete','failed'].includes(status.state)) break; await wait(250);
    }
    assert.equal(status.state,'complete');
    const result=await mf.dispatchFetch(`https://example.invalid/jobs/${id}/result`,{headers});
    const bytes=await result.arrayBuffer();const hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
    assert.equal(hash,status.sha256);assert.equal((await PDFDocument.load(bytes)).getPageCount(),status.pageCount);
    await writeFile(resolve(root,'output',`durable-${id}.pdf`),new Uint8Array(bytes));results.push(status);
    assert.equal((await mf.dispatchFetch(`https://example.invalid/jobs/${id}`,{method:'POST',headers})).status,200);
  }
  // Queue a second job, then stop the runtime before its scheduled alarm.
  assert.equal((await mf.dispatchFetch('https://example.invalid/jobs/mixed-2',{method:'POST',headers})).status,202);
  // Recreate the local runtime with the same SQLite persistence: queued/completed jobs survive.
  await mf.dispose();mf=new Miniflare(options);
  await mf.ready;await wait(2000);
  const resumed=await (await mf.dispatchFetch('https://example.invalid/jobs/mixed-2',{headers})).json();
  assert.equal(resumed.state,'complete');assert.equal(resumed.sha256,results[0].sha256);
  const restored=await (await mf.dispatchFetch('https://example.invalid/jobs/mixed-1',{headers})).json();
  assert.deepEqual(restored,results[0]);
  const restoredPdf=await mf.dispatchFetch('https://example.invalid/jobs/mixed-1/result',{headers});assert.equal(restoredPdf.status,200);
  await writeFile(resolve(root,'output','workerd-results.json'),JSON.stringify({runtime:'local Miniflare/workerd SQLite only',results,persistenceRestartPassed:true,queuedRestartPassed:true},null,2));
  console.log(JSON.stringify({runtime:'local workerd; not deployed CPU telemetry',results,persistenceRestartPassed:true,queuedRestartPassed:true},null,2));
} finally {await mf.dispose();}
