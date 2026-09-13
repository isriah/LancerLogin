import { DatabaseSync, constants as C } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unstable_splitSqlQuery } from 'wrangler';
import { submitSelfAssertedHours, submitStaffHours } from '../apps/api/src/hour-accounting.ts';
import { requestSelfAssertedHourCorrection, hourReviewRoute } from '../apps/api/src/hour-review-reports.ts';

export function assertRecoveryRuntime(){
 const [major,minor]=process.versions.node.split('.').map(Number);
 const actions=['SQLITE_OK','SQLITE_DENY','SQLITE_CREATE_TABLE','SQLITE_CREATE_INDEX','SQLITE_CREATE_TRIGGER','SQLITE_INSERT','SQLITE_UPDATE','SQLITE_READ','SQLITE_PRAGMA','SQLITE_TRANSACTION','SQLITE_FUNCTION','SQLITE_REINDEX'];
 if(!(major>24||major===24&&minor>=10)||typeof DatabaseSync.prototype.setAuthorizer!=='function'||!actions.every(name=>Number.isInteger(C[name])))throw Error('Application recovery requires Node.js 24.10.0 or later with node:sqlite DatabaseSync.setAuthorizer and authorization constants. Use current Node 24 LTS for development verification; SQL authorization cannot be bypassed.');
}
// Fail before constructing a model or evaluating any export SQL, including CLI imports.
assertRecoveryRuntime();

export const sha = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(value);
export const quote = name => '"'+name.replaceAll('"','""')+'"';
export const LIMIT = 1024*1024;
export const schemaSQL = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA') ORDER BY type,name";
export const fixtureNames = ['recovery_fixture','recovery_job'];
export const damageSQL = "UPDATE organization_settings SET organization_name='Synthetic restore damage' WHERE installation_id='primary'";
const now=Date.parse('2026-01-20T18:00:00Z');
const plain=rows=>JSON.parse(JSON.stringify(rows));
export const normalizeSchema=rows=>rows.map(r=>({...r,sql:r.sql?.replace(/^CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS /i,'CREATE $1 ')??null}));
export function capture(db){const schema=normalizeSchema(plain(db.prepare(schemaSQL).all()));const tables=schema.filter(r=>r.type==='table').map(r=>r.name).sort();return {schema,rows:Object.fromEntries(tables.map(name=>[name,sortRows(plain(db.prepare('SELECT * FROM '+quote(name)).all()))]))};}
export const sortRows=rows=>rows.sort((a,b)=>canonical(a).localeCompare(canonical(b),'en'));
export function sqliteDomain(db){
 const prepare=(sql)=>{let params=[];return {bind(...values){params=values;return this;},async first(){return db.prepare(sql).get(...params)??null;},async all(){return {results:plain(db.prepare(sql).all(...params))};},async run(){const info=db.prepare(sql).run(...params);return {success:true,meta:{changes:Number(info.changes)}};},execute(){const stmt=db.prepare(sql);const rows=stmt.all(...params);return {success:true,results:plain(rows),meta:{changes:db.prepare('SELECT changes() AS n').get().n}};}};};
 return {prepare,async batch(statements){db.exec('BEGIN');try{const result=statements.map(s=>s.execute());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
export async function buildModel(){
 const directory=new URL('../apps/api/migrations/',import.meta.url);const names=(await readdir(directory)).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&Number(n.slice(0,4))<=49).sort();
 if(names.length!==49||!names.at(-1).startsWith('0049_'))throw Error('This reviewed experiment pins exactly 49 migrations');
 const db=new DatabaseSync(':memory:');const migrations=[];
 try{
  for(const name of names){const bytes=await readFile(new URL(name,directory));migrations.push({name,sha256:sha(bytes)});for(const sql of unstable_splitSqlQuery(bytes.toString('utf8')))db.exec(sql);}
  db.exec("PRAGMA foreign_keys=ON; INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'); INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic application recovery','UTC'); INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('synthetic-admin','primary','synthetic-disabled-login','admin','2026-01-01'); INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('synthetic-member','primary','00001','Synthetic','Recovery','2026-01-01'); INSERT INTO platform_module_configuration(installation_id,hours_enabled) VALUES('primary',1); INSERT INTO hours_entry_settings(installation_id) VALUES('primary'); INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','synthetic-task','Synthetic task','task','2026-01-01','2026-01-01'); INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES('synthetic-meeting','primary','Synthetic attendance','2026-01-19T10:00:00Z','2026-01-19T11:00:00Z','synthetic-admin','2026-01-01'); INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,created_by) VALUES('synthetic-attendance','primary','synthetic-member','synthetic-meeting','manual','2026-01-19T10:00:00Z','synthetic-admin');");
  // Deterministic IDs only inside this isolated synthetic model; never a runtime hook.
  const original=crypto.randomUUID;let sequence=0;crypto.randomUUID=()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
  try{
   const domain=sqliteDomain(db);const input={memberId:'00001',categoryId:'synthetic-task',serviceDate:'2026-01-19',startLocal:'10:00',endLocal:'11:00',endNextDay:false,taskNotes:'Synthetic original',expectedTimeZone:'UTC',idempotencyKey:'synthetic-recovery-original'};
   const receipt=await submitSelfAssertedHours(domain,'primary',input,now);
   const request=await requestSelfAssertedHourCorrection(domain,'primary',{memberId:'00001',receiptId:receipt.id,serviceDate:'2026-01-19',message:'Synthetic correction',idempotencyKey:'synthetic-recovery-correction'},now);
   const resolve=(id,body)=>hourReviewRoute(domain,'primary','synthetic-admin',new Request('https://synthetic.invalid/admin/hours/correction-requests/'+id+'/resolve',{method:'POST'}),body,now);
   await resolve(request.reference,{revision:0,action:'corrected',note:'Synthetic 75 minute correction',entryId:receipt.id,entryRevision:0,correction:{memberId:'synthetic-member',activityId:receipt.activity_id,serviceDate:'2026-01-19',startLocal:'10:00',endLocal:'11:15',endNextDay:false,taskNotes:'Synthetic corrected'}});
   const voidRequest=await requestSelfAssertedHourCorrection(domain,'primary',{memberId:'00001',receiptId:receipt.id,message:'Synthetic void request',idempotencyKey:'synthetic-recovery-void'},now);
   await resolve(voidRequest.reference,{revision:0,action:'voided',note:'Synthetic duplicate removed',entryId:receipt.id,entryRevision:1});
   await submitStaffHours(domain,'primary','synthetic-admin',{...input,memberId:'synthetic-member',startLocal:'12:00',endLocal:'12:45',taskNotes:'Synthetic counted',idempotencyKey:'synthetic-recovery-counted'},now);
   await submitStaffHours(domain,'primary','synthetic-admin',{...input,memberId:'synthetic-member',startLocal:'13:00',endLocal:'13:30',taskNotes:'Synthetic adjacent counted',idempotencyKey:'synthetic-recovery-adjacent'},now);
  }finally{crypto.randomUUID=original;}
  // Opaque fixture strings are intentionally not decryptable credentials. Raw SQL
  // recovery preserves transient state; logical API backup normalization is separate.
  db.exec(`
   INSERT INTO public_hour_admission_clock VALUES('primary',1768932000000);
   INSERT INTO public_hour_admission VALUES('primary','synthetic-policy','synthetic-scope','synthetic-subject',1768931900000,1768932100000,2,5);
   INSERT INTO google_drive_feasibility VALUES('primary',2,'synthetic-project','synthetic-unusable-key','synthetic-root','Synthetic root','synthetic-drive-generation');
   INSERT INTO google_picker_intents VALUES('primary','synthetic-picker','synthetic-state','synthetic-admin','synthetic-session','synthetic-drive-generation',2,'source','claimed',1768932300000,'synthetic-opaque','synthetic-iv');
   INSERT INTO google_drive_proof_runs VALUES('primary','synthetic-proof','synthetic-admin','synthetic-drive-generation',1,'complete','synthetic-opaque','synthetic-iv',1768932000000);
   INSERT INTO discord_attachment_proofs VALUES('primary','synthetic-attachment','synthetic-member','synthetic-discord-user','synthetic-provider-iv','synthetic-drive-generation','synthetic-google-iv','synthetic-root',2,'saved','synthetic-submit',1768932300000,0,'synthetic-file','image/png',1,'synthetic-hash');
   INSERT INTO discord_documentation_drafts VALUES('primary','synthetic-note-draft','111111111111111111','222222222222222222','synthetic-provider-iv',2,1768932300000,'synthetic-note-confirmation','synthetic-opaque','synthetic-iv');
   INSERT INTO discord_documentation_file_drafts VALUES('primary','synthetic-file-draft','111111111111111111','222222222222222222','synthetic-provider-iv',2,1768932300000,'synthetic-file-confirmation','synthetic-opaque','synthetic-iv',NULL,0);
   INSERT INTO documentation_drive_copy_operations(installation_id,id,author_user_id,request_hash,key_hash,title,caption,source_id,source_version,source_json,activities_json,initiatives_json,section_revision,root_id,root_revision,connection_generation,connection_iv,state,dispatched,file_id,created_at,updated_at) VALUES('primary','synthetic-copy','synthetic-admin','synthetic-request','synthetic-key','Synthetic uncertain copy','','synthetic-source','1','{}','[]','[]',0,'synthetic-root',1,'synthetic-generation','synthetic-iv','reconciling',1,'synthetic-copy-file','2026-01-20','2026-01-20');
   INSERT INTO discord_hour_drafts VALUES('primary','synthetic-draft','111111111111111111','222222222222222222','synthetic-provider-iv','correction',2,1768932300000,'synthetic-confirmation','synthetic-opaque','synthetic-iv');
   INSERT INTO google_connections(installation_id,active_ciphertext,active_iv,updated_at) VALUES('primary','synthetic-opaque','synthetic-google-iv','2026-01-20');
   INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,updated_at,verified_at) VALUES('synthetic-discord','primary','discord','synthetic-opaque','synthetic-discord-iv','2026-01-20','2026-01-20');
   UPDATE installations SET discord_enabled=1,google_calendar_enabled=1;
   INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','synthetic-event-category','Synthetic events','event','2026-01-01','2026-01-01');
   INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('primary','synthetic-event','synthetic-event-category','event','2026-01-21','Synthetic private planning','UTC',0,'2026-01-01','2026-01-01');
  `);
  for(const provider of ['google','discord']){
   const content=JSON.stringify({title:'Synthetic public event',description:'Synthetic public description',location:'Synthetic venue',serviceDate:'2026-01-21',timeZone:'UTC',startsAt:provider==='google'?null:'2026-01-21T10:00:00Z',endsAt:provider==='google'?null:'2026-01-21T11:00:00Z'});
   const marker=(provider==='google'?'a':'b').repeat(32);
   db.prepare("INSERT INTO hours_publication_intents VALUES('primary','synthetic-event',?,1,2,1,0,0,'synthetic-admin',?,'2026-01-20')").run(provider,content);
   db.prepare("INSERT INTO hours_publication_generations VALUES('primary','synthetic-event',?,1,?,?,?, ?,?,0,'2026-01-20')").run(provider,'synthetic-'+provider+'-generation',provider==='google'?'synthetic-calendar':'111111111111111111',provider==='google'?'':'333333333333333333',marker,provider==='google'?'llh'+marker:null);
   db.prepare("INSERT INTO hours_publication_operations(installation_id,activity_id,provider,generation,action,revision,status,phase,snapshot_json,actor_user_id,activity_revision,attempts,lease_token,lease_expires_ms,updated_at) VALUES('primary','synthetic-event',?,1,'upsert',2,'processing',?,?,'synthetic-admin',0,1,'synthetic-expired-lease',1768932010000,'2026-01-20')").run(provider,provider==='google'?'known':'create_dispatched',content);
  }
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Synthetic graph invalid');
  db.exec(`INSERT INTO documentation_initiatives VALUES('primary','synthetic-initiative','Synthetic initiative','Synthetic shared narrative',0,0,'synthetic-admin','2026-01-20T00:00:00.000Z','2026-01-20T00:00:00.000Z');
   INSERT INTO documentation_initiative_activities VALUES('primary','synthetic-initiative','synthetic-event');
   INSERT INTO documentation_initiative_revisions VALUES('primary','synthetic-initiative',0,'synthetic-admin','Synthetic initiative','Synthetic shared narrative',0,'2026-01-20T00:00:00.000Z');
   INSERT INTO documentation_initiative_revision_activities VALUES('primary','synthetic-initiative',0,'synthetic-event');`);
  db.exec(`INSERT INTO documentation_metrics VALUES('primary','synthetic-metric','Synthetic metric','outcomes','1.2500','synthetic units','2026-01-01','2026-01-20','Synthetic source','Synthetic method','estimated',0,0,'synthetic-admin','2026-01-20T00:00:00.000Z','2026-01-20T00:00:00.000Z');
   INSERT INTO documentation_metric_revisions VALUES('primary','synthetic-metric',0,'synthetic-admin','Synthetic metric','outcomes','1.2500','synthetic units','2026-01-01','2026-01-20','Synthetic source','Synthetic method','estimated',0,'2026-01-20T00:00:00.000Z');
   INSERT INTO documentation_metric_activities VALUES('primary','synthetic-metric','synthetic-event');
   INSERT INTO documentation_metric_revision_activities VALUES('primary','synthetic-metric',0,'synthetic-event');
   INSERT INTO documentation_metric_initiatives VALUES('primary','synthetic-metric','synthetic-initiative');
   INSERT INTO documentation_metric_revision_initiatives VALUES('primary','synthetic-metric',0,'synthetic-initiative');`);
  db.exec(`INSERT INTO google_drive_storage VALUES('primary',1,'synthetic-root','Synthetic private root','synthetic-generation',NULL,NULL);
   INSERT INTO documentation_artifacts(installation_id,id,title,caption,url,original_url,archived,review_decision,reviewed_revision,reviewer_user_id,reviewed_at,revision,author_user_id,created_at,updated_at) VALUES('primary','synthetic-artifact','Synthetic link','Synthetic caption','https://example.invalid/evidence','https://example.invalid/evidence',0,'reviewed',0,'synthetic-admin','2026-01-20T01:00:00.000Z',1,'synthetic-admin','2026-01-20T00:00:00.000Z','2026-01-20T01:00:00.000Z');
   INSERT INTO documentation_artifact_revisions(installation_id,artifact_id,revision,actor_user_id,title,caption,url,original_url,archived,review_decision,reviewed_revision,reviewer_user_id,reviewed_at,created_at) VALUES('primary','synthetic-artifact',0,'synthetic-admin','Synthetic link','Synthetic caption','https://example.invalid/evidence','https://example.invalid/evidence',0,NULL,NULL,NULL,NULL,'2026-01-20T00:00:00.000Z');
   INSERT INTO documentation_artifact_revisions(installation_id,artifact_id,revision,actor_user_id,title,caption,url,original_url,archived,review_decision,reviewed_revision,reviewer_user_id,reviewed_at,created_at) VALUES('primary','synthetic-artifact',1,'synthetic-admin','Synthetic link','Synthetic caption','https://example.invalid/evidence','https://example.invalid/evidence',0,'reviewed',0,'synthetic-admin','2026-01-20T01:00:00.000Z','2026-01-20T01:00:00.000Z');
   INSERT INTO documentation_artifact_activities VALUES('primary','synthetic-artifact','synthetic-event');
   INSERT INTO documentation_artifact_initiatives VALUES('primary','synthetic-artifact','synthetic-initiative');
   INSERT INTO documentation_artifact_revision_activities VALUES('primary','synthetic-artifact',0,'synthetic-event'),('primary','synthetic-artifact',1,'synthetic-event');
   INSERT INTO documentation_artifact_revision_initiatives VALUES('primary','synthetic-artifact',0,'synthetic-initiative'),('primary','synthetic-artifact',1,'synthetic-initiative');
   INSERT INTO documentation_artifact_reviews VALUES('primary','synthetic-artifact',1,0,'synthetic-admin','reviewed','2026-01-20T01:00:00.000Z');`);
  db.exec(`INSERT INTO documentation_sections(installation_id,version,revision,notes_enabled,summary_enabled) VALUES('primary',1,2,1,1);
   INSERT INTO documentation_notes(installation_id,id,activity_id,author_member_id,source,text,archived,revision,created_at,updated_at) SELECT 'primary','synthetic-member-note','synthetic-event',id,'public','Synthetic member contribution',0,0,'2026-01-20T00:00:00.000Z','2026-01-20T00:00:00.000Z' FROM members WHERE installation_id='primary' ORDER BY id LIMIT 1;
   INSERT INTO documentation_note_revisions(installation_id,note_id,revision,actor_member_id,source,text,archived,created_at) SELECT installation_id,id,revision,author_member_id,source,text,archived,created_at FROM documentation_notes WHERE id='synthetic-member-note';
   INSERT INTO documentation_note_submission_keys SELECT installation_id,'public',lower(hex(zeroblob(32))),lower(hex(zeroblob(32))),id,created_at FROM documentation_notes WHERE id='synthetic-member-note';
   INSERT INTO public_documentation_admission_clock VALUES('primary',1);
   INSERT INTO public_documentation_admission VALUES('primary','read-v1','source-minute','synthetic-subject',0,60000,1,120);
   INSERT INTO documentation_notes(installation_id,id,activity_id,author_user_id,text,archived,revision,created_at,updated_at) VALUES('primary','synthetic-note','synthetic-event','synthetic-admin','Synthetic retained private note',0,0,'2026-01-20T00:00:00.000Z','2026-01-20T00:00:00.000Z');
   INSERT INTO documentation_note_revisions(installation_id,note_id,revision,actor_user_id,text,archived,created_at) VALUES('primary','synthetic-note',0,'synthetic-admin','Synthetic retained private note',0,'2026-01-20T00:00:00.000Z');`);
  db.exec(`INSERT INTO documentation_definitions VALUES('primary','synthetic-definition','Synthetic definition','Synthetic locally authored criterion','Synthetic source',0,0,'synthetic-admin','2026-01-20T00:00:00.000Z','2026-01-20T00:00:00.000Z');
   INSERT INTO documentation_definition_revisions VALUES('primary','synthetic-definition',0,'synthetic-admin','Synthetic definition','Synthetic locally authored criterion','Synthetic source',0,'2026-01-20T00:00:00.000Z');
   INSERT INTO hours_teams(installation_id,id,name,number,organization,program,historical_descriptors,created_at,updated_at) VALUES('primary','synthetic-team','Synthetic team','123','Synthetic organization','Synthetic program','Historical descriptor only','2026-01-20','2026-01-20');
   INSERT INTO documentation_claims VALUES('primary','synthetic-claim','Synthetic claim','synthetic-definition',0,'2026-01-01','2026-01-20','Synthetic rationale',0,'reviewed',0,'synthetic-admin','2026-01-20T01:00:00.000Z',1,'synthetic-admin','2026-01-20T00:00:00.000Z','2026-01-20T01:00:00.000Z');
   INSERT INTO documentation_claim_revisions VALUES('primary','synthetic-claim',0,'synthetic-admin','Synthetic claim','synthetic-definition',0,'2026-01-01','2026-01-20','Synthetic rationale',0,NULL,NULL,NULL,NULL,'2026-01-20T00:00:00.000Z');
   INSERT INTO documentation_claim_revisions VALUES('primary','synthetic-claim',1,'synthetic-admin','Synthetic claim','synthetic-definition',0,'2026-01-01','2026-01-20','Synthetic rationale',0,'reviewed',0,'synthetic-admin','2026-01-20T01:00:00.000Z','2026-01-20T01:00:00.000Z');
   INSERT INTO documentation_claim_reviews VALUES('primary','synthetic-claim',1,0,'synthetic-admin','reviewed','2026-01-20T01:00:00.000Z');
   INSERT INTO documentation_claim_revision_activities VALUES('primary','synthetic-claim',0,'synthetic-event',0),('primary','synthetic-claim',1,'synthetic-event',0);
   INSERT INTO documentation_claim_revision_teams VALUES('primary','synthetic-claim',0,'synthetic-team',0),('primary','synthetic-claim',1,'synthetic-team',0);
   INSERT INTO documentation_claim_revision_initiatives VALUES('primary','synthetic-claim',0,'synthetic-initiative',0),('primary','synthetic-claim',1,'synthetic-initiative',0);
   INSERT INTO documentation_claim_revision_artifacts VALUES('primary','synthetic-claim',0,'synthetic-artifact',0),('primary','synthetic-claim',1,'synthetic-artifact',0);
   INSERT INTO documentation_claim_revision_metrics VALUES('primary','synthetic-claim',0,'synthetic-metric',0),('primary','synthetic-claim',1,'synthetic-metric',0);
  `);
  const snapshot=capture(db);return {db,migrations,snapshot,digest:sha(canonical(snapshot)),tables:Object.keys(snapshot.rows),tableOrder:tableOrder(db,Object.keys(snapshot.rows))};
 }catch(error){db.close();throw error;}
}
const literal=value=>value===null?'NULL':typeof value==='number'?String(value):"'"+String(value).replaceAll("'","''")+"'";
export function modelSQL(snapshot,orderedTables){
 const names=Object.keys(snapshot.rows);if(!Array.isArray(orderedTables)||orderedTables.length!==names.length||new Set(orderedTables).size!==names.length||names.some(name=>!orderedTables.includes(name)))throw Error('Canonical SQL requires the complete reviewed table order');
 const definitions=snapshot.schema.filter(r=>r.sql);const tables=definitions.filter(r=>r.type==='table').sort((a,b)=>orderedTables.indexOf(a.name)-orderedTables.indexOf(b.name));const indexes=definitions.filter(r=>r.type==='index');const rest=definitions.filter(r=>r.type!=='table'&&r.type!=='index');
 return Buffer.from(['PRAGMA defer_foreign_keys=TRUE;',...tables.map(r=>r.sql+';'),...indexes.map(r=>r.sql+';'),...orderedTables.flatMap(name=>snapshot.rows[name].map(row=>'INSERT INTO '+quote(name)+' ('+Object.keys(row).map(quote).join(',')+') VALUES ('+Object.values(row).map(literal).join(',')+');')),...rest.map(r=>r.sql+';')].join('\n'));
}
export function tableOrder(db,tables){const ordered=[],visiting=new Set(),done=new Set();function visit(name){if(done.has(name))return;if(visiting.has(name))throw Error('Schema dependency cycle requires review');visiting.add(name);for(const row of db.prepare('PRAGMA foreign_key_list('+quote(name)+')').all())if(row.table!==name)visit(row.table);visiting.delete(name);done.add(name);ordered.push(name);}tables.forEach(visit);return ordered;}
export function cleanupSQL(model){return 'PRAGMA defer_foreign_keys=TRUE;\n'+model.snapshot.schema.filter(r=>r.type==='trigger').map(r=>'DROP TRIGGER '+quote(r.name)+';').join('\n')+'\n'+[...model.tableOrder].reverse().map(name=>'DROP TABLE '+quote(name)+';').join('\n')+'\n';}
// Let SQLite parse the real export, but deny filesystem, virtual tables, arbitrary
// functions, foreign objects and data mutation. Exact final schema/data must match.
export function validateExport(bytes,model){
 if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>LIMIT)throw Error('Export exceeds reviewed bound');
 const db=new DatabaseSync(':memory:',{enableForeignKeyConstraints:false});db.exec('BEGIN');const tables=new Set(model.tables),objects=new Set(model.snapshot.schema.map(r=>r.name));let calls=0;
 db.setAuthorizer((code,a,b)=>{
  if(++calls>100000)return C.SQLITE_DENY;
  if(code===C.SQLITE_CREATE_TABLE)return tables.has(a)?C.SQLITE_OK:C.SQLITE_DENY;
  if(code===C.SQLITE_CREATE_INDEX||code===C.SQLITE_CREATE_TRIGGER)return (objects.has(a)||code===C.SQLITE_CREATE_INDEX&&a.startsWith('sqlite_autoindex_'))&&tables.has(b)?C.SQLITE_OK:C.SQLITE_DENY;
  if(code===C.SQLITE_INSERT)return tables.has(a)||a==='sqlite_master'?C.SQLITE_OK:C.SQLITE_DENY;
  if(code===C.SQLITE_UPDATE)return a==='sqlite_master'?C.SQLITE_OK:C.SQLITE_DENY;
  if(code===C.SQLITE_READ)return tables.has(a)||a==='sqlite_master'?C.SQLITE_OK:C.SQLITE_DENY;
  if(code===C.SQLITE_PRAGMA)return a==='defer_foreign_keys'&&['TRUE','ON','1'].includes(String(b).toUpperCase())?C.SQLITE_OK:C.SQLITE_DENY;
  if(code===C.SQLITE_TRANSACTION)return C.SQLITE_DENY;
  if(code===C.SQLITE_FUNCTION)return ['length','typeof','json_valid','coalesce','trim'].includes(b)?C.SQLITE_OK:C.SQLITE_DENY;
  if(code===C.SQLITE_REINDEX)return objects.has(a)?C.SQLITE_OK:C.SQLITE_DENY;
  return C.SQLITE_DENY;
 });
 try{
  const statements=unstable_splitSqlQuery(bytes.toString('utf8'));if(statements.length>1000)throw Error('Export statement bound');
  for(const statement of statements)db.exec(statement);
  db.setAuthorizer(null);db.exec('COMMIT');const parsed=capture(db);const missing=model.snapshot.schema.filter(expected=>!parsed.schema.some(actual=>actual.name===expected.name));
  if(canonical(parsed.rows)!==canonical(model.snapshot.rows)||missing.some(r=>r.type==='table')||parsed.schema.some(actual=>!model.snapshot.schema.some(expected=>canonical(expected)===canonical(actual))))throw Error('Export differs from exact synthetic application');
  // Pinned D1 table-filtered exports can omit indexes/triggers. Reconstruct only
  // those exact missing objects from the hash-pinned migration-derived model.
  for(const object of missing)db.exec(object.sql);
  if(db.prepare('PRAGMA foreign_key_check').all().length||sha(canonical(capture(db)))!==model.digest)throw Error('Export graph differs from synthetic model');
  return {sha256:sha(bytes),bytes:bytes.length,snapshot:capture(db),reconstructedObjects:missing.map(r=>r.name)};
 }catch(error){throw Error('Export SQL rejected by synthetic schema/data validation',{cause:error});}finally{db.close();}
}
export function operationalProbes(model){const rows=model.snapshot.rows;const counted=rows.hours_entries.find(r=>r.status==='counted');const voided=rows.hours_entries.find(r=>r.status==='void');const request=rows.hours_correction_requests[0];return [
 {name:'publication-in-flight',error:'hours_publication_in_flight',sql:"DELETE FROM installations WHERE id='primary'"},
 {name:'immutable-history',error:'hours_revision_immutable',sql:'UPDATE hours_entry_revisions SET reason=\'synthetic-tamper\' WHERE entry_id='+literal(voided.id)},
 {name:'immutable-receipt',error:'hours_receipt_immutable',sql:"UPDATE hours_submission_keys SET receipt='{}'"},
 {name:'terminal-void',error:'hours_entry_provenance',sql:'UPDATE hours_entries SET revision=revision+1 WHERE id='+literal(voided.id)},
 {name:'overlap',error:'hours_overlap',sql:'INSERT INTO hours_entries ('+Object.keys(counted).map(quote).join(',')+') VALUES ('+Object.entries(counted).map(([k,v])=>literal(k==='id'?'synthetic-overlap-probe':v)).join(',')+')'},
 {name:'overlap-update',error:'hours_overlap',sql:'UPDATE hours_entries SET revision=revision+1,end_ms=end_ms+1800000,duration_minutes=duration_minutes+30 WHERE id='+literal(counted.id)},
 {name:'activity-history-date',error:'hours_activity_date_history',sql:"UPDATE hours_activities SET service_date='2026-01-18' WHERE id="+literal(voided.activity_id)},
 {name:'immutable-request',error:'hours_request_immutable',sql:"UPDATE hours_correction_requests SET message='synthetic-tamper' WHERE id="+literal(request.id)},
 {name:'immutable-resolution',error:'hours_resolution_immutable',sql:"UPDATE hours_correction_resolutions SET note='synthetic-tamper'"},
 ];}
