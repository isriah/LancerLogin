import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import worker from '../apps/api/src/index.ts';
import {deriveHoursProxyKey,createHoursAssertion,HOURS_ASSERTION_HEADER} from '../packages/shared/src/hours-proxy.ts';
import {publicHours} from '../apps/api/src/public-hours.ts';
import {admitPublicHours,readPublicHourJson} from '../apps/api/src/public-hour-admission.ts';
import {accountingRoute,submitLinkedDiscordHours} from '../apps/api/src/hour-accounting.ts';
import {createSessionCodec} from '../apps/api/src/runtime-security.ts';
const now=Date.parse('2026-01-20T18:00:00Z'),secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',origin='https://fixture.test';
const failure=(p,status)=>assert.rejects(p,e=>e.status===status);

test('public JSON streaming ceiling cancels oversize/chunked input and refuses malformed or unsupported bodies',async()=>{
 let canceled=false;const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(9000));},cancel(){canceled=true;}});
 await failure(readPublicHourJson(new Request(origin,{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'})),413);assert.equal(canceled,true);
 for(const [body,type,status] of [['{}','text/plain',415],['{','application/json',400]])await failure(readPublicHourJson(new Request(origin,{method:'POST',headers:{'content-type':type},body})),status);
 await failure(readPublicHourJson(new Request(origin,{method:'POST',headers:{'content-type':'application/json'},body:new Uint8Array([255])})),400);
 let timedOutCanceled=false;const slow=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){timedOutCanceled=true;}});await failure(readPublicHourJson(new Request(origin,{method:'POST',headers:{'content-type':'application/json'},body:slow,duplex:'half'}),10),408);assert.equal(timedOutCanceled,true);
 assert.deepEqual(await readPublicHourJson(new Request(origin,{method:'POST',headers:{'content-type':'application/json; charset=utf-8'},body:'{"ok":true}'})),{ok:true});
});

test('public production adapter and actual D1 admission preserve eligibility, privacy, retries and transient lifecycle',{timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 try{
 const db=await mf.getD1Database('DB');for(const name of readdirSync(new URL('../apps/api/migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(readFileSync(new URL('../apps/api/migrations/'+name,import.meta.url),'utf8')).map(s=>db.prepare(s)));
 await db.batch([
  db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'),('foreign','2026-01-01','local')"),
  db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic','UTC')"),
  db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-01-01')"),
  db.prepare("INSERT INTO platform_module_configuration(installation_id,hours_enabled) VALUES('primary',1),('foreign',0)"),
  db.prepare("INSERT INTO hours_entry_settings(installation_id) VALUES('primary')"),
  db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,discord_user_id,active,created_at) VALUES('m1','primary','00123','Private','Name','123456789012345678',1,'2026-01-01'),('m2','primary','00456','Private','Archived',null,0,'2026-01-01')"),
  db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','event','Event','event','2026-01-01','2026-01-01'),('primary','task','Task','task','2026-01-01','2026-01-01'),('primary','team','Team Support','team','2026-01-01','2026-01-01')"),
  db.prepare("INSERT INTO hours_teams(installation_id,id,name,number,program,organization,historical_descriptors,created_at,updated_at) VALUES('primary','team1','Synthetic','001','FRC','Private organization','Private historical claim','2026-01-01','2026-01-01')"),
  ...[['event1','2026-01-20'],['event-old','2020-01-01'],['event-future','2026-01-21']].map(([id,day])=>db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,description,location,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('primary',?,'event','event',?,'Synthetic event','Private description','Private location','UTC',0,'2026-01-01','2026-01-01')").bind(id,day)),
 ]);
 const env={DB:db,SESSION_KEY:secret,APP_MODE:'configured',ALLOWED_ORIGIN:origin};
 const call=(path,body,extra={},at=now)=>publicHours(new Request(origin+'/public/hours/'+path,{method:body?'POST':'GET',headers:{origin,'content-type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})}),env,'primary',()=>at);
 const good=async(path,body,extra,at)=>{const r=await call(path,body,extra,at);assert.ok(r.ok,await r.clone().text());assert.equal(r.headers.get('cache-control'),'no-store');return r.json();};
 assert.equal((await worker.fetch(new Request(origin+'/public/hours/context'),env)).status,200);
 // The real-clock smoke above is isolated from the deterministic clock/admission tests.
 await db.batch([db.prepare('DELETE FROM public_hour_admission'),db.prepare('DELETE FROM public_hour_admission_clock')]);
 assert.deepEqual(await good('context'),{available:true,timeZone:'UTC',today:'2026-01-20',earliestServiceDate:'2026-01-14',reportingDays:7});
 const categories=await good('categories?limit=1');assert.deepEqual(Object.keys(categories.items[0]).sort(),['id','mode','name']);assert.ok(categories.nextCursor);
 assert.deepEqual((await good('teams')).items,[{id:'team1',name:'Synthetic',number:'001',program:'FRC'}]);assert.equal((await good('teams?q=%25')).items.length,0);
 assert.deepEqual((await good('events')).items,[{id:'event1',categoryId:'event',title:'Synthetic event',serviceDate:'2026-01-20'}]);
 for(const path of ['events?limit=101','events?date=2026-02-30','teams?email=x','categories?limit=1&limit=2','entries/id','members'])assert.ok([400,404,405].includes((await call(path)).status));
 let key=0;const payload={memberId:'00123',activityId:'event1',serviceDate:'2026-01-20',startLocal:'09:00',endLocal:'10:00',endNextDay:false,expectedTimeZone:'UTC',idempotencyKey:'synthetic-public-first'};
 for(const invalid of ['https://foreign.test','null',''])assert.equal((await call('entries',payload,{origin:invalid})).status,403);
 const receipts=await Promise.all([good('entries',payload),good('entries',payload)]);assert.deepEqual(receipts[0],receipts[1]);assert.equal(receipts[0].duration_minutes,60);assert.equal('member_id'in receipts[0],false);assert.equal(JSON.stringify(receipts[0]).includes('Private'),false);
 const overlap=await(await call('entries',{...payload,idempotencyKey:'synthetic-public-overlap'})).json();
 for(const memberId of ['unknown','00456','123'])assert.deepEqual(await(await call('entries',{...payload,memberId,idempotencyKey:'synthetic-invalid-'+(++key)})).json(),overlap);
 assert.equal(overlap.correctionAvailable,true);
 await accountingRoute(db,'primary','admin',new Request(origin+'/admin/hours/entries/'+receipts[0].id+'/void',{method:'POST'}),{revision:0,reason:'Synthetic correction'},now);
 assert.deepEqual(await good('entries',payload),receipts[0]);
 const correction={memberId:'unknown',receiptId:'unknown-receipt',message:'Synthetic claim',idempotencyKey:'synthetic-public-correction'};const ack=await good('correction-requests',correction);assert.deepEqual(Object.keys(ack).sort(),['accepted','reference']);assert.deepEqual(await good('correction-requests',correction),ack);
 const concurrent=await Promise.allSettled([good('entries',{...payload,startLocal:'11:00',endLocal:'12:00',idempotencyKey:'synthetic-race-public'}),submitLinkedDiscordHours(db,'primary','123456789012345678',{activityId:'event1',startLocal:'11:00',endLocal:'12:00',endNextDay:false,expectedTimeZone:'UTC',idempotencyKey:'synthetic-race-discord'},now)]);assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await call('entries',{...payload,serviceDate:undefined,idempotencyKey:'synthetic-missing-date'})).status,400);assert.equal((await call('entries',{...payload,serviceDate:'2026-01-19',idempotencyKey:'synthetic-stale-event-date'})).status,409);
 assert.equal((await call('entries',{...payload,expectedTimeZone:'America/New_York',idempotencyKey:'synthetic-stale-zone'})).status,409);
 assert.equal((await call('entries',{...payload,channel:'staff',idempotencyKey:'synthetic-forge-staff'})).status,409);
 await db.prepare("INSERT INTO hours_reopen_windows(installation_id,id,activity_id,starts_ms,expires_ms,actor_user_id,created_at) VALUES('primary','window',null,?,?,'admin','2026-01-20')").bind(now,now+1000).run();
 assert.equal((await good('events')).items.some(r=>r.id==='event-old'),true);
 assert.equal((await call('entries',{...payload,activityId:'event-old',serviceDate:'2020-01-01',idempotencyKey:'synthetic-open-old'})).status,201);
 let clockReads=0;const delayed=new Request(origin+'/public/hours/entries',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({...payload,activityId:'event-old',serviceDate:'2020-01-01',startLocal:'14:00',endLocal:'15:00',idempotencyKey:'synthetic-delayed-body'})});const delayedResult=await publicHours(delayed,env,'primary',()=>clockReads++===0?now:now+2000);assert.equal(delayedResult.status,409);assert.equal((await db.prepare("SELECT count(*) n FROM hours_entries WHERE activity_id='event-old'").first()).n,1);
 assert.equal((await call('entries',{...payload,activityId:undefined,categoryId:'task',serviceDate:'2020-01-01',idempotencyKey:'synthetic-old-task'})).status,409);
 assert.equal((await good('events',undefined,undefined,now+1000)).items.some(r=>r.id==='event-old'),false);
 await db.prepare("UPDATE members SET active=0 WHERE id='m1'").run();assert.deepEqual(await good('entries',payload),receipts[0]);assert.equal((await call('entries',{...payload,idempotencyKey:'synthetic-archived-new'})).status,409);await db.prepare("UPDATE members SET active=1 WHERE id='m1'").run();
 // All untrusted address variations share fallback admission; no spoofable source lane.
 await db.batch([db.prepare('DELETE FROM public_hour_admission'),db.prepare('DELETE FROM public_hour_admission_clock')]);
 const proxyKey=await deriveHoursProxyKey(secret,'primary',origin,origin);
 const signed=async(ip,stamp=now)=>{
  const request=new Request(origin+'/public/hours/context');request.headers.set(HOURS_ASSERTION_HEADER,await createHoursAssertion(request,proxyKey,origin,origin,ip,new Uint8Array(),stamp));return request;
 };
 const replay=await signed('192.0.2.1');
 assert.equal((await publicHours(replay.clone(),env,'primary',()=>now)).status,200);
 await db.prepare("UPDATE public_hour_admission SET attempts=119 WHERE policy='read-v1' AND scope='source-minute'").run();
 assert.equal((await publicHours(replay.clone(),env,'primary',()=>now)).status,200);
 assert.equal((await publicHours(replay.clone(),env,'primary',()=>now)).status,429,'exact transport replay consumes source quota');
 assert.equal((await publicHours(await signed('192.0.2.2'),env,'primary',()=>now)).status,200,'separate authenticated source remains available');
 assert.equal((await call('context')).status,200,'unverified fallback remains separate');
 let freshnessReads=0;const expiredDuringRead=await signed('192.0.2.3');
 const expiryResult=await publicHours(expiredDuringRead,env,'primary',()=>freshnessReads++===0?now:now+31001);assert.equal(expiryResult.status,200);
 const stale=await signed('192.0.2.3',now-30001);assert.equal((await publicHours(stale,env,'primary',()=>now+31001)).status,200);
 assert.equal((await db.prepare("SELECT count(*) n FROM public_hour_admission WHERE scope='source-minute'").first()).n,3,'stale assertion charged shared fallback, never a new claimed source');
 await db.batch([db.prepare('DELETE FROM public_hour_admission'),db.prepare('DELETE FROM public_hour_admission_clock')]);
 const results=await Promise.allSettled(Array.from({length:35},()=>admitPublicHours(db,'primary',secret,'mutation',now)));assert.equal(results.filter(r=>r.status==='fulfilled').length,30);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===429).length,5);
 const counters=(await db.prepare('SELECT * FROM public_hour_admission').all()).results;assert.equal(counters.length,4);assert.ok(counters.every(r=>r.attempts===30&&/^[a-f0-9]{64}$/.test(r.subject_hash)));
 const denied=await call('entries',payload,{'cf-connecting-ip':'192.0.2.55','x-forwarded-for':'198.51.100.2','x-real-ip':'203.0.113.3'});assert.equal(denied.status,429);assert.ok(Number(denied.headers.get('retry-after'))>0);assert.equal(JSON.stringify(counters).includes('192.0.2'),false);
 await admitPublicHours(db,'primary',secret,'mutation',now+60000);await failure(admitPublicHours(db,'primary',secret,'mutation',now),503);
 // In-flight requests may arrive out of order. Retain expired buckets for the full tolerance,
 // so late requests cannot recreate a just-cleaned bucket and obtain another allowance.
 await failure(admitPublicHours(db,'primary',secret,'mutation',now+59999),429);
 await admitPublicHours(db,'primary',secret,'read',now+60001);await admitPublicHours(db,'primary',secret,'read',now+60000);
 await db.prepare("UPDATE public_hour_admission SET attempts=capacity WHERE policy='mutation-v1' AND scope='source-hour'").run();
 const beforeLimit=(await db.prepare("SELECT scope,window_start,attempts FROM public_hour_admission WHERE policy='mutation-v1' ORDER BY scope,window_start").all()).results;
 await failure(admitPublicHours(db,'primary',secret,'mutation',now+60002),429);
 assert.deepEqual((await db.prepare("SELECT scope,window_start,attempts FROM public_hour_admission WHERE policy='mutation-v1' ORDER BY scope,window_start").all()).results,beforeLimit);
 await failure(admitPublicHours({prepare(){throw Error('private database error');}},'primary',secret,'mutation',now),503);
 // Backup excludes transient counters; full replacement clears them while preserving receipts.
 const http=async(path,body,method=body?'POST':'GET')=>worker.fetch(new Request(origin+path,{method,headers:{'content-type':'application/json',cookie:'lancerlogin_session='+await createSessionCodec(secret).issue({userId:'admin',role:'admin'})},...(body?{body:JSON.stringify(body)}:{})}),env);
 const backup=await(await http('/admin/data/backup?scope=installation')).json();assert.equal(backup.tables.public_hour_admission,undefined);assert.equal(backup.tables.public_hour_admission_clock,undefined);
 const countBeforeAttendance=(await db.prepare('SELECT count(*) n FROM public_hour_admission').first()).n;assert.equal((await http('/admin/data',{scope:'attendance',confirmation:'DELETE ATTENDANCE'},'DELETE')).status,200);assert.equal((await db.prepare('SELECT count(*) n FROM public_hour_admission').first()).n,countBeforeAttendance);
 const restored=await http('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup});assert.equal(restored.status,200,await restored.clone().text());assert.equal((await db.prepare('SELECT count(*) n FROM public_hour_admission').first()).n,0);assert.deepEqual(await good('entries',payload),receipts[0]);
 await db.prepare("UPDATE platform_module_configuration SET hours_enabled=0 WHERE installation_id='primary'").run();assert.deepEqual(await good('context'),{available:false});assert.equal((await call('entries',payload)).status,403);
 assert.equal((await db.prepare('SELECT count(*) n FROM hours_entries').first()).n>0,true);
 }finally{await mf.dispose();}
});
