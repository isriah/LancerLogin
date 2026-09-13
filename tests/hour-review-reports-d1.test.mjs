import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {migrationStatements} from './migration-statements.mjs';
import worker from '../apps/api/src/index.ts';
import {createSessionCodec} from '../apps/api/src/runtime-security.ts';
import {submitStaffHours,accountingRoute} from '../apps/api/src/hour-accounting.ts';
import {requestSelfAssertedHourCorrection as publicRequest,requestLinkedDiscordHourCorrection as discordRequest,hourReviewRoute} from '../apps/api/src/hour-review-reports.ts';
const migrations=new URL('../apps/api/migrations/',import.meta.url),key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',now=Date.parse('2026-01-20T18:00:00Z');
const reject=(promise,status)=>assert.rejects(promise,e=>e.status===status);

test('actual D1 correction intake, atomic review, snapshot reports and installation preservation',{timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 try{
 const db=await mf.getD1Database('DB');for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort())await db.batch((name==='0034_hour_review.sql'?unstable_splitSqlQuery:migrationStatements)(readFileSync(new URL(name,migrations),'utf8')).map(s=>db.prepare(s)));
 await db.batch([
  db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'),('foreign','2026-01-01','local')"),
  db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic','UTC')"),
  db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-01-01'),('staff','primary','staff','staff','2026-01-01'),('operator','primary','operator','operator','2026-01-01')"),
  db.prepare("INSERT INTO platform_module_configuration(installation_id,hours_enabled) VALUES('primary',1),('foreign',1)"),
  db.prepare("INSERT INTO platform_module_grants(installation_id,user_id,hours_manage) VALUES('primary','staff',1)"),
  db.prepare("INSERT INTO hours_entry_settings(installation_id) VALUES('primary')"),
  db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,discord_user_id,created_at) VALUES('m1','primary','00123','Synthetic','One','123456789012345678','2026-01-01'),('m2','primary','00456','Synthetic','Two',null,'2026-01-01'),('m3','primary','00789','Synthetic','Three',null,'2026-01-01'),('foreign','foreign','00123','Synthetic','Foreign',null,'2026-01-01')"),
  db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','task','Task','task','2026-01-01','2026-01-01'),('primary','team','Team','team','2026-01-01','2026-01-01')"),
  db.prepare("INSERT INTO hours_teams(installation_id,id,name,created_at,updated_at) VALUES('primary','team1','Synthetic','2026-01-01','2026-01-01')"),
 ]);
 const env={DB:db,SESSION_KEY:key,APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.test'};
 const http=async(path,body,method=body?'POST':'GET',actor='admin')=>worker.fetch(new Request('https://fixture.test'+path,{method,headers:{cookie:'lancerlogin_session='+await createSessionCodec(key).issue({userId:actor,role:'admin'}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
 const good=async(path,body,method)=>{const response=await http(path,body,method);assert.ok(response.ok,await response.clone().text());return response.json();};
 const route=async(path,body,database=db,actor='staff')=>(await hourReviewRoute(database,'primary',actor,new Request('https://fixture.test/admin/hours/'+path,{method:body?'POST':'GET'}),body,now)).body;
 let sequence=0;const request=(extra={},database=db)=>publicRequest(database,'primary',{memberId:'00123',message:'Synthetic correction claim',idempotencyKey:'synthetic-request-'+(++sequence),...extra},now);
 const claim={memberId:'00123',receiptId:'unknown-receipt',activityId:'unknown-activity',serviceDate:'2026-01-19',message:'Private synthetic claim',idempotencyKey:'synthetic-identical-retry'};
 const acks=await Promise.all([publicRequest(db,'primary',claim,now),publicRequest(db,'primary',claim,now)]);assert.deepEqual(acks[0],acks[1]);assert.deepEqual(Object.keys(acks[0]).sort(),['accepted','reference']);
 await reject(publicRequest(db,'primary',{...claim,message:'different'},now),409);
 const unknown=await request({memberId:'does-not-exist'});assert.deepEqual(Object.keys(unknown).sort(),['accepted','reference']);assert.equal((await route('correction-requests/'+unknown.reference)).requesterMemberId,null);
 const discord=await discordRequest(db,'primary','123456789012345678',{message:'Linked claim',idempotencyKey:'synthetic-discord-retry'},now);
 assert.equal((await route('correction-requests/'+discord.reference)).attribution,'linked_discord');
 await reject(discordRequest(db,'primary','not-paired',{message:'Unlinked',idempotencyKey:'synthetic-unlinked'},now),403);
 await reject(discordRequest(db,'primary','123456789012345678',{memberId:'00456',message:'Forged',idempotencyKey:'synthetic-forged'},now),400);
 let pairRace=false;const unpair={prepare:s=>db.prepare(s),batch:async statements=>{if(!pairRace){pairRace=true;await db.prepare("UPDATE members SET discord_user_id=null WHERE id='m1'").run();}return db.batch(statements);}};
 await reject(discordRequest(unpair,'primary','123456789012345678',{message:'Pair raced',idempotencyKey:'synthetic-raced-pair'},now),403);
 assert.deepEqual(await discordRequest(db,'primary','123456789012345678',{message:'Linked claim',idempotencyKey:'synthetic-discord-retry'},now),discord);
 await db.prepare("UPDATE members SET discord_user_id='123456789012345678' WHERE id='m1'").run();
 const firstPayload={memberId:'m1',categoryId:'task',serviceDate:'2026-01-19',startLocal:'09:00',endLocal:'10:00',endNextDay:false,idempotencyKey:'synthetic-entry-first'};
 const first=await submitStaffHours(db,'primary','staff',firstPayload,now);
 const second=await submitStaffHours(db,'primary','staff',{...firstPayload,memberId:'m2',idempotencyKey:'synthetic-entry-second'},now);
 await submitStaffHours(db,'primary','staff',{...firstPayload,categoryId:'team',teamId:'team1',serviceDate:'2026-01-18',idempotencyKey:'synthetic-entry-team'},now);
 assert.equal((await http('/admin/hours/reports?from=2023-01-01&to=2026-01-20')).status,200);assert.equal((await http('/admin/hours/correction-requests',undefined,'GET','operator')).status,403);
 const initialReport=await route('reports?from=2023-01-01&to=2026-01-20&groupBy=activity');assert.deepEqual(initialReport.totals,{minutes:180,entryCount:3,distinctParticipants:2});assert.equal(initialReport.items.reduce((sum,r)=>sum+r.distinctParticipants,0),3);
 assert.deepEqual((await route('reports?from=2026-01-18&to=2026-01-20&teamId=team1')).totals,{minutes:60,entryCount:1,distinctParticipants:1});
 const teams=await route('reports?from=2026-01-18&to=2026-01-20&groupBy=team&limit=1');assert.equal(teams.items[0].id,null);assert.equal(teams.nextCursor,'0');assert.equal((await route('reports?from=2026-01-18&to=2026-01-20&groupBy=team&after=0')).items[0].id,'team1');
 for(const params of ['', '?from=2026-01-20&to=2026-01-19','?from=2000-01-01&to=2026-01-01','?from=2026-01-01&to=2026-01-20&limit=101','?from=2026-01-01&to=2026-01-20&groupBy=__proto__','?from=2026-01-01&to=2026-01-20&from=2026-01-02'])await reject(route('reports'+params),400);
 assert.equal((await route('reports?from=0000-01-01&to=0000-01-01')).totals.minutes,0);assert.equal((await route('reports?from=9999-12-31&to=9999-12-31')).totals.minutes,0);
 const review=await request();const resolve={revision:0,action:'corrected',note:'Correct duration after staff review',entryId:first.id,entryRevision:0,correction:{endLocal:'11:00'}};
 const outcomes=await Promise.allSettled([route('correction-requests/'+review.reference+'/resolve',resolve),route('correction-requests/'+review.reference+'/resolve',resolve)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.find(r=>r.status==='rejected').reason.status,409);
 const detail=await route('correction-requests/'+review.reference);assert.equal(detail.resolution.entryRevision,1);assert.equal(detail.resolution.action,'corrected');assert.equal(detail.message,'Synthetic correction claim');assert.equal('fingerprint'in detail,false);
 assert.equal((await route('correction-requests/'+review.reference+'/history')).items.length,2);
 assert.deepEqual(await submitStaffHours(db,'primary','staff',firstPayload,now),first);
 // Failed accounting change must leave the request, history and audit unchanged.
 const overlap=await request();await reject(route('correction-requests/'+overlap.reference+'/resolve',{...resolve,entryRevision:1,correction:{memberId:'m2'}}),409);assert.equal((await route('correction-requests/'+overlap.reference)).status,'open');
 const stale=await request();await reject(route('correction-requests/'+stale.reference+'/resolve',{revision:0,action:'acknowledged',note:'Stale match',entryId:first.id,entryRevision:0}),409);
 await route('correction-requests/'+stale.reference+'/resolve',{revision:0,action:'acknowledged',note:'Reviewed current entry',entryId:first.id,entryRevision:1});
 // A resolution insert failure rolls back entry/revision/request/audit, not merely the response.
 const rollback=await request();await db.prepare("CREATE TRIGGER synthetic_review_failure BEFORE INSERT ON hours_correction_resolutions WHEN NEW.request_id='"+rollback.reference+"' BEGIN SELECT RAISE(ABORT,'synthetic_review_failure'); END").run();
 await assert.rejects(route('correction-requests/'+rollback.reference+'/resolve',{revision:0,action:'voided',note:'Synthetic rollback',entryId:first.id,entryRevision:1}));
 assert.equal((await db.prepare('SELECT revision FROM hours_entries WHERE id=?').bind(first.id).first()).revision,1);assert.equal((await route('correction-requests/'+rollback.reference)).status,'open');await db.prepare('DROP TRIGGER synthetic_review_failure').run();
 // Snapshot report: mutation after the read batch cannot tear global/group counts.
 let injected=false;const snapshot={prepare:s=>db.prepare(s),batch:async statements=>{const rows=await db.batch(statements);if(!injected){injected=true;await accountingRoute(db,'primary','staff',new Request('https://fixture.test/admin/hours/entries/'+second.id+'/void',{method:'POST'}),{revision:0,reason:'Synthetic snapshot mutation'},now);}return rows;}};
 const before=await route('reports?from=2026-01-18&to=2026-01-20',undefined,snapshot);assert.equal(before.totals.minutes,240);assert.equal(before.items.reduce((sum,r)=>sum+r.minutes,0),240);assert.equal((await route('reports?from=2026-01-18&to=2026-01-20')).totals.minutes,180);
 const voided=await route('correction-requests/'+rollback.reference+'/resolve',{revision:0,action:'voided',note:'Confirmed duplicate',entryId:first.id,entryRevision:1});assert.equal(voided.entry.status,'void');
 assert.equal((await route('correction-requests/'+stale.reference)).resolution.entryRevision,1);assert.deepEqual(await publicRequest(db,'primary',claim,now),acks[0]);
 const terminal=await route('correction-requests/'+acks[0].reference+'/resolve',{revision:0,action:'dismissed',note:'Insufficient details'});assert.equal(terminal.status,'resolved');assert.deepEqual(await publicRequest(db,'primary',claim,now),acks[0]);
 await assert.rejects(db.prepare('UPDATE hours_correction_requests SET message=message').run(),/hours_request_immutable/);await assert.rejects(db.prepare('UPDATE hours_correction_resolutions SET note=note').run(),/hours_resolution_immutable/);
 const archived=await request({memberId:'00789'});await db.prepare("UPDATE members SET active=0 WHERE id='m3'").run();await assert.rejects(db.prepare("DELETE FROM members WHERE id='m3'").run(),/FOREIGN KEY/);
 assert.equal((await http('/admin/members/m3',{confirmation:'DELETE MEMBER 00789'},'DELETE')).status,409);
 const foreign=await publicRequest(db,'foreign',{memberId:'00123',message:'Foreign',idempotencyKey:'synthetic-foreign-request'},now);await reject(route('correction-requests/'+foreign.reference),404);
 await reject(route('correction-requests',undefined,db,'operator'),403);
 let revoked=false;const revoke={prepare:s=>db.prepare(s),batch:async statements=>{if(!revoked){revoked=true;await db.prepare("UPDATE platform_module_grants SET hours_manage=0 WHERE user_id='staff'").run();}return db.batch(statements);}};
 await reject(route('correction-requests/'+archived.reference+'/resolve',{revision:0,action:'acknowledged',note:'Raced access'},revoke),409);await db.prepare("UPDATE platform_module_grants SET hours_manage=1 WHERE user_id='staff'").run();
 // Export remains coherent when review resolves immediately after its snapshot.
 let exportMutated=false;const exportMutation=async()=>{if(!exportMutated){exportMutated=true;await route('correction-requests/'+archived.reference+'/resolve',{revision:0,action:'acknowledged',note:'Synthetic export mutation'});}};
 const wrap=(sql,args=[])=>{const raw=db.prepare(sql).bind(...args);return {raw,bind:(...v)=>wrap(sql,v),first:()=>raw.first(),run:()=>raw.run(),all:async()=>{const rows=await raw.all();if(/FROM hours_correction_requests\b/.test(sql))await exportMutation();return rows;}};};
 env.DB={prepare:sql=>wrap(sql),batch:async statements=>{const rows=await db.batch(statements.map(s=>s.raw));await exportMutation();return rows;}};
 const backup=await good('/admin/data/backup?scope=installation');env.DB=db;assert.equal(exportMutated,true);assert.equal(backup.tables.hours_correction_requests.find(r=>r.id===archived.reference).status,'open');assert.equal(backup.tables.hours_correction_resolutions.some(r=>r.request_id===archived.reference),false);assert.equal(backup.schemaVersion,28);assert.ok(backup.tables.hours_correction_requests.length);assert.ok(backup.tables.hours_correction_resolutions.length);
 for(const damage of [b=>b.tables.hours_correction_resolutions.pop(),b=>b.tables.hours_correction_requests[0].requester_member_id='foreign',b=>b.tables.hours_correction_resolutions[0].entry_revision=999,b=>b.tables.hours_correction_requests[0].fingerprint='invalid']){const invalid=structuredClone(backup);damage(invalid);assert.equal((await http('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:invalid})).status,400);}
 await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup});
 const meetingBackup=await good('/admin/data/backup?scope=meetings');await good('/admin/data',{scope:'attendance',confirmation:'DELETE ATTENDANCE'},'DELETE');await good('/admin/data/restore',{scope:'meetings',confirmation:'RESTORE MEETINGS',backup:meetingBackup});
 assert.deepEqual((await db.prepare("SELECT * FROM hours_correction_requests WHERE installation_id='primary' ORDER BY id").all()).results,backup.tables.hours_correction_requests.slice().sort((a,b)=>a.id.localeCompare(b.id)));
 assert.equal((await http('/admin/data',{scope:'roster',confirmation:'DELETE ROSTER'},'DELETE')).status,409);
 const readRevoke={prepare:s=>db.prepare(s),batch:async statements=>{const rows=await db.batch(statements);await db.prepare("UPDATE platform_module_grants SET hours_manage=0 WHERE user_id='staff'").run();return rows;}};
 await reject(route('reports?from=2026-01-01&to=2026-01-20',undefined,readRevoke),403);await db.prepare("UPDATE platform_module_grants SET hours_manage=1 WHERE user_id='staff'").run();
 assert.deepEqual(await publicRequest(db,'primary',claim,now),acks[0]);assert.equal((await route('correction-requests/'+rollback.reference)).resolution.action,'voided');
 await db.prepare("UPDATE platform_module_configuration SET hours_enabled=0 WHERE installation_id='primary'").run();await reject(route('reports?from=2026-01-01&to=2026-01-20'),403);await reject(request(),403);const disabled=await good('/admin/data/backup?scope=installation');assert.deepEqual(disabled.tables.hours_correction_requests,backup.tables.hours_correction_requests);
 const legacy=structuredClone(backup);legacy.schemaVersion=18;delete legacy.tables.hours_correction_requests;delete legacy.tables.hours_correction_resolutions;await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:legacy});assert.equal((await db.prepare("SELECT count(*) n FROM hours_correction_requests WHERE installation_id='primary'").first()).n,0);
 }finally{await mf.dispose();}
});
