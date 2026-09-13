import { selectSnapshotCatalog } from './snapshot-catalog-registry.mjs';
import { createSnapshotCapture } from './snapshot-capture.mjs';
import { sha256 } from '../../../packages/shared/src/updater/application-release.mjs';
export const OWNER = '_ll_snapshot_owner', STEPS = '_ll_snapshot_steps', GENERATIONS = '_ll_snapshot_generations';
export const ownerSql = `CREATE TABLE ${OWNER}(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,snapshot TEXT NOT NULL,next_step INTEGER NOT NULL CHECK(next_step>=1))`;
export const stepsSql = `CREATE TABLE ${STEPS}(step INTEGER PRIMARY KEY CHECK(step>=1),owner TEXT NOT NULL,commitment TEXT NOT NULL)`;
export const generationsSql = `CREATE TABLE ${GENERATIONS}(owner TEXT PRIMARY KEY,identity_json TEXT NOT NULL,prior_owner TEXT,status TEXT NOT NULL CHECK(status IN ('cleaning','active','complete')),final_step INTEGER)`;
export const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE (name NOT GLOB 'sqlite_*' OR type='index' OR name='sqlite_sequence') AND name NOT IN ('_cf_KV','_cf_METADATA') AND tbl_name NOT IN ('_cf_KV','_cf_METADATA') ORDER BY type,name LIMIT 512";
const check = (ok, reason = 'validation-lifecycle') => { if (!ok) throw Error(reason); };
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const quote = name => { check(/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)); return `"${name}"`; };
const hash = value => sha256(new TextEncoder().encode(JSON.stringify(value)));
export const metadata = object => [OWNER,STEPS,GENERATIONS].includes(object.name) || object.tbl_name === GENERATIONS;
export function checkMetadata(objects, legacy = false) {
  for (const [name, sql] of [[OWNER,ownerSql],[STEPS,stepsSql],...(!legacy ? [[GENERATIONS,generationsSql]] : [])]) check(objects.find(o => o.name === name)?.sql === sql);
  // Only SQLite's generated primary-key index may accompany the generation table.
  check(objects.filter(o => o.tbl_name === GENERATIONS && o.name !== GENERATIONS).every(o => o.type === 'index' && o.sql === null && o.name === `sqlite_autoindex_${GENERATIONS}_1`));
}
export function createValidationLifecycle({ database, store, pins, withClosedEpoch }) {
  const primary = () => database.withSession ? database.withSession('first-primary') : database;
  async function priorProof(owner, objects, legacy) {
    const row = await store.operation(`snapshot-replay:${owner.owner}`), value = row?.value;
    check(value?.cursor.phase === 'complete' && !value.pending && value.step === owner.next_step && value.identity.operationId === owner.owner && value.identity.manifestSha256 === owner.snapshot && Object.entries(pins).every(([k,v]) => value.identity[k] === v));
    const selected = ['schema-46-v1','schema-49-v1'].map(key => ({key,...selectSnapshotCatalog(key)})).find(item => item.catalogSha256 === value.identity.catalogSha256); check(selected);
    const { validationDatabaseId, ...capturePins } = pins;
    const capture = createSnapshotCapture({ pins: capturePins, database, store, catalogKey: selected.key, withClosedEpoch: async () => { throw Error('unused'); } });
    const manifest = await capture.describe(value.identity.snapshotId);
    check(manifest.manifestSha256 === owner.snapshot && manifest.catalogSha256 === selected.catalogSha256);
    checkMetadata(objects, legacy);
    check(same(objects.filter(o => !metadata(o)), selected.catalog.objects));
    return { value, manifest, selected };
  }
  async function prepare(identity, manifest, readOnly) {
    const db = primary(), objects = (await db.prepare(schemaSql).all()).results;
    if (!objects.length) return { ready: true, initial: true, step: 0 };
    check(objects.some(o => o.name === OWNER), 'validation-target-not-empty');
    const key = `validation-lifecycle:${identity.operationId}`, existing = await store.operation(key);
    const current = await db.prepare(`SELECT owner,snapshot,next_step FROM ${OWNER} WHERE id=1`).first(); check(current);
    if (!existing) {
      const legacy = !objects.some(o => o.name === GENERATIONS), prior = await priorProof(current, objects, legacy);
      check(typeof withClosedEpoch === 'function');
      return withClosedEpoch({ installationId: pins.installationId, operationId: identity.operationId }, async authority => {
        check(authority?.state === 'closed' && authority.installationId === pins.installationId && authority.operationId === identity.operationId && authority.jobId === manifest.identity.jobId && authority.epoch === manifest.identity.epoch && authority.epoch > prior.manifest.identity.epoch && authority.jobId !== prior.manifest.identity.jobId && authority.schema === manifest.schema && same(authority.ledger, selectSnapshotCatalog(`schema-${manifest.schema}-v1`).catalog.ledger));
        if (readOnly) return { ready: false };
        if (!legacy) {
          const completed = await db.prepare(`SELECT identity_json,status,final_step FROM ${GENERATIONS} WHERE owner=?`).bind(current.owner).first();
          check(completed?.status === 'complete' && completed.final_step === current.next_step && same(JSON.parse(completed.identity_json),prior.value.identity));
        }
        const value = { identity, jobId: manifest.identity.jobId, epoch: manifest.identity.epoch, priorKey: prior.selected.key, priorOwner: current.owner, priorSnapshot: current.snapshot, priorIdentity: prior.value.identity, priorFinalStep: current.next_step, step: current.next_step, phase: legacy ? 'adopt' : 'claim', index: 0, pending: null };
        check(await store.claim(key,value)); return { ready: false };
      });
    }
    let state = existing.value; check(same(state.identity,identity));
    check(typeof withClosedEpoch === 'function');
    return withClosedEpoch({ installationId: pins.installationId, operationId: identity.operationId }, async authority => {
      check(authority?.state === 'closed' && authority.installationId === pins.installationId && authority.operationId === identity.operationId && authority.jobId === state.jobId && authority.epoch === state.epoch && state.jobId === manifest.identity.jobId && state.epoch === manifest.identity.epoch && authority.schema === manifest.schema && same(authority.ledger, selectSnapshotCatalog(`schema-${manifest.schema}-v1`).catalog.ledger));
      const adopting = state.phase === 'adopt';
      checkMetadata(objects, adopting && !objects.some(o=>o.name===GENERATIONS));
      const allowed = selectSnapshotCatalog(state.priorKey).catalog.objects;
      check(objects.filter(o=>!metadata(o)).every(object=>allowed.some(candidate=>same(object,candidate))), 'validation-schema');
      const save = value => store.replace(key,existing.revision,value);
      if (state.pending) {
        const receipt = await db.prepare(`SELECT owner,commitment FROM ${STEPS} WHERE step=?`).bind(state.step).first();
        if (!receipt) return { ready: false, unknown: true };
        check(receipt.owner === state.pending.owner && receipt.commitment === state.pending.commitment && current.owner === state.pending.resultOwner && current.snapshot === state.pending.resultSnapshot && current.next_step === state.step + 1);
        if (!readOnly) check(await save({...state,...state.pending.next,step:state.step+1,pending:null}));
        return { ready:false };
      }
      if (state.phase === 'ready') { check(current.owner === identity.operationId && current.snapshot === identity.manifestSha256 && current.next_step === state.step); return { ready:true, initial:false,step:state.step }; }
      const old = ['claim','adopt'].includes(state.phase);
      check(current.owner === (old ? state.priorOwner : identity.operationId) && current.snapshot === (old ? state.priorSnapshot : identity.manifestSha256) && current.next_step === state.step);
      if (readOnly) return { ready:false };
      async function dispatch(works,next) {
        const commitment = await hash({ identity, step:state.step, phase:state.phase,index:state.index,next,works });
        const resultOwner = adopting ? current.owner : identity.operationId, resultSnapshot = adopting ? current.snapshot : identity.manifestSha256;
        check(await save({...state,pending:{owner:current.owner,commitment,next,resultOwner,resultSnapshot}}));
        const guard = db.prepare(`INSERT INTO ${STEPS}(step,owner,commitment) VALUES(?,(SELECT owner FROM ${OWNER} WHERE id=1 AND owner=? AND snapshot=? AND next_step=?),?)`).bind(state.step,current.owner,current.snapshot,state.step,commitment);
        await db.batch([guard,...works.map(sql => db.prepare(sql)),db.prepare(`UPDATE ${OWNER} SET owner=?,snapshot=?,next_step=next_step+1 WHERE id=1`).bind(resultOwner,resultSnapshot)]);
        return {ready:false};
      }
      const {catalog,plan} = selectSnapshotCatalog(state.priorKey);
      if (old) {
        // JSON uses SQL literals only here, generated from authenticated internal identities.
        const literal = value => "'"+value.replaceAll("'","''")+"'";
        if (adopting) return dispatch([generationsSql, `INSERT INTO ${GENERATIONS}(owner,identity_json,status,final_step) VALUES(${literal(state.priorOwner)},${literal(JSON.stringify(state.priorIdentity))},'complete',${state.priorFinalStep})`],{phase:'claim',index:0});
        return dispatch([`INSERT INTO ${GENERATIONS}(owner,identity_json,prior_owner,status) VALUES(${literal(identity.operationId)},${literal(JSON.stringify(identity))},${literal(state.priorOwner)},'cleaning')`],{phase:'triggers',index:0});
      }
      if (state.phase === 'triggers') {
        const triggers = catalog.objects.filter(o=>o.type==='trigger');
        if (state.index < triggers.length) return dispatch(triggers.slice(state.index,state.index+8).map(o=>`DROP TRIGGER ${quote(o.name)}`),{phase:'triggers',index:Math.min(triggers.length,state.index+8)});
        check(await save({...state,phase:'rows',index:0})); return {ready:false};
      }
      const tables = [...plan.order].reverse();
      if (state.phase === 'rows') {
        if(state.index === tables.length) { check(await save({...state,phase:'drop',index:0}));return {ready:false}; }
        const name=quote(tables[state.index]);
        if(await db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).first()) return dispatch([`DELETE FROM ${name} WHERE _rowid_ IN (SELECT _rowid_ FROM ${name} ORDER BY _rowid_ LIMIT 64)`],{phase:'rows',index:state.index});
        check(await save({...state,index:state.index+1}));return {ready:false};
      }
      if(state.phase === 'drop') {
        if(state.index < tables.length) return dispatch(tables.slice(state.index,state.index+8).map(name=>`DROP TABLE ${quote(name)}`),{phase:'drop',index:Math.min(tables.length,state.index+8)});
        check(await save({...state,phase:'sequence',index:0}));return {ready:false};
      }
      check(state.phase==='sequence');
      const sequence=catalog.objects.find(o=>o.name==='sqlite_sequence');
      check(same(objects.filter(o=>!metadata(o)),[sequence]));
      if(await db.prepare('SELECT 1 FROM sqlite_sequence LIMIT 1').first()) return dispatch(['DELETE FROM sqlite_sequence WHERE rowid IN (SELECT rowid FROM sqlite_sequence LIMIT 64)'],{phase:'sequence',index:0});
      return dispatch([`UPDATE ${GENERATIONS} SET status='active' WHERE owner='${identity.operationId}' AND status='cleaning'`],{phase:'ready',index:0});
    });
  }
  return { prepare };
}
