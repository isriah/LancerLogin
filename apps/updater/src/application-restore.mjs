import { selectSnapshotCatalog } from './snapshot-catalog-registry.mjs';
import { createSnapshotCapture } from './snapshot-capture.mjs';
import { SNAPSHOT_LIMITS, typedPageQuery, encodeTypedPage, rowId } from './snapshot-codec.mjs';
import { sha256 } from '../../../packages/shared/src/updater/application-release.mjs';
import { fromBase64 } from './checkpoint.mjs';

const OWNER = '_ll_restore_owner', STEPS = '_ll_restore_steps';
const ownerSql = `CREATE TABLE ${OWNER}(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,commitment TEXT NOT NULL,next_step INTEGER NOT NULL)`;
const stepsSql = `CREATE TABLE ${STEPS}(step INTEGER PRIMARY KEY,owner TEXT NOT NULL,commitment TEXT NOT NULL)`;
const check = (ok, reason = 'restore-identity') => { if (!ok) throw Error(reason); };
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const encoder = new TextEncoder(), hash = value => sha256(encoder.encode(JSON.stringify(value)));
const quote = x => { check(/^[A-Za-z_][A-Za-z_0-9]*$/.test(x)); return `"${x}"`; };
const appFilter = `(name NOT GLOB 'sqlite_*' OR type='index' OR name='sqlite_sequence') AND name NOT IN ('_cf_KV','_cf_METADATA','${OWNER}','${STEPS}') AND tbl_name NOT IN ('_cf_KV','_cf_METADATA')`;
const schemaSql = `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE ${appFilter} ORDER BY type,name LIMIT 512`;
// Compare compiled schema as one bound JSON value inside the mutation batch.
const schemaGuard = `(SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE ${appFilter} ORDER BY type,name))=?`;
const ledgerGuard = `(SELECT json_group_array(name) FROM (SELECT name FROM d1_migrations ORDER BY id))=?`;
function insert(table,row) {
  rowId(row[0]); const params=[row[0]], expressions=['CAST(? AS INTEGER)'];let bytes=32;
  check(row[1].length===table.columns.length && table.columns.length<100);
  for(const [type,value] of row[1]){
    if(type==='null'){expressions.push('NULL');bytes+=32;continue;}
    if(type==='integer'){rowId(value);expressions.push('CAST(? AS INTEGER)');params.push(value);bytes+=32;}
    else if(type==='real'){check(typeof value==='string'&&/^-?\d+\.\d+(e[+-]?\d+)?$/i.test(value));expressions.push('CAST(? AS REAL)');params.push(value);bytes+=32;}
    else{check(['text','blob'].includes(type)&&typeof value==='string'&&/^(?:[0-9A-F]{2})*$/.test(value));const data=Uint8Array.from(value.match(/../g)??[],x=>parseInt(x,16));expressions.push(type==='text'?'CAST(? AS TEXT)':'CAST(? AS BLOB)');params.push(data.buffer);bytes+=data.length+32;}
  }
  check(bytes<=SNAPSHOT_LIMITS.rowBytes+32&&params.length<=100);
  return {sql:`INSERT INTO ${quote(table.name)}(_rowid_,${table.columns.map(quote).join(',')}) VALUES(${expressions.join(',')})`,params,bytes};
}

// INTERNAL ONLY. No runtime enables this transport or manufactures writer proof.
export function createApplicationRestore({ pins: input, database, updaterDatabase, store, cipher, verifier, capability, withWriterFence }) {
  const pins=structuredClone(input);
  check(Object.keys(pins).sort().join(',')==='applicationDatabaseId,installationId,updaterDatabaseId'&&uuid(pins.applicationDatabaseId)&&uuid(pins.updaterDatabaseId)&&pins.applicationDatabaseId!==pins.updaterDatabaseId&&/^[A-Za-z0-9_-]{1,80}$/.test(pins.installationId));
  check(database!==updaterDatabase&&typeof database?.batch==='function'&&typeof updaterDatabase?.prepare==='function'&&capability&&typeof withWriterFence==='function');
  const primary=db=>db.withSession?db.withSession('first-primary'):db;
  const first=(sql,...params)=>primary(updaterDatabase).prepare(sql).bind(...params).first();
  const captures=new Map([46,49].map(schema=>[schema,createSnapshotCapture({pins,database,store,catalogKey:`schema-${schema}-v1`,withClosedEpoch:async()=>{throw Error('restore-read-only-capture');}})]));
  async function authority(request){
    const raw=await first('SELECT state_json FROM updater_state WHERE id=1 AND installation_id=?',pins.installationId);check(raw);const current=JSON.parse(raw.state_json),job=current.job;
    check(job?.id===request.jobId&&job.mode==='restore'&&['running','reconciling'].includes(job.status)&&job.operation?.id===request.operationId&&job.operation.kind==='restoreBackup');
    const handoff=(await store.operation(`restore-handoff:${job.id}`))?.value;check(handoff&&handoff.installationId===pins.installationId&&handoff.recoveryJobId===job.id&&handoff.operationId===request.operationId&&handoff.requestId===job.requestId&&handoff.failedJob.id===job.failedJobId&&handoff.failedJob.status==='failed'&&!handoff.failedJob.operation&&handoff.failedJob.mode==='update'&&handoff.checkpointJobId===job.checkpointJobId&&current.checkpoint?.jobId===job.checkpointJobId&&current.checkpoint.backupReady);
    check(same(current.installed,handoff.failedInstalled),'restore-installed');
    const maintenance=await first("SELECT m.state,m.epoch,m.job_id AS jobId,o.state_json FROM updater_maintenance m JOIN updater_job_maintenance o ON o.installation_id=m.installation_id WHERE m.installation_id=?",pins.installationId),owner=maintenance&&JSON.parse(maintenance.state_json);
    check(maintenance?.state==='closed'&&maintenance.epoch===handoff.epoch&&maintenance.jobId===job.id&&owner.phase==='closed'&&owner.epoch===handoff.epoch&&owner.jobId===job.id);
    const held=await first("SELECT COUNT(*) AS n,MIN(hold_id) AS id,MIN(job_id) AS jobId,MIN(epoch) AS epoch,MIN(operation_id) AS operationId FROM updater_job_holds WHERE installation_id=? AND state='active'",pins.installationId);
    check(held.n===1&&held.id===handoff.holdId&&held.jobId===job.id&&held.epoch===handoff.epoch&&held.operationId===request.operationId,'restore-hold');
    check(!await first("SELECT 1 FROM updater_execution_permits WHERE installation_id=? AND state='active' LIMIT 1",pins.installationId),'restore-active-execution');
    check(!await first("SELECT 1 FROM updater_execution_operations o JOIN updater_execution_permits p ON p.permit_id=o.permit_id WHERE p.installation_id=? AND o.state='pending' LIMIT 1",pins.installationId),'restore-ambiguous-execution');
    const checkpoint=await cipher.open(current.checkpoint.jobId,current.checkpoint.envelope),backup=checkpoint.backup;
    check(backup?.verified===true&&backup.backupId===handoff.backupId&&backup.sha256===handoff.backupSha256&&backup.identity.jobId===job.failedJobId&&backup.identity.epoch===handoff.epoch&&backup.schema===checkpoint.priorInstalled.schema&&[46,49].includes(backup.schema));
    check(same((await store.operation(`backup:${backup.backupId}`))?.value.receipt,backup));
    const prior=await verifier.verify(fromBase64(checkpoint.priorRelease.manifest),fromBase64(checkpoint.priorRelease.signature)),target=await verifier.verify(fromBase64(handoff.failedJob.release.manifest),fromBase64(handoff.failedJob.release.signature));
    check(same(job.release,checkpoint.priorRelease)&&prior.manifest.targetSchema===backup.schema&&target.manifest.targetSchema===49);
    const before=selectSnapshotCatalog(`schema-${current.installed.schema}-v1`),after=selectSnapshotCatalog(`schema-${backup.schema}-v1`);
    check(same(current.installed.ledger,before.catalog.ledger)&&same(checkpoint.priorInstalled.ledger,after.catalog.ledger)&&same(target.manifest.migrations.map(({id,sha256})=>({id,sha256})),selectSnapshotCatalog('schema-49-v1').catalog.ledger));
    const migrated=handoff.failedJob.completed.filter(x=>x.kind==='applyMigration'&&!x.failed);check(migrated.length===current.installed.schema-backup.schema&&migrated.length<=3);
    for(const [i,entry] of migrated.entries()){
      const migration=target.manifest.migrations[backup.schema+i],record=(await store.operation(`migration:${entry.id}`))?.value;
      check(same(record?.identity,{...pins,operationId:entry.id,jobId:job.failedJobId,epoch:handoff.epoch,manifestSha256:target.manifestSha256,migrationId:migration.id,sha256:migration.sha256,fromSchema:migration.fromSchema,toSchema:migration.toSchema}),'restore-migration-lineage');
    }
    for(const entry of handoff.failedJob.completed.filter(x=>!x.failed&&['deployApi','deployPages'].includes(x.kind))){const record=(await store.operation(entry.id))?.value;check(record?.phase==='complete'&&record.receipt?.manifestSha256===target.manifestSha256,'restore-provider-lineage');}
    // The encrypted primary failed-job archive carries failed:true only after
    // engine.finish accepted a trusted terminal rejection. SQL/transport errors
    // remain unknown operations and cannot enter this archival contract.
    const fence=handoff.fence;check(fence&&Object.keys(fence).sort().join(',')==='accountId,configurationSha256,manifestSha256,worker'&&digest(fence.manifestSha256)&&digest(fence.configurationSha256)&&typeof fence.accountId==='string'&&typeof fence.worker==='string');
    return {handoff,backup,before,after,expected:{...pins,...fence,epoch:handoff.epoch,jobId:job.id,operationId:request.operationId,holdId:held.id}};
  }
  async function advance(actual,request,readOnly=false){
    check(actual===capability&&request&&Object.keys(request).sort().join(',')==='jobId,operationId'&&uuid(request.jobId)&&uuid(request.operationId),'restore-request');
    try{
      const auth=await authority(request);
      return await withWriterFence(Object.freeze(Object.fromEntries(['installationId','applicationDatabaseId','epoch','jobId','operationId','holdId'].map(key=>[key,auth.expected[key]]))),async evidence=>{
        check(evidence&&Object.entries(auth.expected).filter(([key])=>key!=='updaterDatabaseId').every(([key,value])=>evidence[key]===value),'restore-writer-fence');
        const {backup,before,after}=auth,capture=captures.get(backup.schema);
        return await capture.withReader(backup.backupId,async reader=>{
          const manifest=await capture.describe(backup.backupId,reader);
          check(manifest.manifestSha256===backup.sha256&&manifest.identity.jobId===auth.handoff.failedJob.id&&manifest.identity.epoch===auth.expected.epoch&&manifest.schema===backup.schema&&backup.validation.manifestSha256===manifest.manifestSha256&&backup.validation.catalogSha256===after.catalogSha256);
          const {holdId,...stableFence}=auth.expected;const identity={...stableFence,backupId:backup.backupId,backupSha256:backup.sha256,fromCatalog:before.catalogSha256,toCatalog:after.catalogSha256},commitment=await hash(identity),key=`application-restore:${request.operationId}`;
          let row=await store.operation(key);const db=primary(database),sql=work=>{check(encoder.encode(work.sql).length<=100000&&(work.params??[]).length<=100,'restore-query-size');return db.prepare(work.sql).bind(...(work.params??[]));};
          if(!row){
            if(readOnly)return {outcome:'unknown'};
            check(await store.claim(key,{identity,step:0,cursor:{phase:'triggers',index:0},pending:{step:0,commitment}}));
            const objects=JSON.stringify(before.catalog.objects);check(encoder.encode(objects).length<1500000);
            await db.batch([sql({sql:ownerSql}),sql({sql:stepsSql}),sql({sql:`INSERT INTO ${OWNER} VALUES(1,CASE WHEN ${schemaGuard} AND ${ledgerGuard} THEN ? ELSE NULL END,?,1)`,params:[objects,JSON.stringify(before.catalog.ledger.map(x=>x.id)),request.operationId,commitment]}),sql({sql:`INSERT INTO ${STEPS} VALUES(0,?,?)`,params:[request.operationId,commitment]})]);
            return {outcome:'pending'};
          }
          let state=row.value;check(same(state.identity,identity));
          if(state.cursor.phase==='complete')return {outcome:'applied',receipt:state.receipt};
          const final=state.cursor.phase.startsWith('final'),exists=await db.prepare('SELECT name FROM sqlite_schema WHERE name IN (?,?) ORDER BY name').bind(OWNER,STEPS).all();
          if(state.pending?.cleanup){
            if(exists.results.length)return {outcome:'unknown'};
            if(readOnly)return {outcome:'pending'};
            check(await store.replace(key,row.revision,{...state,pending:null,cursor:{phase:'final-compare',index:0,page:0,after:null}}));return {outcome:'pending'};
          }
          if(final)check(exists.results.length===0,'restore-final-metadata');else check(exists.results.length===2,'restore-owner');
          const owned=final?null:await db.prepare(`SELECT owner,commitment,next_step FROM ${OWNER} WHERE id=1`).first();
          if(!final)check(owned.owner===request.operationId&&owned.commitment===commitment,'restore-owner');
          if(state.pending){
            const receipt=await db.prepare(`SELECT owner,commitment FROM ${STEPS} WHERE step=?`).bind(state.pending.step).first();
            if(!receipt)return {outcome:'unknown'};
            check(receipt.owner===request.operationId&&receipt.commitment===state.pending.commitment&&owned.next_step===state.pending.step+1,'restore-step');
            if(readOnly)return {outcome:'pending'};
            check(await store.replace(key,row.revision,{...state,step:state.pending.step+1,cursor:state.pending.next??state.cursor,pending:null}));return {outcome:'pending'};
          }
          if(!final)check(owned.next_step===state.step,'restore-step');
          if(readOnly)return {outcome:'pending'};
          const save=next=>store.replace(key,row.revision,{...state,cursor:next});
          async function dispatch(works,next,cleanup=false){
            check(works.length>0&&works.length<=8,'restore-batch');const stepCommitment=await hash({identity,step:state.step,works,next});
            check(await store.replace(key,row.revision,{...state,pending:{step:state.step,commitment:stepCommitment,next,cleanup}}));
            const guard=sql({sql:`INSERT INTO ${STEPS} VALUES(?,(SELECT owner FROM ${OWNER} WHERE id=1 AND owner=? AND commitment=? AND next_step=?),?)`,params:[state.step,request.operationId,commitment,state.step,stepCommitment]});
            await db.batch([guard,...works.map(sql),...(!cleanup?[sql({sql:`UPDATE ${OWNER} SET next_step=next_step+1 WHERE id=1`})]:[])]);return {outcome:'pending'};
          }
          const c=state.cursor,cat=after.catalog,plan=after.plan;
          if(c.phase==='triggers'){
            const list=before.catalog.objects.filter(x=>x.type==='trigger');if(c.index<list.length)return dispatch(list.slice(c.index,c.index+8).map(x=>({sql:`DROP TRIGGER ${quote(x.name)}`})),{phase:c.phase,index:c.index+8});
            check(await save({phase:'delete',index:0}));return {outcome:'pending'};
          }
          if(c.phase==='delete'){
            const names=[...before.plan.order].reverse();if(c.index===names.length){check(await save({phase:'drop',index:0}));return {outcome:'pending'};}
            const name=quote(names[c.index]);if(await db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).first())return dispatch([{sql:`DELETE FROM ${name} WHERE _rowid_ IN (SELECT _rowid_ FROM ${name} ORDER BY _rowid_ LIMIT 64)`}],c);
            check(await save({...c,index:c.index+1}));return {outcome:'pending'};
          }
          if(c.phase==='drop'){
            const names=[...before.plan.order].reverse();if(c.index<names.length)return dispatch(names.slice(c.index,c.index+8).map(x=>({sql:`DROP TABLE ${quote(x)}`})),{phase:c.phase,index:c.index+8});
            return dispatch([{sql:'DELETE FROM sqlite_sequence'}],{phase:'tables',index:0});
          }
          if(['tables','early','objects'].includes(c.phase)){
            const list=c.phase==='tables'?cat.objects.filter(x=>x.type==='table'&&x.name!=='sqlite_sequence'):c.phase==='early'?plan.earlyIndexes.map(name=>cat.objects.find(x=>x.name===name)):cat.objects.filter(x=>x.type!=='table'&&x.sql&&!plan.earlyIndexes.includes(x.name));
            if(c.index<list.length)return dispatch(list.slice(c.index,c.index+8).map(x=>({sql:x.sql})),{phase:c.phase,index:c.index+8});
            check(await save({phase:c.phase==='tables'?'early':c.phase==='early'?'data':'compare',index:0,page:0,row:0,after:null}));return {outcome:'pending'};
          }
          if(c.phase==='sequence-clear')return dispatch([{sql:'DELETE FROM sqlite_sequence'}],{phase:'sequence',index:0,row:0});
          if(['data','sequence'].includes(c.phase)){
            const ordered=(c.phase==='data'?plan.order:['sqlite_sequence']).flatMap(name=>manifest.pages.map((page,index)=>({...page,index})).filter(p=>p.table===name));
            if(c.index===ordered.length){check(await save({phase:c.phase==='data'?'sequence-clear':'objects',index:0}));return {outcome:'pending'};}
            const descriptor=ordered[c.index],page=JSON.parse(new TextDecoder().decode(await capture.readPage(backup.backupId,descriptor.index,reader))),table=cat.tables.find(x=>x.name===page.table);
            const works=[];let size=0,end=c.row;while(end<page.rows.length&&works.length<8){const work=insert(table,page.rows[end]);if(works.length&&size+work.bytes>SNAPSHOT_LIMITS.rowBytes+32)break;works.push(work);size+=work.bytes;end++;}
            return dispatch(works,end===page.rows.length?{...c,index:c.index+1,row:0}:{...c,row:end});
          }
          if(['compare','final-compare'].includes(c.phase)){
            let {index,page,after:cursor}=c;
            for(let n=0;n<8&&index<cat.tables.length;n++){
              const table=cat.tables[index],descriptor=manifest.pages[page],query=typedPageQuery(table,cursor),rows=(await db.prepare(query.sql).bind(...query.params).all()).results;
              if(descriptor?.table===table.name){const original=await capture.readPage(backup.backupId,page,reader),actual=encodeTypedPage(table,rows,cursor);check(rows.length===descriptor.rows&&actual.length===original.length&&await sha256(actual)===descriptor.sha256,'restore-data');cursor=descriptor.lastRowId;page++;break;}
              check(rows.length===0,'restore-extra-data');index++;cursor=null;
            }
            check(index!==cat.tables.length||page===manifest.pages.length);check(await save(index===cat.tables.length?{phase:final?'final-checks':'checks'}:{phase:c.phase,index,page,after:cursor}));return {outcome:'pending'};
          }
          check(['checks','final-checks'].includes(c.phase));
          check(same((await db.prepare(schemaSql).all()).results,cat.objects),'restore-schema');
          check(same((await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map(x=>x.name),cat.ledger.map(x=>x.id)),'restore-ledger');
          check((await db.prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1').all()).results.length===0,'restore-foreign-key');
          const quick=(await db.prepare('PRAGMA quick_check(1)').all()).results;check(quick.length===1&&quick[0].quick_check==='ok','restore-quick-check');
          if(!final)return dispatch([{sql:`DROP TABLE ${STEPS}`},{sql:`DROP TABLE ${OWNER}`}],{phase:'final-compare',index:0,page:0,after:null},true);
          check((await db.prepare('SELECT name FROM sqlite_schema WHERE name IN (?,?)').bind(OWNER,STEPS).all()).results.length===0);
          const receipt={backupId:backup.backupId,sha256:backup.sha256,schema:backup.schema,identity};
          check(await store.replace(key,row.revision,{...state,cursor:{phase:'complete'},receipt}));return {outcome:'applied',receipt};
        });
      });
    }catch(error){const reason=new Set(['restore-identity','restore-installed','restore-hold','restore-active-execution','restore-ambiguous-execution','restore-migration-lineage','restore-provider-lineage','restore-writer-fence','restore-query-size','restore-final-metadata','restore-owner','restore-step','restore-batch','restore-data','restore-extra-data','restore-schema','restore-ledger','restore-foreign-key','restore-quick-check']).has(error?.message)?error.message:'restore-unavailable';return {outcome:'unknown',reason};}
  }
  return Object.freeze({advance:(actual,request)=>advance(actual,request),reconcile:(actual,request)=>advance(actual,request,true)});
}
