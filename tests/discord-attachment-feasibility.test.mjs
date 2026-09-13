import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import worker from '../apps/api/src/index.ts';
import {encryptIntegration} from '../apps/api/src/integration-crypto.ts';
import {attachmentDiagnostic,attachmentInteraction,attachmentAdmin,attachmentDevelopmentOrigin,discordAttachmentUrl,attachmentBytes,validateAttachmentFixture} from '../apps/api/src/discord-attachment-feasibility.ts';
import {attachmentFixtures} from '../apps/api/src/discord-attachment-fixtures.ts';
import {composeDiscordCommands,attachmentProofCommands} from '../apps/api/src/discord-platform.ts';
const key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',user='123456789012345678',config={applicationId:'123456789012345679',guildId:'123456789012345680'},attachmentId='123456789012345681';
let fixture=attachmentFixtures[0],bytes=readFileSync(new URL('../experiments/discord-attachment-spike/'+fixture.name,import.meta.url));
const cdn=()=>`https://cdn.discordapp.com/attachments/${config.guildId}/${attachmentId}/fixture.png?ex=${Math.floor(Date.now()/1000+600).toString(16)}&is=${Math.floor(Date.now()/1000-60).toString(16)}&hm=${'a'.repeat(64)}`;
test('CDN URL and streamed fixture bounds reject redirects, stale and unrecognized content',async()=>{
 assert.equal(discordAttachmentUrl(cdn(),attachmentId),cdn());
 for(const value of [cdn().replace('cdn.discordapp.com','evil.invalid'),cdn().replace('/attachments/','/other/'),cdn().replace('https:','http:'),cdn()+'&x=1',cdn().replace('cdn.discordapp.com','cdn.discordapp.com:443'),cdn().replace('fixture.png','%2fprivate'),cdn().replace(/ex=[^&]+/,'ex=1')])await assert.rejects(async()=>discordAttachmentUrl(value,attachmentId));
 for(const f of attachmentFixtures){const data=readFileSync(new URL('../experiments/discord-attachment-spike/'+f.name,import.meta.url));assert.deepEqual(await validateAttachmentFixture(data,f.mime),f);await assert.rejects(()=>validateAttachmentFixture(Buffer.concat([data,Buffer.from('corrupt')]),f.mime));}
 await assert.rejects(()=>attachmentBytes(new Response(null,{status:302}),1,Date.now()+100));
 let cancelled=false;await assert.rejects(()=>attachmentBytes(new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(20));},cancel(){cancelled=true;}})),10,Date.now()+100));assert.equal(cancelled,true);
 await assert.rejects(()=>attachmentBytes(new Response(bytes,{headers:{'content-length':'1'}}),bytes.length,Date.now()+100));
});
test('signed modal transfer persists one private fixture, fences retries/rotation and retains ambiguous identity', {timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']})),original=globalThis.fetch;
 try{
  const db=await mf.getD1Database('DB');for(const name of readdirSync(new URL('../apps/api/migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL('../apps/api/migrations/'+name,import.meta.url),'utf8')).map(s=>db.prepare(s)));
  const keys=generateKeyPairSync('ed25519'),discord=await encryptIntegration({...config,publicKey:keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex')},key);
  const active={clientId:'synthetic-client',clientSecret:'synthetic-secret',generation:'synthetic-generation',driveEnabled:true,organizationProof:true,grant:{proofId:'synthetic-proof',subject:'synthetic-subject',refreshToken:'synthetic-refresh',scopes:['https://www.googleapis.com/auth/drive.file']}};
  const google=await encryptIntegration({installation:'primary',slot:'active',payload:JSON.stringify(active)},key);
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode,discord_enabled) VALUES('primary','2026-01-01','local',1)"),
   db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','synthetic-admin','admin','2026-01-01')"),
   db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,discord_user_id,created_at) VALUES('member','primary','synthetic-id','Synthetic','Member',?,'2026-01-01')").bind(user),
   db.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,updated_at,verified_at) VALUES('discord','primary','discord',?,?,'2026-01-01','2026-01-01')").bind(discord.ciphertext,discord.iv),
   db.prepare("INSERT INTO google_connections(installation_id,shared_mode,revision,active_ciphertext,active_iv,updated_at,grant_proof_id) VALUES('primary',1,1,?,?,'2026-01-01','synthetic-proof')").bind(google.ciphertext,google.iv),
   db.prepare("INSERT INTO google_drive_feasibility VALUES('primary',1,'synthetic-project','synthetic-key','synthetic-root','Synthetic root','synthetic-generation')")
  ]);
  const env={DB:db,INTEGRATION_KEY:key,SESSION_KEY:key,ALLOWED_ORIGIN:attachmentDevelopmentOrigin,APP_MODE:'configured'};let counter=123456789012345700n,mode='',creates=0,downloads=0,allocated=0;const files=new Map();
  globalThis.fetch=async(url,init={})=>{
   const u=new URL(url),headers=new Headers(init.headers);assert.equal(init.redirect,'manual');
   if(u.hostname==='cdn.discordapp.com'){downloads++;assert.equal(headers.has('authorization'),false);if(mode==='timeout')throw new DOMException('synthetic-secret-url','TimeoutError');if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://evil.invalid'}});if(mode==='rotate')await db.prepare('UPDATE encrypted_integrations SET iv=?').bind('other-iv').run();return new Response(mode==='corrupt'?Buffer.alloc(bytes.length):bytes);}
   if(u.hostname==='discord.com'){assert.equal(headers.has('authorization'),false);if(mode==='reply')throw Error('synthetic unavailable');return Response.json({});}
   if(u.pathname==='/token')return Response.json({access_token:'synthetic-organizational-token'});
   assert.equal(headers.get('authorization'),'Bearer synthetic-organizational-token');
   if(u.pathname.endsWith('/generateIds'))return Response.json({ids:['synthetic-file-'+(++allocated)]});
   if(u.pathname.includes('/permissions'))return Response.json({permissions:[{type:mode==='public'?'anyone':'user',role:mode==='public'?'reader':'owner'}]});
   if(u.pathname.startsWith('/upload/')){creates++;const text=await init.body.text(),id=/"id":"([^"]+)"/.exec(text)[1],marker=/"lancerloginAttachmentProof":"([^"]+)"/.exec(text)[1];assert.equal(files.has(id),false);files.set(id,{id,mimeType:fixture.mime,parents:['synthetic-root'],trashed:false,ownedByMe:true,size:String(bytes.length),sha256Checksum:fixture.sha256,appProperties:{lancerloginAttachmentProof:marker}});if(mode==='uncertain')throw Error('synthetic lost response');return Response.json({id});}
   if(u.pathname.endsWith('/synthetic-root'))return Response.json({id:'synthetic-root',mimeType:'application/vnd.google-apps.folder',ownedByMe:true,trashed:false,capabilities:{canAddChildren:true}});
   const file=files.get(u.pathname.split('/').at(-1));return file?Response.json(mode==='parents'?{...file,parents:['wrong-parent']}:file):new Response(null,{status:404});
  };
  async function send(type,data,overrides={},runtime=env){const dto={id:String(counter++),application_id:config.applicationId,guild_id:config.guildId,member:{user:{id:user}},token:'synthetic-interaction',type,data,...overrides},raw=JSON.stringify(dto),timestamp=String(Math.floor(Date.now()/1000)),pending=[];const signature=sign(null,Buffer.from(timestamp+raw),keys.privateKey).toString('hex');const response=await worker.fetch(new Request('https://fixture.test/discord/interactions',{method:'POST',headers:{'x-signature-ed25519':signature,'x-signature-timestamp':timestamp},body:raw}),runtime,{waitUntil:p=>pending.push(p)});const body=await response.json();return {body,done:()=>Promise.all(pending),dto};}
  const start=async()=>{const r=await send(2,{name:'attachment-proof'});assert.equal(r.body.type,9);assert.equal(r.body.data.components[0].type,18);assert.equal(r.body.data.components[0].component.type,19);return r.body.data.custom_id;};
  const data=id=>({custom_id:id,components:[{id:1,type:18,component:{id:2,type:19,custom_id:'fixture',values:[attachmentId]}}],resolved:{attachments:{[attachmentId]:{id:attachmentId,ephemeral:true,filename:fixture.name,content_type:fixture.mime,size:bytes.length,url:cdn()}}}});
  let custom=await start(),result=await send(5,data(custom));assert.equal(result.body.type,5);assert.equal(result.body.data.flags,64);await result.done();let row=await db.prepare('SELECT * FROM discord_attachment_proofs WHERE id=?').bind(custom.slice(5)).first();assert.equal(row.status,'saved');assert.equal(creates,1);assert.equal(downloads,1);assert.equal(row.sha256,fixture.sha256);assert.ok(!JSON.stringify(row).includes('cdn.discordapp'));
  result=await send(5,data(custom),{id:result.dto.id});await result.done();assert.equal(creates,1);assert.equal(downloads,1);
  fixture=attachmentFixtures[1];bytes=readFileSync(new URL('../experiments/discord-attachment-spike/'+fixture.name,import.meta.url));custom=await start();const renamed=data(custom);renamed.resolved.attachments[attachmentId].filename='LancerLogin synthetic attachment (1).pdf';result=await send(5,renamed);await result.done();assert.equal((await db.prepare('SELECT status FROM discord_attachment_proofs WHERE id=?').bind(custom.slice(5)).first()).status,'saved');assert.ok(bytes.length>600000);
  await db.prepare('UPDATE members SET active=0').run();assert.equal((await send(2,{name:'attachment-proof'})).body.type,4);await db.prepare('UPDATE members SET active=1').run();
  for(const problem of ['redirect','rotate','uncertain','reply','public','parents','corrupt','timeout']){mode=problem;custom=await start();result=await send(5,data(custom));await result.done();row=await db.prepare('SELECT * FROM discord_attachment_proofs WHERE id=?').bind(custom.slice(5)).first();if(problem==='rotate')await db.prepare('UPDATE encrypted_integrations SET iv=?').bind(discord.iv).run();assert.equal(row.status,['uncertain','parents'].includes(problem)?'pending':problem==='reply'?'saved':'failed');
   if(problem==='timeout'){assert.deepEqual(JSON.parse((await db.prepare('SELECT metadata_json FROM audit_log WHERE id=?').bind('attachment-diagnostic:'+row.id).first()).metadata_json),{stage:'cdn_fetch',category:'deadline_elapsed'});}
   if(problem==='corrupt'){assert.deepEqual(JSON.parse((await db.prepare('SELECT metadata_json FROM audit_log WHERE id=?').bind('attachment-diagnostic:'+row.id).first()).metadata_json),{stage:'fixture_hash',category:'failed'});}
   if(['uncertain','parents'].includes(problem)){
    const diagnostic=JSON.parse((await db.prepare('SELECT metadata_json FROM audit_log WHERE id=?').bind('attachment-diagnostic:'+row.id).first()).metadata_json);assert.equal(diagnostic.stage,problem==='uncertain'?'upload':'verify');assert.equal(diagnostic.category,'failed');
    assert.ok(row.file_id);assert.equal(row.sha256,fixture.sha256);await assert.rejects(()=>db.prepare("DELETE FROM installations WHERE id='primary'").run(),/Synthetic attachment/);assert.equal(row.busy_until,0);
    const count=creates;mode='';const response=await attachmentAdmin(new Request('https://fixture.test/admin/integrations/discord/attachment-proofs/'+row.id+'/reconcile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmation:'VERIFY SYNTHETIC ATTACHMENT'})}),env,{userId:'admin',expiresAt:Date.now()+60000});assert.equal((await response.json()).status,'saved');assert.equal(creates,count);
   }
  }

  mode='';
  for(const [expected,change] of [
   ['shape',d=>{d.components=[];}],['selection',d=>{d.components[0].component.values=[];}],['resolved',d=>{d.resolved.attachments={};}],
   ['filename',d=>{d.resolved.attachments[attachmentId].filename='sensitive-source-name'.repeat(30);}],['mime',d=>{d.resolved.attachments[attachmentId].content_type='sensitive-mime';}],
   ['size',d=>{d.resolved.attachments[attachmentId].size=1;}],['url',d=>{d.resolved.attachments[attachmentId].url='https://private.invalid/secret-token';}]
  ]){
   custom=await start();const malformed=data(custom);change(malformed);const before=creates;result=await send(5,malformed);await result.done();
   row=await db.prepare('SELECT * FROM discord_attachment_proofs WHERE id=?').bind(custom.slice(5)).first();assert.equal(row.status,'failed');assert.equal(row.file_id,null);assert.equal(creates,before);
   const audit=await db.prepare('SELECT * FROM audit_log WHERE id=?').bind('attachment-diagnostic:'+row.id).first();assert.equal(audit.actor_user_id,null);assert.deepEqual(JSON.parse(audit.metadata_json),{stage:expected,category:'failed'});assert.ok(!JSON.stringify(audit).includes('sensitive'));assert.ok(!JSON.stringify(audit).includes('secret-token'));assert.ok(!JSON.stringify(audit).includes(user));
   const read=await attachmentAdmin(new Request('https://fixture.test/admin/integrations/discord/attachment-proofs/'+row.id),env,{userId:'admin',expiresAt:Date.now()+60000});assert.deepEqual((await read.json()).diagnostic,{stage:expected,category:'failed'});
   await db.prepare("UPDATE audit_log SET metadata_json=? WHERE id=?").bind(JSON.stringify({stage:'sensitive-stage',category:'secret-token'}),'attachment-diagnostic:'+row.id).run();assert.equal((await (await attachmentAdmin(new Request('https://fixture.test/admin/integrations/discord/attachment-proofs/'+row.id),env,{userId:'admin',expiresAt:Date.now()+60000})).json()).diagnostic,null);
   await db.prepare('DELETE FROM discord_attachment_proofs WHERE id=?').bind(row.id).run();
  }
  mode='';assert.equal((await send(2,{name:'attachment-proof'},{},{...env,ALLOWED_ORIGIN:'https://production.invalid'})).body.type,4);
  const command=await send(2,{name:'attachment-proof'},{guild_id:'999999999999999999'});assert.equal(command.body.type,4);
  assert.deepEqual(composeDiscordCommands().map(c=>c.name),['pair','attendance-report']);assert.equal(attachmentProofCommands[0].name,'attachment-proof');
  // Transient receipts clear only after uncertain writes are resolved, preserving
  // the portable installation backup contract without replaying external work.
  custom=await start();const createdBeforeRestore=creates;
  const racedDb={prepare(sql){const prepared=db.prepare(sql);if(!sql.includes("SET status='pending',file_id="))return prepared;return {bind(...args){return {async run(){
   await assert.rejects(()=>db.prepare("DELETE FROM installations WHERE id='primary'").run(),/Synthetic attachment/);
   // Once pre-dispatch admission has expired, restore can clear the row. The
   // original pending CAS must then fail, so no late provider create occurs.
   await db.prepare("UPDATE discord_attachment_proofs SET busy_until=0 WHERE status='processing'").run();await db.prepare("DELETE FROM installations WHERE id='primary'").run();return prepared.bind(...args).run();
  }};}};}};
  result=await send(5,data(custom),{},{...env,DB:racedDb});await result.done();assert.equal(creates,createdBeforeRestore);assert.equal((await db.prepare('SELECT COUNT(*) n FROM discord_attachment_proofs').first()).n,0);
 }finally{globalThis.fetch=original;await mf.dispose();}
});

test('diagnostic projection accepts only fixed stage/category pairs',()=>{for(const value of [null,{}, {stage:'started',category:'failed'},{stage:'complete',category:'failed'},{stage:'url',category:'started'},{stage:'url',category:'failed',raw:'secret'}])assert.equal(attachmentDiagnostic(value),null);assert.deepEqual(attachmentDiagnostic({stage:'cdn_body',category:'deadline_elapsed'}),{stage:'cdn_body',category:'deadline_elapsed'});});
