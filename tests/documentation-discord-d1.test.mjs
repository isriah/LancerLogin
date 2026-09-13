import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import {documentationDiscordInteraction,isDocumentationDiscord} from '../apps/api/src/documentation-discord.ts';
import {encryptIntegration,decryptIntegration} from '../apps/api/src/integration-crypto.ts';
import {submitMemberDocumentationNote} from '../apps/api/src/public-documentation.ts';
import {composeDiscordCommands,documentationCommands,hoursCommands,reconcileDiscordApplicationCommands} from '../apps/api/src/discord-platform.ts';
import worker from '../apps/api/src/index.ts';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',user='123456789012345678',config={applicationId:'123456789012345679',guildId:'123456789012345680'};
const find=(message,label)=>message.components.flatMap(r=>r.components).find(c=>c.label===label);
const fields=(first,continuation='')=>[{type:18,component:{type:4,custom_id:'first',value:first}},{type:18,component:{type:4,custom_id:'continuation',value:continuation}}];
test('Documentation command ownership is explicit and preserves implemented owners',()=>{
 const core=composeDiscordCommands();assert.deepEqual(composeDiscordCommands([{owner:'attendance',commands:core},{owner:'hours',commands:hoursCommands},{owner:'documentation',commands:documentationCommands}]).map(c=>c.name),['pair','attendance-report','hours','hours-correction','activity-note','activity-file']);assert.throws(()=>composeDiscordCommands([{owner:'documentation',commands:documentationCommands}]));assert.throws(()=>composeDiscordCommands([{owner:'attendance',commands:core},{owner:'documentation',commands:[{...documentationCommands[0],description:'Drift'}]}]));assert.equal(isDocumentationDiscord({type:2,data:{name:'activity-note'}}),true);assert.equal(isDocumentationDiscord({type:2,data:{name:'attachment-proof'}}),false);
});
test('signed private Documentation drafts preserve 8000 units, immutable confirmation, current authority and bounded recovery',{timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));const originalFetch=globalThis.fetch;
 try{
  const db=await mf.getD1Database('DB'),directory=new URL('../apps/api/migrations/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL(name,directory),'utf8')).map(s=>db.prepare(s)));
  const keys=generateKeyPairSync('ed25519'),encrypted=await encryptIntegration({...config,publicKey:keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex')},secret);
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode,discord_enabled) VALUES('primary','2026-01-01','local',1)"),
   db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic','UTC')"),
   db.prepare("INSERT INTO platform_module_configuration(installation_id,hours_enabled,documentation_enabled) VALUES('primary',1,1)"),
   db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,discord_user_id,created_at) VALUES('member','primary','synthetic-id','Synthetic','Member',?,'2026-01-01')").bind(user),
   db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','event','Synthetic','event','2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,updated_at,verified_at) VALUES('discord','primary','discord',?,?,'2026-01-01','2026-01-01')").bind(encrypted.ciphertext,encrypted.iv)
  ]);
  for(let i=0;i<27;i++)await db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,description,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('primary',?,'event','event','2020-01-01',?,'PRIVATE HOURS DESCRIPTION','UTC',1,'2026-01-01','2026-01-01')").bind('activity-'+String(i).padStart(2,'0'),'Synthetic activity '+i).run();
  const env={DB:db,INTEGRATION_KEY:secret,APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.test'},messages=new Map();let seq=123456789012345700n,deliveryFailure=false;
  globalThis.fetch=async(url,options)=>{assert.match(String(url),/^https:\/\/discord.com\/api\/v10\/webhooks\/\d+\/synthetic-/);assert.equal(options.method,'PATCH');assert.equal(new Headers(options.headers).has('authorization'),false);assert.equal(options.redirect,'manual');const message=JSON.parse(options.body);assert.deepEqual(message.allowed_mentions,{parse:[]});if(deliveryFailure)throw Error('Synthetic failed delivery');messages.set(String(url).split('/')[7],message);return Response.json({});};
  async function call(type,data,extra={},database=db){const id=String(seq++),token='synthetic-'+id,pending=[];const response=await documentationDiscordInteraction({...env,DB:database},{id,token,application_id:config.applicationId,guild_id:config.guildId,member:{user:{id:user}},type,data,...extra},config,encrypted.iv,{waitUntil:p=>pending.push(p)});const body=await response.json();if(body.type===5){assert.equal(body.data.flags,64);await Promise.all(pending);return messages.get(token);}return body;}
  async function start(){const message=await call(2,{name:'activity-note'});const select=message.components[0].components[0];const detail=await call(3,{custom_id:select.custom_id,values:['0']});const response=await call(3,{custom_id:find(detail,'Edit note').custom_id});assert.equal(response.type,9);assert.equal(response.data.components.length,2);assert.equal(response.data.components[0].component.max_length,4000);return response;}
  const catalog=await call(2,{name:'activity-note'});assert.equal(catalog.components[0].components[0].options.length,25);assert.doesNotMatch(JSON.stringify(catalog),/PRIVATE HOURS|member|roster/);const last=await call(3,{custom_id:find(catalog,'Next page').custom_id});assert.equal(last.components[0].components[0].options.length,2);await call(3,{custom_id:find(last,'First page').custom_id});
  await db.prepare('DELETE FROM discord_documentation_drafts').run();
  const m=await start(),first='😀'.repeat(2000),continuation=' x'.repeat(2000);const review=await call(5,{custom_id:m.data.custom_id,components:fields(first,continuation)});assert.match(review.content,/8000\/8000/);assert.doesNotMatch(review.content,/😀/);const confirm=find(review,'Submit note').custom_id;
  const results=await Promise.all([call(3,{custom_id:confirm}),call(3,{custom_id:confirm})]);assert.equal(results[0].content,results[1].content);assert.match(results[0].content,/Note received/);const note=await db.prepare('SELECT * FROM documentation_notes').first();assert.equal(note.text,first+continuation);assert.equal(note.source,'discord');assert.equal(note.author_member_id,'member');assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_notes').first()).n,1);assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_note_submission_keys').first()).n,1);
  const stored=await db.prepare('SELECT * FROM discord_documentation_drafts').first();assert.doesNotMatch(JSON.stringify(stored),/😀|synthetic-123/);const frozen=JSON.parse((await decryptIntegration(stored.ciphertext,stored.iv,secret)).payload).frozen;assert.equal(frozen.text,first+continuation);
  await db.prepare("UPDATE members SET discord_user_id=NULL WHERE id='member'").run();assert.equal((await call(3,{custom_id:confirm})).content,results[0].content);await db.prepare("UPDATE members SET discord_user_id=? WHERE id='member'").bind(user).run();
  assert.match((await call(5,{custom_id:m.data.custom_id,components:fields('Changed')})).content,/unavailable/);assert.equal((await db.prepare('SELECT text FROM documentation_notes').first()).text,first+continuation);
  for(const extra of [{guild_id:'123456789012345699'},{application_id:'123456789012345699'},{member:{user:{id:'123456789012345699'}}},{member:undefined}]){const response=await call(3,{custom_id:confirm},extra);assert.match(response.content??response.data.content,/unavailable/);}
  await db.prepare('DELETE FROM discord_documentation_drafts').run();const m2=await start();for(const components of [fields('x'.repeat(4001)),fields(' \n','\t'),fields('x\u0000'),[{type:1,components:[{type:4,custom_id:'first',value:'x'}]}]])assert.match((await call(5,{custom_id:m2.data.custom_id,components})).content,/unavailable/);
  const r2=await call(5,{custom_id:m2.data.custom_id,components:fields('keep trailing ',' leading\n')}),c2=find(r2,'Submit note').custom_id;deliveryFailure=true;await call(3,{custom_id:c2});deliveryFailure=false;assert.match((await call(3,{custom_id:c2})).content,/Note received/);assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_notes').first()).n,2);
  // Verification revocation between adapter reads and the domain transaction is fenced.
  const body={activityId:'activity-00',activityRevision:0,sectionRevision:0,text:'Fenced verification',idempotencyKey:'synthetic-verified-fence'};
  const wrapped={prepare:sql=>db.prepare(sql),batch:async statements=>{await db.prepare("UPDATE encrypted_integrations SET verified_at=NULL WHERE provider='discord'").run();return db.batch(statements);}};
  await assert.rejects(submitMemberDocumentationNote(wrapped,'primary',body,{channel:'discord',discordUserId:user,expectedDiscordIV:encrypted.iv}));assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_notes').first()).n,2);await db.prepare("UPDATE encrypted_integrations SET verified_at='2026-01-01' WHERE provider='discord'").run();
  for(const [disable,enable] of [["UPDATE platform_module_configuration SET documentation_enabled=0","UPDATE platform_module_configuration SET documentation_enabled=1"],["UPDATE platform_module_configuration SET documentation_enabled=0,hours_enabled=0","UPDATE platform_module_configuration SET hours_enabled=1,documentation_enabled=1"],["UPDATE installations SET discord_enabled=0","UPDATE installations SET discord_enabled=1"],["UPDATE encrypted_integrations SET verified_at=NULL","UPDATE encrypted_integrations SET verified_at='2026-01-01'"]]){await db.prepare(disable).run();assert.match((await call(2,{name:'activity-note'})).content,/unavailable/);await db.prepare(enable).run();}
  await db.prepare('DELETE FROM discord_documentation_drafts').run();for(let i=0;i<4;i++)await call(2,{name:'activity-note'});assert.match((await call(2,{name:'activity-note'})).content,/unavailable/);assert.equal((await db.prepare('SELECT COUNT(*) n FROM discord_documentation_drafts').first()).n,4);await db.prepare('UPDATE discord_documentation_drafts SET expires_at=0').run();await call(2,{name:'activity-note'});assert.equal((await db.prepare('SELECT COUNT(*) n FROM discord_documentation_drafts').first()).n,1);
  // A selected activity/section changing rejects old modal openings and edits.
  await db.prepare('DELETE FROM discord_documentation_drafts').run();
  const stale=await start();
  for(const [change,restore] of [["UPDATE hours_activities SET revision=1 WHERE id='activity-00'","UPDATE hours_activities SET revision=0 WHERE id='activity-00'"],["UPDATE hours_activities SET impact_relevant=0 WHERE id='activity-00'","UPDATE hours_activities SET impact_relevant=1 WHERE id='activity-00'"],["UPDATE hours_activities SET archived=1 WHERE id='activity-00'","UPDATE hours_activities SET archived=0 WHERE id='activity-00'"],["INSERT INTO documentation_sections(installation_id,revision,notes_enabled,summary_enabled,files_enabled) VALUES('primary',1,1,1,1)","DELETE FROM documentation_sections"]]){
   await db.prepare(change).run();
   const opened=await call(3,{custom_id:stale.data.custom_id.replace(':details',':modal')});assert.match(opened.data.content,/unavailable/);
   const edited=await call(5,{custom_id:stale.data.custom_id,components:fields('Stale draft')});assert.match(edited.content,/unavailable/);
   await db.prepare(restore).run();
  }
  await db.prepare('DELETE FROM discord_documentation_drafts').run();
  await db.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<256) INSERT INTO discord_documentation_drafts SELECT 'primary','cap-'||x,?,'other-'||x,?,0,?,NULL,'opaque','iv' FROM n").bind(config.guildId,encrypted.iv,Date.now()+60000).run();
  assert.match((await call(2,{name:'activity-note'})).content,/unavailable/);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM discord_documentation_drafts').first()).n,256);
  await db.prepare('DELETE FROM discord_documentation_drafts').run();
  // Actual signed dispatcher; no attachment-proof route or unsigned shortcut.
  const interaction={id:String(seq++),token:'synthetic-signed',type:2,application_id:config.applicationId,guild_id:config.guildId,member:{user:{id:user}},data:{name:'activity-note'}},raw=JSON.stringify(interaction),timestamp=String(Math.floor(Date.now()/1000));const signature=sign(null,Buffer.from(timestamp+raw),keys.privateKey).toString('hex');const pending=[];const request=new Request('https://fixture.test/discord/interactions',{method:'POST',headers:{'x-signature-ed25519':signature,'x-signature-timestamp':timestamp},body:raw});assert.equal((await worker.fetch(request,env,{waitUntil:p=>pending.push(p)})).status,200);await Promise.all(pending);assert.ok(messages.has('synthetic-signed'));const unsigned=await worker.fetch(new Request('https://fixture.test/discord/interactions',{method:'POST',body:raw}),env);assert.equal(unsigned.status,401);
  await db.prepare("DELETE FROM installations WHERE id='primary'").run();assert.equal((await db.prepare('SELECT COUNT(*) n FROM discord_documentation_drafts').first()).n,0);
 }finally{globalThis.fetch=originalFetch;await mf.dispose();}
});


test('Documentation guild command registration preserves core and unrelated commands across disable/re-enable',async()=>{
 let sequence=123456789012345900n;const original=globalThis.fetch,core=composeDiscordCommands([{owner:'attendance',commands:composeDiscordCommands()},{owner:'hours',commands:hoursCommands}]),c={...config,channelId:'123456789012345681',botToken:'synthetic-token'};
 const identity=command=>({...command,id:String(sequence++),application_id:c.applicationId,guild_id:c.guildId});
 let remote=[...core.map(identity),identity({name:'Unrelated',type:2,description:''})];const baseline=structuredClone(remote),writes=[];
 globalThis.fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(path.endsWith('/oauth2/applications/@me'))return Response.json({id:c.applicationId});
  if(path.endsWith('/guilds/'+c.guildId))return Response.json({id:c.guildId});
  if(path.endsWith('/channels/'+c.channelId))return Response.json({guild_id:c.guildId,type:0});
  assert.ok(path.endsWith('/commands'));
  if(init.method==='GET')return Response.json(remote);
  assert.equal(init.method,'POST');const command=JSON.parse(init.body);assert.ok(documentationCommands.some(h=>h.name===command.name));writes.push(command.name);remote.push(identity(command));return Response.json(remote.at(-1));
 };
 try{
  assert.deepEqual((await reconcileDiscordApplicationCommands(c,true,false,true)).commands,['pair','attendance-report','hours','hours-correction','activity-note','activity-file']);
  assert.deepEqual(remote.slice(0,5),baseline);assert.deepEqual(writes,['activity-note','activity-file']);
  await reconcileDiscordApplicationCommands(c,true,false,true);await reconcileDiscordApplicationCommands(c,true,false,false);await reconcileDiscordApplicationCommands(c,true,false,true);assert.equal(writes.length,2);
  assert.throws(()=>composeDiscordCommands([{owner:'hours',commands:hoursCommands}]));
 }finally{globalThis.fetch=original;}
});
