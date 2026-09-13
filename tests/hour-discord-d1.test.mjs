import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery as split} from 'wrangler';
import {hourDiscordInteraction,isHourDiscord} from '../apps/api/src/hour-discord.ts';
import worker from '../apps/api/src/index.ts';
import {editPrivateInteraction} from '../apps/api/src/discord-interaction-reply.ts';
import {encryptIntegration} from '../apps/api/src/integration-crypto.ts';
import {readDiscordBody,discordReadDeadline,composeDiscordCommands,hoursCommands,reconcileDiscordApplicationCommands} from '../apps/api/src/discord-platform.ts';
import {submitLinkedDiscordHours,submitSelfAssertedHours} from '../apps/api/src/hour-accounting.ts';
import {requestLinkedDiscordHourCorrection} from '../apps/api/src/hour-review-reports.ts';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',user='123456789012345678',config={applicationId:'123456789012345679',guildId:'123456789012345680'},migrationURL=new URL('../apps/api/migrations/',import.meta.url);
const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
let sequence=123456789012345700n;
const find=(message,label)=>message.components.flatMap(r=>r.components).find(c=>c.label===label);
const fields=value=>Object.entries(value).map(([custom_id,value])=>({type:1,components:[{type:4,custom_id,value}]}));
test('absolute signed-body and read-only admission deadlines stop stalled reads',{timeout:5000},async()=>{
 let cancelled=false;const request=new Request('https://fixture.test',{method:'POST',duplex:'half',body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;return new Promise(()=>{});}})});
 const started=Date.now();await assert.rejects(readDiscordBody(request,65536,25),e=>e.status===408);assert.ok(Date.now()-started<1000);assert.equal(cancelled,true);
 await assert.rejects(discordReadDeadline(new Promise(()=>{}),Date.now()+20),e=>e.status===408);
});
test('private Discord hours use real D1 drafts, modal handoff, immutable retry and atomic provider gates',{timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));const originalFetch=globalThis.fetch,originalNow=Date.now;
 try{
  const db=await mf.getD1Database('DB');for(const name of readdirSync(migrationURL).filter(n=>n.endsWith('.sql')).sort())await db.batch(split(readFileSync(new URL(name,migrationURL),'utf8')).map(s=>db.prepare(s)));
  const keys=generateKeyPairSync('ed25519');
  const encrypted=await encryptIntegration({...config,publicKey:keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex')},secret);
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode,discord_enabled) VALUES('primary','2026-01-01','local',1)"),
   db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic','UTC')"),
   db.prepare("INSERT INTO platform_module_configuration(installation_id,hours_enabled) VALUES('primary',1)"),
   db.prepare("INSERT INTO hours_entry_settings(installation_id,reporting_days,reopen_hours) VALUES('primary',365,24)"),
   db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,discord_user_id,created_at) VALUES('member','primary','synthetic-id','Synthetic','Member',?,'2026-01-01')").bind(user),
   db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','task','Private service','task','2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,updated_at,verified_at) VALUES('discord','primary','discord',?,?,'2026-01-01','2026-01-01')").bind(encrypted.ciphertext,encrypted.iv)
  ]);
  const env={DB:db,INTEGRATION_KEY:secret};const messages=new Map();
  globalThis.fetch=async(url,options)=>{assert.match(String(url),/^https:\/\/discord.com\/api\/v10\/webhooks\/\d+\/synthetic-/);assert.equal(options.method,'PATCH');assert.equal(new Headers(options.headers).has('authorization'),false);assert.equal(options.redirect,'manual');const message=JSON.parse(options.body);assert.deepEqual(message.allowed_mentions,{parse:[]});messages.set(String(url).split('/')[7],message);return Response.json({});};
  async function call(type,data,extra={}){const id=String(sequence++),token='synthetic-'+id,pending=[];const response=await hourDiscordInteraction(env,{id,token,application_id:config.applicationId,guild_id:config.guildId,member:{user:{id:user}},type,data,...extra},config,encrypted.iv,{waitUntil:p=>pending.push(p)});const body=await response.json();if(body.type===5){assert.equal(body.data.flags,64);await Promise.all(pending);return messages.get(token);}return body;}
  const start=await call(2,{name:'hours'});assert.equal(start.components[0].components[0].options[0].label,'Private service');
  // The signed route rejects malformed signatures before loading or changing a draft.
  const signedId=String(sequence++),signedPayload={id:signedId,token:'synthetic-'+signedId,application_id:config.applicationId,guild_id:config.guildId,member:{user:{id:user}},type:3,data:{custom_id:start.components[0].components[0].custom_id,values:['0']}};
  const raw=JSON.stringify(signedPayload),stamp=String(Math.floor(Date.now()/1000)),signature=sign(null,Buffer.from(stamp+raw),keys.privateKey).toString('hex');
  const signedRequest=(body,signatureValue)=>new Request('https://fixture.test/discord/interactions',{method:'POST',headers:{'content-type':'application/json','x-signature-timestamp':stamp,'x-signature-ed25519':signatureValue},body});
  const untouched=await db.prepare('SELECT * FROM discord_hour_drafts').first();
  assert.equal((await worker.fetch(signedRequest(raw,'0'.repeat(128)),env)).status,401);
  assert.equal((await worker.fetch(signedRequest(raw+' ',signature),env)).status,401);
  assert.deepEqual(await db.prepare('SELECT * FROM discord_hour_drafts').first(),untouched);
  // Cross-protocol custom IDs cannot bypass modal/component semantics.
  for(const [type,data] of [[5,{custom_id:start.components[0].components[0].custom_id,values:['0']}],[5,{custom_id:start.components[0].components[0].custom_id.replace(/pick$/,'details'),components:fields({start:'09:00',end:'10:00',next:'no',notes:''})}]]){
   assert.match((await call(type,data)).content,/unavailable/);
   assert.deepEqual(await db.prepare('SELECT * FROM discord_hour_drafts').first(),untouched);
  }
  assert.equal(isHourDiscord({type:3,data:{custom_id:7}}),false);
  let message=await call(3,{custom_id:start.components[0].components[0].custom_id,values:['0']});assert.equal(message.components[0].components[0].options.length,25);
  message=await call(3,{custom_id:message.components[0].components[0].custom_id,values:['1']});assert.match(message.content,new RegExp(yesterday));
  const modal=await call(3,{custom_id:find(message,'Edit details').custom_id});assert.equal(modal.type,9);
  const beforeModal=await db.prepare('SELECT * FROM discord_hour_drafts').first();
  assert.match((await call(3,{custom_id:modal.data.custom_id,components:fields({start:'09:00',end:'10:00',next:'no',notes:''})})).content,/unavailable/);
  assert.deepEqual(await db.prepare('SELECT * FROM discord_hour_drafts').first(),beforeModal);
  message=await call(5,{custom_id:modal.data.custom_id,components:fields({start:'09:00',end:'10:00',next:'no',notes:'Synthetic private note'})});assert.match(message.content,/60 minutes/);assert.match(message.content,/Private service/);
  const custom_id=find(message,'Record these hours').custom_id;assert.doesNotMatch(custom_id,/Synthetic|note|member/);
  assert.match((await call(5,{custom_id})).content,/unavailable/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM hours_entries').first()).n,0);
  const results=await Promise.all([call(3,{custom_id}),call(3,{custom_id})]);assert.ok(results.every(r=>/Recorded 60 minutes/.test(r.content)));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM hours_entries').first()).n,1);
  const row=await db.prepare('SELECT * FROM discord_hour_drafts').first();assert.doesNotMatch(JSON.stringify(row),/Synthetic private note|synthetic-123/);assert.match(row.confirmation_id,/^\d{18}$/);
  await db.prepare("UPDATE members SET discord_user_id=NULL WHERE id='member'").run();assert.deepEqual(await call(3,{custom_id}),results[0]);assert.match((await call(2,{name:'hours'})).content,/Pair your Discord/);
  await db.prepare("UPDATE members SET discord_user_id=? WHERE id='member'").bind(user).run();
  message=await call(2,{name:'hours-correction'});const correctionModal=await call(3,{custom_id:find(message,'Edit details').custom_id});message=await call(5,{custom_id:correctionModal.data.custom_id,components:fields({message:'Synthetic correction',date:yesterday,receipt:''})});const correctionId=find(message,'Send correction request').custom_id;
  const acknowledgements=await Promise.all([call(3,{custom_id:correctionId}),call(3,{custom_id:correctionId})]);assert.deepEqual(acknowledgements[0],acknowledgements[1]);assert.match(acknowledgements[0].content,/Correction request received/);assert.equal((await db.prepare('SELECT count(*) AS n FROM hours_correction_requests').first()).n,1);
  await db.prepare("UPDATE members SET discord_user_id=NULL WHERE id='member'").run();assert.deepEqual(await call(3,{custom_id:correctionId}),acknowledgements[0]);await db.prepare("UPDATE members SET discord_user_id=? WHERE id='member'").bind(user).run();
  for(const extra of [{guild_id:'123456789012345699'},{application_id:'123456789012345699'},{member:undefined},{member:{user:{id:'123456789012345699'}}}]){const denied=await call(3,{custom_id},extra);assert.match(denied.data?.content??denied.content,/unavailable|expired/);}
  await db.prepare("UPDATE platform_module_configuration SET hours_enabled=0").run();assert.match((await call(3,{custom_id})).content,/unavailable/);await db.prepare("UPDATE platform_module_configuration SET hours_enabled=1").run();
  // Interpose only at the actual domain atomic batch after all read checks.
  for(const mutation of ["UPDATE installations SET discord_enabled=0","UPDATE encrypted_integrations SET iv='rotated'","UPDATE platform_module_configuration SET hours_enabled=0"]){
   const reset=async()=>db.batch([db.prepare('UPDATE installations SET discord_enabled=1'),db.prepare('UPDATE encrypted_integrations SET iv=?').bind(encrypted.iv),db.prepare('UPDATE platform_module_configuration SET hours_enabled=1')]);
   for(const kind of ['entry','correction']){await reset();let fired=false;const raced={prepare:s=>db.prepare(s),batch:async statements=>{if(!fired){fired=true;await db.prepare(mutation).run();}return db.batch(statements);}};
    const key='synthetic-race-'+String(sequence++);await assert.rejects(kind==='entry'?submitLinkedDiscordHours(raced,'primary',user,{categoryId:'task',serviceDate:yesterday,startLocal:'12:00',endLocal:'13:00',endNextDay:false,expectedTimeZone:'UTC',idempotencyKey:key},Date.now(),encrypted.iv):requestLinkedDiscordHourCorrection(raced,'primary',user,{message:'Synthetic race',idempotencyKey:key},Date.now(),encrypted.iv));assert.equal(fired,true);
   }await reset();
  }
  assert.equal((await db.prepare('SELECT count(*) AS n FROM hours_entries').first()).n,1);assert.equal((await db.prepare('SELECT count(*) AS n FROM hours_correction_requests').first()).n,1);
  // A real Ed25519-signed route can defer without waiting for domain reads.
  const pending=[],validId=String(sequence++),valid={...signedPayload,id:validId,token:'synthetic-'+validId,data:{custom_id}};
  const validRaw=JSON.stringify(valid),validSignature=sign(null,Buffer.from(stamp+validRaw),keys.privateKey).toString('hex');
  const response=await worker.fetch(signedRequest(validRaw,validSignature),env,{waitUntil:p=>pending.push(p)});
  assert.deepEqual(await response.json(),{type:5,data:{flags:64,allowed_mentions:{parse:[]}}});await Promise.all(pending);
  assert.equal(messages.get(valid.token).content,results[0].content);
  const draftCount=(await db.prepare('SELECT count(*) AS n FROM discord_hour_drafts').first()).n;
  const slow=await hourDiscordInteraction(env,{...valid,type:2,data:{name:'hours'}},config,encrypted.iv,{waitUntil(){assert.fail('late admission started work');}},Date.now()-2600);
  assert.match((await slow.json()).data.content,/too slowly/);assert.equal((await db.prepare('SELECT count(*) AS n FROM discord_hour_drafts').first()).n,draftCount);
  await db.prepare('UPDATE discord_hour_drafts SET expires_at=0').run();
  assert.match((await call(3,{custom_id})).content,/expired/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM discord_hour_drafts').first()).n,0);
  // More than one page, first-page navigation, and stale revisions are real D1 state.
  await db.batch(Array.from({length:26},(_,i)=>db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary',?,?,'task','2026-01-01','2026-01-01')").bind('z'+String(i).padStart(2,'0'),'Synthetic '+i)));
  let page=await call(2,{name:'hours'});const firstCustom=page.components[0].components[0].custom_id;
  assert.equal(page.components[0].components[0].options.length,25);
  page=await call(3,{custom_id:find(page,'Next page').custom_id});assert.equal(page.components[0].components[0].options.length,2);
  assert.match((await call(3,{custom_id:firstCustom,values:['0']})).content,/expired/);
  page=await call(3,{custom_id:find(page,'First page').custom_id});assert.equal(page.components[0].components[0].options[0].label,'Private service');
  for(let i=0;i<3;i++)assert.ok((await call(2,{name:'hours'})).components.length);
  assert.match((await call(2,{name:'hours'})).content,/unavailable/);assert.equal((await db.prepare('SELECT count(*) AS n FROM discord_hour_drafts').first()).n,4);
  await db.prepare('DELETE FROM discord_hour_drafts').run();
  await db.prepare("DELETE FROM hours_categories WHERE id LIKE 'z%'").run();
  // Explicit next-day and DST offsets use the same civil-time/domain path.
  Date.now=()=>Date.parse('2026-11-02T18:00:00Z');
  await db.prepare("UPDATE organization_settings SET time_zone='America/New_York'").run();
  async function taskDetails(startClock,endClock,next='no',date='2026-11-01'){
   let m=await call(2,{name:'hours'});m=await call(3,{custom_id:m.components[0].components[0].custom_id,values:['0']});
   for(let n=0;n<15;n++){const options=m.components[0].components[0].options,index=options.findIndex(o=>o.label===date);if(index>=0){m=await call(3,{custom_id:m.components[0].components[0].custom_id,values:[String(index)]});break;}m=await call(3,{custom_id:find(m,'Next page').custom_id});}
   const opened=await call(3,{custom_id:find(m,'Edit details').custom_id});
   return call(5,{custom_id:opened.data.custom_id,components:fields({start:startClock,end:endClock,next,notes:''})});
  }
  let fold=await taskDetails('01:15','01:45');assert.match(fold.content,/start clock occurs twice/);
  const startOffset=find(fold,'Earlier UTC-04:00');assert.ok(startOffset);
  const foldRow=await db.prepare('SELECT * FROM discord_hour_drafts').first();
  assert.match((await call(5,{custom_id:startOffset.custom_id})).content,/unavailable/);assert.deepEqual(await db.prepare('SELECT * FROM discord_hour_drafts').first(),foldRow);
  fold=await call(3,{custom_id:startOffset.custom_id});assert.match(fold.content,/end clock occurs twice/);
  fold=await call(3,{custom_id:find(fold,'Later UTC-05:00').custom_id});assert.match(fold.content,/90 minutes/);
  assert.match((await call(3,{custom_id:find(fold,'Record these hours').custom_id})).content,/Recorded 90 minutes/);
  const gap=await taskDetails('02:15','03:15','no','2026-03-08');assert.match(gap.content,/clock does not exist/);
  const overnight=await taskDetails('23:00','01:00','yes');assert.match(overnight.content,/next day.*120 minutes/);
  assert.match((await call(3,{custom_id:find(overnight,'Record these hours').custom_id})).content,/Recorded 120 minutes/);
  const invalid=await taskDetails('23:00','01:00','no','2026-10-31');assert.match(invalid.content,/positive whole-minute/);
  await db.prepare('DELETE FROM discord_hour_drafts').run();
  await submitSelfAssertedHours(db,'primary',{memberId:'synthetic-id',categoryId:'task',serviceDate:'2026-11-01',startLocal:'11:00',endLocal:'12:00',endNextDay:false,taskNotes:'Synthetic hidden public-entry detail',idempotencyKey:'synthetic-public-overlap',expectedTimeZone:'America/New_York'},Date.now());
  const overlap=await taskDetails('11:30','12:30'),overlapBefore=(await db.prepare('SELECT count(*) AS n FROM hours_entries').first()).n;
  const deniedOverlap=await call(3,{custom_id:find(overlap,'Record these hours').custom_id});assert.match(deniedOverlap.content,/not confirmed/);assert.doesNotMatch(JSON.stringify(deniedOverlap),/hidden public-entry detail/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM hours_entries').first()).n,overlapBefore);
  await db.prepare('DELETE FROM discord_hour_drafts').run();
  await db.batch([
   db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('staff','primary','synthetic-staff','staff','2026-01-01')"),
   db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','event','Synthetic events','event','2026-01-01','2026-01-01'),('primary','team','Synthetic support','team','2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO hours_teams(installation_id,id,number,name,created_at,updated_at) VALUES('primary','team-1','100','Synthetic Partner','2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('primary','old-event','event','event','2025-01-01','Synthetic old event','UTC',0,'2026-01-01','2026-01-01'),('primary','still-closed','event','event','2025-01-01','Synthetic closed event','UTC',0,'2026-01-01','2026-01-01')"),
   db.prepare('UPDATE hours_entry_settings SET reporting_days=7,revision=revision+1'),
  ]);
  async function category(label){const m=await call(2,{name:'hours'}),select=m.components[0].components[0],index=select.options.findIndex(o=>o.label===label);assert.ok(index>=0);return call(3,{custom_id:select.custom_id,values:[String(index)]});}
  const closed=await category('Synthetic events');assert.match(closed.content,/No available choices/);
  await db.prepare("INSERT INTO hours_reopen_windows(installation_id,id,activity_id,starts_ms,expires_ms,actor_user_id,created_at) VALUES('primary','window','old-event',?,?,'staff','2026-01-01')").bind(Date.now()-1000,Date.now()+60000).run();
  let event=await category('Synthetic events');assert.equal(event.components[0].components[0].options[0].label,'2025-01-01');
  event=await call(3,{custom_id:event.components[0].components[0].custom_id,values:['0']});assert.deepEqual(event.components[0].components[0].options.map(o=>o.label),['Synthetic old event']);
  event=await call(3,{custom_id:event.components[0].components[0].custom_id,values:['0']});const eventModal=await call(3,{custom_id:find(event,'Edit details').custom_id});
  event=await call(5,{custom_id:eventModal.data.custom_id,components:fields({start:'10:00',end:'11:00',next:'no',notes:''})});
  await db.prepare('UPDATE hours_reopen_windows SET revoked=1').run();
  const beforeCount=(await db.prepare('SELECT count(*) AS n FROM hours_entries').first()).n;
  assert.match((await call(3,{custom_id:find(event,'Record these hours').custom_id})).content,/not confirmed/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM hours_entries').first()).n,beforeCount);
  // Global event reopening does not expand team-support dates.
  await db.prepare('UPDATE hours_reopen_windows SET revoked=0,activity_id=NULL').run();
  let team=await category('Synthetic support');assert.equal(team.components[0].components[0].options.length,7);assert.equal(find(team,'Next page'),undefined);
  team=await call(3,{custom_id:team.components[0].components[0].custom_id,values:['2']});assert.equal(team.components[0].components[0].options[0].label,'100 Synthetic Partner');
  team=await call(3,{custom_id:team.components[0].components[0].custom_id,values:['0']});const teamModal=await call(3,{custom_id:find(team,'Edit details').custom_id});
  team=await call(5,{custom_id:teamModal.data.custom_id,components:fields({start:'10:00',end:'11:00',next:'no',notes:''})});
  assert.match((await call(3,{custom_id:find(team,'Record these hours').custom_id})).content,/Recorded 60 minutes/);
  const support=await db.prepare("SELECT a.team_id,e.attribution,e.channel FROM hours_entries e JOIN hours_activities a ON a.id=e.activity_id AND a.installation_id=e.installation_id WHERE a.mode='team'").first();
  assert.deepEqual(support,{team_id:'team-1',attribution:'linked_discord',channel:'discord'});
  assert.ok((await db.prepare('SELECT count(*) AS n FROM discord_hour_drafts').first()).n>0);
  await db.prepare("DELETE FROM installations WHERE id='primary'").run();
  assert.equal((await db.prepare('SELECT count(*) AS n FROM discord_hour_drafts').first()).n,0);
 }finally{Date.now=originalNow;globalThis.fetch=originalFetch;await mf.dispose();}
});

test('Hours guild command registration preserves core and unrelated commands across disable/re-enable',async()=>{
 const original=globalThis.fetch,core=composeDiscordCommands(),c={...config,channelId:'123456789012345681',botToken:'synthetic-token'};
 const identity=command=>({...command,id:String(sequence++),application_id:c.applicationId,guild_id:c.guildId});
 let remote=[...core.map(identity),identity({name:'Unrelated',type:2,description:''})];const baseline=structuredClone(remote),writes=[];
 globalThis.fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(path.endsWith('/oauth2/applications/@me'))return Response.json({id:c.applicationId});
  if(path.endsWith('/guilds/'+c.guildId))return Response.json({id:c.guildId});
  if(path.endsWith('/channels/'+c.channelId))return Response.json({guild_id:c.guildId,type:0});
  assert.ok(path.endsWith('/commands'));
  if(init.method==='GET')return Response.json(remote);
  assert.equal(init.method,'POST');const command=JSON.parse(init.body);assert.ok(hoursCommands.some(h=>h.name===command.name));writes.push(command.name);remote.push(identity(command));return Response.json(remote.at(-1));
 };
 try{
  assert.deepEqual((await reconcileDiscordApplicationCommands(c,true)).commands,['pair','attendance-report','hours','hours-correction']);
  assert.deepEqual(remote.slice(0,3),baseline);assert.deepEqual(writes,['hours','hours-correction']);
  await reconcileDiscordApplicationCommands(c,true);await reconcileDiscordApplicationCommands(c,false);await reconcileDiscordApplicationCommands(c,true);assert.equal(writes.length,2);
  assert.throws(()=>composeDiscordCommands([{owner:'hours',commands:hoursCommands}]));
 }finally{globalThis.fetch=original;}
});

test('private reply transport rejects expired, oversized and redirecting replies without reflecting credentials',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('synthetic-private-provider-content',{status:302,headers:{location:'https://foreign.test'}});};
 try{
  await assert.rejects(editPrivateInteraction(config.applicationId,'synthetic-token',{content:'ok'},Date.now()-1));
  await assert.rejects(editPrivateInteraction(config.applicationId,'synthetic-token',{content:'x'.repeat(2001)},Date.now()+60000));assert.equal(calls,0);
  await assert.rejects(editPrivateInteraction(config.applicationId,'synthetic-token',{content:'ok'},Date.now()+60000),e=>/not confirmed/.test(e.message)&&!e.message.includes('synthetic'));assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});
