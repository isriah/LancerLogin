import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './updater-bootstrap-fixture.mjs';
import { createUpdaterRuntime } from '../apps/updater/runtime.mjs';
import { bootstrapPagesConfiguration } from '../apps/updater/src/bootstrap-preflight.mjs';
async function ready(f){for(let i=0;i<160;i++){await f.runtime.initialize(f.capability,f.input);if(f.state.publicReads) return;}throw Error('not prepared');}
const installed=f=>f.updater.prepare('SELECT COUNT(*) AS n FROM updater_state').get().n;
test('private bootstrap verifies actual catalog and signed code, pins full adoption, and rejects final drift',async t=>{
 const f=await fixture(t);f.application.exec('CREATE TABLE sqlitex_unreviewed(id INTEGER)');
 await assert.rejects(()=>f.initialize(),/bootstrap-schema/);assert.equal(installed(f),0);f.application.exec('DROP TABLE sqlitex_unreviewed');
 f.state.badCode=true;await assert.rejects(()=>f.initialize());assert.equal(installed(f),0);f.state.badCode=false;
 await ready(f);const requests=f.state.reads;f.state.badSettings=true;
 await assert.rejects(()=>f.runtime.initialize(f.capability,f.input),/bootstrap-bindings/);assert.equal(installed(f),0);assert.ok(f.state.reads>requests);
 f.state.badSettings=false;await assert.rejects(()=>f.runtime.initialize(f.capability,{...f.input,adoption:{...f.input.adoption,recordSha256:'c'.repeat(64)}}));assert.equal(installed(f),0);
 await f.initialize();assert.equal(installed(f),1);
 const before=f.state.reads;f.state.badSettings=true;f.application.exec('CREATE TABLE later_schema(id INTEGER)');
 assert.equal((await f.runtime.initialize(f.capability,f.input)).outcome,'initialized');assert.equal(f.state.reads,before,'completed adoption never validates against later releases');
 assert.deepEqual(bootstrapPagesConfiguration({env_vars:{KEY:{type:'secret_text',value:'synthetic-secret'}}}),{env_vars:{KEY:{type:'secret_text'}}});
 assert.throws(()=>bootstrapPagesConfiguration({unknown_secret:'synthetic-secret'}));
});
test('lost engine initialization acknowledgment requires fresh completion proof after restart; phase costs bounded',async t=>{
 const f=await fixture(t);let lost=false,peakQueries=0,peakFetch=0;
 f.state.afterQuery=sql=>{if(!lost&&sql.startsWith('INSERT INTO updater_state ')){lost=true;throw Error('lost initialization acknowledgment');}};
 for(let i=0;i<160;i++){const q=f.state.queries,r=f.state.reads;try{await f.runtime.initialize(f.capability,f.input);}catch(error){assert.equal(error.message,'lost initialization acknowledgment');break;}finally{peakQueries=Math.max(peakQueries,f.state.queries-q);peakFetch=Math.max(peakFetch,f.state.reads-r);}}
 assert.ok(lost);assert.equal(installed(f),1);const restarted=await createUpdaterRuntime(f.options);f.state.badSettings=true;
 await assert.rejects(()=>restarted.initialize(f.capability,f.input),/bootstrap-bindings/);f.state.badSettings=false;
 assert.equal((await restarted.initialize(f.capability,f.input)).outcome,'initialized');assert.ok(peakQueries<=49);assert.ok(peakFetch<=8);
 t.diagnostic(`private initialization peak ${peakQueries} D1 statements, ${peakFetch} read-only Fetch calls (measured separately); small real schema49 signed fixture`);
});

test('maximum archive and2048-file index is bounded; asset continuations never reread archive chunks',async t=>{
 const f=await fixture(t,{largeDashboard:true});assert.equal(f.files.get('dashboard.tar').length,16777216);let peak=0,chunkReads=0;
 f.state.afterQuery=sql=>{if(sql.startsWith('SELECT chunk_index,sha256,envelope'))chunkReads++;};
 for(let i=0;i<360;i++){const before=f.state.queries;await f.runtime.initialize(f.capability,f.input);peak=Math.max(peak,f.state.queries-before);if(f.state.publicReads)break;}
 assert.equal(f.state.publicReads,1);const before=chunkReads,q=f.state.queries;await f.runtime.initialize(f.capability,f.input);assert.equal(chunkReads,before);assert.equal(f.state.publicReads,2);assert.ok(f.state.queries-q<=8);
 assert.equal(f.updater.prepare("SELECT COUNT(*) AS n FROM updater_provider_operations WHERE operation_id LIKE 'runtime-bootstrap-assets:%'").get().n,8);assert.ok(peak<=49,`peak ${peak}`);
 t.diagnostic(`16MiB/2048-file initialization preparation peak ${peak} D1 statements; subsequent asset ${f.state.queries-q} D1 statements/one public Fetch; no repeated archive chunk reads`);
});
