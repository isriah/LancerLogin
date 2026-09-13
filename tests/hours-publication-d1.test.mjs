import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import {encryptIntegration} from '../apps/api/src/integration-crypto.ts';
import worker,{PlatformScheduler} from '../apps/api/src/index.ts';
import {createSessionCodec} from '../apps/api/src/runtime-security.ts';
import {googleScopes} from '../apps/api/src/google-connection.ts';
import {hoursPublicationRoute,processHoursPublication,preparePublicationRestore} from '../apps/api/src/hours-publication.ts';
const key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',migrations=new URL('../apps/api/migrations/',import.meta.url);
const rejects=(p,status)=>assert.rejects(p,e=>e.status===status);
test('publication D1 reviewed snapshots, durable ownership and delivery races',{timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 const originalFetch=globalThis.fetch;
 try{
 const db=await mf.getD1Database('DB');for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL(name,migrations),'utf8')).map(s=>db.prepare(s)));
 await db.batch([
 db.prepare("INSERT INTO installations(id,created_at,auth_mode,google_calendar_enabled,discord_enabled) VALUES('primary','2026-01-01','local',1,1)"),
 db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-01-01'),('staff','primary','staff','staff','2026-01-01'),('operator','primary','operator','operator','2026-01-01')"),
 db.prepare("INSERT INTO platform_module_configuration(installation_id,hours_enabled) VALUES('primary',1)"),
 db.prepare("UPDATE users SET password_hash='scrypt$32768$8$1$synthetic-not-a-credential' WHERE id='admin'"),
 db.prepare("INSERT INTO hours_entry_settings(installation_id) VALUES('primary')"),
 db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic','UTC')"),
 db.prepare("INSERT INTO platform_module_grants(installation_id,user_id,hours_manage) VALUES('primary','staff',1)"),
 db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','event','Event','event','2026-01-01','2026-01-01')")]);
 const active={clientId:'synthetic-client',clientSecret:'synthetic-secret',generation:'synthetic-generation',loginEnabled:false,loginProof:false,calendarEnabled:true,driveEnabled:false,organizationProof:true,calendarProof:true,calendarId:'synthetic-calendar',calendarLabel:'Synthetic',calendarVerifiedAt:'2026-01-01',legacyFingerprint:'[null,null,{"auth_mode":"local"}]',grant:{proofId:'synthetic-proof',subject:'synthetic-subject',refreshToken:'synthetic-refresh',scopes:googleScopes.calendar}};
 const google=await encryptIntegration({installation:'primary',slot:'active',payload:JSON.stringify(active)},key);
 const config={applicationId:'123456789012345678',guildId:'223456789012345678',channelId:'323456789012345678',botToken:'synthetic-token',publicKey:'a'.repeat(64)};
 const discord=await encryptIntegration(config,key);
 await db.batch([db.prepare("INSERT INTO google_connections(installation_id,shared_mode,revision,active_ciphertext,active_iv,updated_at,grant_proof_id) VALUES('primary',1,1,?,?,'2026-01-01','synthetic-proof')").bind(google.ciphertext,google.iv),db.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,updated_at,verified_at) VALUES('discord','primary','discord',?,?,'2026-01-01','2026-01-01')").bind(discord.ciphertext,discord.iv)]);
 const env={DB:db,INTEGRATION_KEY:key,SESSION_KEY:key,APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.test'},date='2099-01-01';
 let sequence=0,hook=null,fail=null;const googleEvents=new Map(),discordEvents=new Map(),calls=[];
 globalThis.fetch=async(url,init={})=>{
  const u=String(url),method=init.method??'GET';calls.push({u,method});
  if(u==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-access'});
  if(u.endsWith('/users/@me'))return Response.json({id:'423456789012345678'});
  const isGoogle=u.startsWith('https://www.googleapis.com/calendar/'),collection=isGoogle?googleEvents:discordEvents;
  assert.ok(isGoogle||u.startsWith('https://discord.com/api/v10/guilds/'+config.guildId+'/scheduled-events'),u);
  const pathname=new URL(u).pathname,id=pathname.split('/').at(-1),single=id!=='events'&&id!=='scheduled-events';
  if(fail){const f=fail;fail=null;if(f==='429')return Response.json({retry_after:0},{status:429});if(f==='500')return new Response('',{status:500});}
  if(method==='GET')return single?(collection.has(id)?Response.json(collection.get(id)):new Response('',{status:404})):Response.json([...collection.values()]);
  if(method==='DELETE'){assert.ok(!isGoogle||init.headers['if-match']);collection.delete(id);return new Response(null,{status:204});}
  const payload=JSON.parse(init.body),eventId=method==='POST'?(isGoogle?payload.id:String(523456789012345670n+BigInt(++sequence))):id;
  if(isGoogle&&method==='PATCH')assert.ok(init.headers['if-match']);
  const value=isGoogle?{...payload,id:eventId,etag:'"synthetic-etag"'}:{...payload,id:eventId,guild_id:config.guildId,creator_id:'423456789012345678'};collection.set(eventId,value);
  if(hook){const h=hook;hook=null;await h();}
  return Response.json(value);
 };
 const event=async(id)=>db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('primary',?,'event','event',?,'Private activity title','UTC',0,'2026-01-01','2026-01-01')").bind(id,date).run();
 const route=(id,p='',body,method=body?'PUT':'GET',database=db,actor='staff')=>hoursPublicationRoute({...env,DB:database},actor,new Request('https://fixture.test/admin/hours/activities/'+id+'/publications'+(p?'/'+p:''),{method}),body);
 const enable=async(id,p='google',extra={},database=db)=>{const d=await route(id),target=d.providers.find(v=>v.provider===p);return route(id,p,{revision:target.revision,activityRevision:d.activityRevision,enabled:true,targetKey:target.target.key,snapshot:{title:'Reviewed public title',description:'Reviewed public description',location:p==='discord'?'Synthetic hall':'',startsAt:p==='discord'?date+'T09:00:00Z':null,endsAt:p==='discord'?date+'T10:00:00Z':null},...extra},'PUT',database);};
 const operation=(id,p='google',action='upsert')=>db.prepare('SELECT * FROM hours_publication_operations WHERE activity_id=? AND provider=? AND action=? ORDER BY generation DESC LIMIT 1').bind(id,p,action).first();
 const deliver=(p='google')=>processHoursPublication(env,p);
 const count=(method)=>calls.filter(c=>c.method===method&&!c.u.includes('oauth2.googleapis.com')).length;
 await event('first');assert.deepEqual((await route('first')).providers.map(p=>p.enabled),[false,false]);assert.equal(calls.length,0);await rejects(route('first','',undefined,'GET',db,'operator'),403);

 // Capability metadata and its authority IV must come from the same captured row.
 // Scope refresh preserves generation/proof; replacement changes generation.
 for(const [name,replacement] of [['scope-race',{...active,calendarProof:false,grant:{...active.grant,scopes:[googleScopes.calendar[0]]}}],['generation-race',{...active,generation:'synthetic-replacement'}]]){
  await event(name);const encrypted=await encryptIntegration({installation:'primary',slot:'active',payload:JSON.stringify(replacement)},key);let rotated=false;
  const raced={prepare:sql=>{const wrap=(args=[])=>{const raw=db.prepare(sql).bind(...args);return {raw,bind:(...v)=>wrap(v),first:async()=>{const value=await raw.first();if(!rotated&&sql.startsWith('SELECT grant_proof_id,shared_mode')){rotated=true;await db.prepare('UPDATE google_connections SET active_ciphertext=?,active_iv=?,revision=revision+1').bind(encrypted.ciphertext,encrypted.iv).run();}return value;},all:()=>raw.all(),run:()=>raw.run()};};return wrap();},batch:ss=>db.batch(ss.map(s=>s.raw))};
  const audits=(await db.prepare('SELECT count(*) n FROM audit_log').first()).n,beforeCalls=calls.length;
  await assert.rejects(enable(name,'google',{},raced),/Provider ownership or connection requires review/);assert.equal(rotated,true);
  assert.equal((await db.prepare('SELECT count(*) n FROM hours_publication_intents WHERE activity_id=?').bind(name).first()).n,0);assert.equal((await db.prepare('SELECT count(*) n FROM audit_log').first()).n,audits);assert.equal(calls.length,beforeCalls);
  await db.prepare('UPDATE google_connections SET active_ciphertext=?,active_iv=?,revision=revision+1').bind(google.ciphertext,google.iv).run();
 }
 const publicStatus=JSON.stringify(await route('first'));assert.ok(!publicStatus.includes(google.iv));assert.ok(!publicStatus.includes('signature'));assert.ok(!publicStatus.includes(active.clientSecret));
 await enable('first');assert.equal(calls.length,0);assert.equal((await route('first')).providers[1].enabled,false);
 await deliver();assert.equal((await operation('first')).status,'complete');assert.equal(googleEvents.size,1);assert.equal([...googleEvents.values()][0].summary,'Reviewed public title');assert.deepEqual([...googleEvents.values()][0].start,{date});
 await db.prepare("UPDATE hours_activities SET title='New private title',revision=revision+1 WHERE id='first'").run();assert.equal((await route('first')).providers[0].needsReview,true);let writes=count('PATCH');await deliver();assert.equal(count('PATCH'),writes);
 await enable('first');await deliver();assert.equal(count('PATCH'),writes+1);
 const d=await route('first');await route('first','google',{revision:d.providers[0].revision,activityRevision:d.activityRevision,enabled:false});await deliver();assert.equal(googleEvents.size,0);assert.equal((await operation('first','google','delete')).status,'complete');
 // Both in-flight workers cannot acquire one operation; ambiguous Google success reconciles by deterministic ID.
 await event('google-lost');await enable('google-lost');hook=async()=>{throw Error('synthetic lost response');};await deliver();assert.equal((await operation('google-lost')).status,'failed');let before=count('POST');await db.prepare("UPDATE hours_publication_operations SET next_attempt_ms=0 WHERE activity_id='google-lost'").run();await Promise.all([deliver(),deliver()]);assert.equal(count('POST'),before);assert.equal((await operation('google-lost')).status,'complete');
 // Missing ETag must not silently remove the conditional mutation guard.
 await enable('google-lost');for(const v of googleEvents.values())delete v.etag;writes=count('PATCH');await deliver();assert.equal(count('PATCH'),writes);assert.equal((await operation('google-lost')).status,'review');
 await event('discord');await rejects(enable('discord','discord',{snapshot:{title:'Title',description:'',location:'',startsAt:null,endsAt:null}}),400);await enable('discord','discord');hook=async()=>{throw Error('synthetic lost response');};await deliver('discord');assert.equal((await operation('discord','discord')).phase,'create_dispatched');before=count('POST');await db.prepare("UPDATE hours_publication_operations SET next_attempt_ms=0 WHERE activity_id='discord'").run();await deliver('discord');assert.equal(count('POST'),before);assert.equal((await operation('discord','discord')).status,'complete');
 await event('discord-uncertain');await enable('discord-uncertain','discord');hook=async()=>{discordEvents.clear();throw Error('synthetic ambiguous create');};await deliver('discord');await db.prepare("UPDATE hours_publication_operations SET next_attempt_ms=0 WHERE activity_id='discord-uncertain'").run();before=count('POST');await deliver('discord');assert.equal(count('POST'),before);assert.equal((await operation('discord-uncertain','discord')).status,'review');
 // Transport must not retry a 429 within the old authorization context.
 await event('rate');await enable('rate','discord');fail='429';before=calls.length;await deliver('discord');assert.equal(calls.slice(before).filter(c=>c.u.includes('scheduled-events')).length,1);assert.equal((await operation('rate','discord')).status,'failed');
 // Retry must atomically observe an intervening lease and must serialize revisions.
 const op=await operation('rate','discord');let raced=false;const raceDB={prepare:s=>db.prepare(s),batch:async statements=>{if(!raced){raced=true;await db.prepare("UPDATE hours_publication_operations SET status='processing',lease_token='synthetic-live',lease_expires_ms=? WHERE activity_id='rate'").bind(Date.now()+60000).run();}return db.batch(statements);}};
 await rejects(route('rate','discord/retry',{generation:1,action:'upsert',revision:op.revision},'POST',raceDB),409);assert.equal((await operation('rate','discord')).lease_token,'synthetic-live');
 await db.prepare("UPDATE hours_publication_operations SET lease_expires_ms=NULL,lease_token=NULL,status='failed' WHERE activity_id='rate'").run();await route('rate','discord/retry',{generation:1,action:'upsert',revision:op.revision},'POST');await rejects(route('rate','discord/retry',{generation:1,action:'upsert',revision:op.revision},'POST'),409);
 // Archive during successful create retains identity and queues owned cleanup.
 await db.prepare("UPDATE hours_publication_operations SET status='review' WHERE activity_id='rate'").run();await event('archive');await enable('archive');hook=async()=>db.prepare("UPDATE hours_activities SET archived=1,revision=revision+1 WHERE id='archive'").run();await deliver();assert.ok((await db.prepare("SELECT provider_event_id FROM hours_publication_generations WHERE activity_id='archive'").first()).provider_event_id);await deliver();assert.equal((await operation('archive','google','delete')).status,'complete');
 // Replacement while create fails cannot discard the newer staff review.
 await event('new-review');await enable('new-review');hook=async()=>{await enable('new-review');throw Error('synthetic old delivery failure');};await deliver();assert.equal((await operation('new-review')).status,'pending');assert.equal((await operation('new-review')).revision,1);
 // Disable/re-enable never silently resumes pending content.
 await db.prepare('UPDATE platform_module_configuration SET hours_enabled=0').run();assert.deepEqual(await deliver(),{paused:true});await db.prepare('UPDATE platform_module_configuration SET hours_enabled=1').run();assert.equal((await route('new-review')).providers[0].needsReview,true);assert.equal((await operation('new-review')).status,'review');


 // A losing claim cannot demote an operation completed between its read and claim.
 await event('completed-race');await enable('completed-race');let completedRace=false;
 const completionDB={prepare:sql=>{const wrap=(args=[])=>{const raw=db.prepare(sql).bind(...args);return {bind:(...v)=>wrap(v),first:()=>raw.first(),all:()=>raw.all(),run:async()=>{if(!completedRace&&sql.startsWith("UPDATE hours_publication_operations SET status='processing'")){completedRace=true;await db.prepare("UPDATE hours_publication_operations SET status='complete' WHERE activity_id='completed-race'").run();}return raw.run();}};};return wrap();}};
 await processHoursPublication({...env,DB:completionDB},'google');assert.equal((await operation('completed-race')).status,'complete');
 // Actual scheduler dispatch shares eligibility+delivery budgets, one operation per alarm.
 await event('scheduled');await enable('scheduled');
 let queries=0;const counted=(sql,args=[])=>{const raw=db.prepare(sql).bind(...args);return {raw,bind:(...values)=>counted(sql,values),first:()=>{queries++;return raw.first();},all:()=>{queries++;return raw.all();},run:()=>{queries++;return raw.run();}};};
 let state={enabled:true,jobs:{'hours.google-calendar':{next:0,last:null,outcome:'waiting'}}};
 const storage={transaction:async cb=>cb(),get:async()=>structuredClone(state),put:async(_,v)=>{state=structuredClone(v);},getAlarm:async()=>null,setAlarm:async()=>{},deleteAlarm:async()=>{}};
 const scheduler=new PlatformScheduler({storage},{...env,PLATFORM_SCHEDULER_MODE:'durable',DB:{prepare:s=>counted(s),batch:async ss=>{queries+=ss.length;return db.batch(ss.map(s=>s.raw));}}});before=calls.length;await scheduler.alarm();assert.equal(state.jobs['hours.google-calendar'].outcome,'ok');assert.equal((await operation('scheduled')).status,'complete');assert.ok(queries<=32,`queries=${queries}`);assert.ok(calls.length-before<=12);
 // HTTP routing and installation backup/restore include these tables; attendance scope preserves them.
 const cookie='lancerlogin_session='+await createSessionCodec(key).issue({userId:'admin',role:'admin'});
 const http=(path,body,method=body?'POST':'GET')=>worker.fetch(new Request('https://fixture.test'+path,{method,headers:{cookie,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
 assert.equal((await http('/admin/hours/activities/scheduled/publications')).status,200);
 const backup=await (await http('/admin/data/backup?scope=installation')).json();assert.equal(backup.schemaVersion,28);assert.ok(backup.tables.hours_publication_intents.length);
 const invalid=structuredClone(backup);invalid.tables.hours_publication_generations[0].marker='bad';assert.equal((await http('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:invalid})).status,400);
 const meetings=await (await http('/admin/data/backup?scope=meetings')).json();const beforeRows=(await db.prepare('SELECT * FROM hours_publication_intents ORDER BY activity_id,provider').all()).results;
 let response=await http('/admin/data/restore',{scope:'meetings',confirmation:'RESTORE MEETINGS',backup:meetings});assert.ok(response.ok,await response.clone().text());assert.deepEqual((await db.prepare('SELECT * FROM hours_publication_intents ORDER BY activity_id,provider').all()).results,beforeRows);
 response=await http('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup});assert.equal(response.status,409,await response.clone().text());
 // Simulate explicit provider reconciliation of the uncertain synthetic create.
 await db.prepare("UPDATE hours_publication_operations SET phase='known' WHERE phase='create_dispatched'").run();

 const older=structuredClone(backup);for(const t of ['hours_publication_intents','hours_publication_generations','hours_publication_operations'])older.tables[t]=older.tables[t].filter(r=>r.activity_id!=='scheduled');
 assert.equal((await http('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:older})).status,409);
 const missingHandle=structuredClone(backup);missingHandle.tables.hours_publication_generations.find(r=>r.activity_id==='scheduled').provider_event_id=null;assert.equal((await http('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:missingHandle})).status,409);
 let restoreRace=false;env.DB={prepare:s=>db.prepare(s),batch:async statements=>{if(!restoreRace){restoreRace=true;await db.prepare("UPDATE hours_publication_operations SET status='processing',lease_token='synthetic-restoration-race',lease_expires_ms=? WHERE activity_id='scheduled' AND action='upsert'").bind(Date.now()+60000).run();}return db.batch(statements);}};
 assert.equal((await http('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup})).status,409);env.DB=db;assert.equal((await operation('scheduled')).lease_token,'synthetic-restoration-race');
 await db.prepare("UPDATE hours_publication_operations SET status='complete',lease_token=NULL,lease_expires_ms=NULL WHERE activity_id='scheduled'").run();
 assert.equal((await db.prepare('SELECT count(*) n FROM hours_publication_restore_guard').first()).n,0);
 // Fully cleaned generations may be omitted; their provider work already completed.
 for(const t of ['hours_publication_intents','hours_publication_generations','hours_publication_operations'])backup.tables[t]=backup.tables[t].filter(r=>r.activity_id!=='first');
 response=await http('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup});assert.ok(response.ok,await response.clone().text());assert.ok((await db.prepare('SELECT * FROM hours_publication_intents WHERE enabled=1').all()).results.every(r=>r.needs_review===1));
 // Restored operations are fenced and immutable identities retained.
 const tables={};for(const table of ['users','hours_activities','hours_publication_intents','hours_publication_generations','hours_publication_operations'])tables[table]=(await db.prepare('SELECT * FROM '+table).all()).results;
 const restored=structuredClone(tables);preparePublicationRestore(restored);assert.ok(restored.hours_publication_intents.filter(i=>i.enabled).every(i=>i.needs_review===1));assert.ok(restored.hours_publication_operations.every(o=>o.lease_token===null&&o.lease_expires_ms===null));assert.deepEqual(restored.hours_publication_generations,tables.hours_publication_generations);
 const damaged=structuredClone(tables);damaged.hours_publication_generations[0].marker='foreign';assert.throws(()=>preparePublicationRestore(damaged));
 }finally{globalThis.fetch=originalFetch;await mf.dispose();}
});
