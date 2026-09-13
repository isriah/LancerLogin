import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import worker from '../apps/api/src/index.ts';
import {encryptIntegration,decryptIntegration} from '../apps/api/src/integration-crypto.ts';
import {createSessionCodec} from '../apps/api/src/runtime-security.ts';
import {drivePickerRoute,drivePickerCallback} from '../apps/api/src/google-drive-picker.ts';
const key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',scope='https://www.googleapis.com/auth/drive.file';
test('Picker local D1 isolates online consent, exact scope/account, single claim and stale authority', {timeout:120000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']})),original=globalThis.fetch;
 try{
  const db=await mf.getD1Database('DB'),migrations=new URL('../apps/api/migrations/',import.meta.url);for(const name of readdirSync(migrations).filter(x=>x.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL(name,migrations),'utf8')).map(x=>db.prepare(x)));
  await db.batch([db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local')"),db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','synthetic-admin','admin','2026-01-01'),('staff','primary','synthetic-staff','staff','2026-01-01')")]);
  const active={clientId:'synthetic-client',clientSecret:'synthetic-secret',generation:'synthetic-generation',driveEnabled:true,organizationProof:true,grant:{proofId:'synthetic-proof',subject:'synthetic-subject',refreshToken:'synthetic-refresh',scopes:[scope,'https://www.googleapis.com/auth/calendar.events']}};
  const encrypted=await encryptIntegration({installation:'primary',slot:'active',payload:JSON.stringify(active)},key);
  await db.prepare("INSERT INTO google_connections(installation_id,shared_mode,revision,active_ciphertext,active_iv,updated_at,grant_proof_id) VALUES('primary',1,1,?,?,'2026-01-01','synthetic-proof')").bind(encrypted.ciphertext,encrypted.iv).run();
  const before=await db.prepare('SELECT * FROM google_connections').first(),env={DB:db,SESSION_KEY:key,INTEGRATION_KEY:key,ALLOWED_ORIGIN:'https://fixture.test',APP_MODE:'configured'},session=await createSessionCodec(key).issue({userId:'admin',role:'admin'});
  const call=(path,input,method=input?'POST':'GET',cookies='lancerlogin_session='+session)=>worker.fetch(new Request('https://fixture.test'+path,{method,headers:{cookie:cookies,...(input?{'content-type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})}),env),base='/admin/connections/google/drive';
  assert.equal((await call(base+'/configuration',{revision:1,configRevision:0,projectNumber:'123456',browserKey:'synthetic_browser_key_0000'},'PUT')).status,200);
  let tokenScope=scope,subject='synthetic-subject',issued='synthetic-client',expire=3600,calls=0,driveProblem='';
  globalThis.fetch=async(url,init)=>{calls++;if(String(url).includes('/drive/v3/about')){assert.equal(String(url),'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)');const organizational=init.headers.authorization==='Bearer synthetic-organization-token';assert.ok(organizational||init.headers.authorization==='Bearer synthetic-picker-token');if(driveProblem==='provider')return new Response(null,{status:503});if(organizational&&driveProblem==='rotation')await db.prepare('UPDATE google_connections SET active_iv=?').bind('AAAAAAAAAAAAAAAA').run();return Response.json({user:{permissionId:driveProblem==='invalid'?null:driveProblem==='foreign'&&!organizational?'other-drive-user':'synthetic-drive-user'}});}if(String(url).includes('/tokeninfo'))return Response.json({scope:tokenScope,user_id:subject,audience:issued,issued_to:issued,expires_in:expire});if(new URLSearchParams(init.body).get('grant_type')==='refresh_token')return Response.json({access_token:'synthetic-organization-token'});assert.equal(new URLSearchParams(init.body).get('grant_type'),'authorization_code');return Response.json({access_token:'synthetic-picker-token',scope:tokenScope,token_type:'Bearer',expires_in:expire,refresh_token:'must-never-store'});};
  const authorize=async()=>{const response=await call(base+'/picker/authorize',{revision:1,purpose:'root'});assert.equal(response.status,200,await response.clone().text());const url=new URL((await response.json()).authorizationUrl);assert.equal(url.searchParams.get('scope'),scope);assert.equal(url.searchParams.get('include_granted_scopes'),'false');assert.equal(url.searchParams.get('access_type'),'online');return url.searchParams.get('state');};
  const callback=state=>call('/admin/connections/google/callback?state='+state+'&code=synthetic-code',undefined,'GET','lancerlogin_picker_state='+state);
  let state=await authorize();assert.match((await callback(state)).headers.get('location'),/drivePicker=ready$/);let status=await (await call(base+'/status')).json();const payload={revision:1,intentId:status.intent.id};
  const [a,b]=await Promise.all([call(base+'/picker/claim',payload),call(base+'/picker/claim',payload)]);assert.deepEqual([a.status,b.status].sort(),[200,409]);const claim=await (a.status===200?a:b).json();assert.equal(claim.accessToken,'synthetic-picker-token');assert.equal(claim.scope,scope);assert.ok(!JSON.stringify(await db.prepare('SELECT * FROM google_picker_intents').first()).includes('synthetic-picker-token'));assert.deepEqual(await db.prepare('SELECT * FROM google_connections').first(),before);
  const replayCalls=calls;assert.match((await callback(state)).headers.get('location'),/failed$/);assert.equal(calls,replayCalls);
  state=await authorize();await callback(state);status=await (await call(base+'/status')).json();
  const fencedDb={prepare(sql){
   const prepared=db.prepare(sql);if(!sql.includes("SET status='claimed'"))return prepared;
   return {bind(...args){return {async run(){
    await db.prepare("UPDATE google_connections SET active_iv=? WHERE installation_id='primary'").bind('AAAAAAAAAAAAAAAA').run();
    return prepared.bind(...args).run();
   }};}};
  }};
  await assert.rejects(()=>drivePickerRoute(new Request('https://fixture.test'+base+'/picker/claim',{method:'POST',headers:{cookie:'lancerlogin_session='+session,'content-type':'application/json'},body:JSON.stringify({revision:1,intentId:status.intent.id})}),{...env,DB:fencedDb},{userId:'admin',expiresAt:Date.now()+60000}),/changed/);await db.prepare("UPDATE google_connections SET active_iv=? WHERE installation_id='primary'").bind(encrypted.iv).run();
  for(const problem of ['scope','client','expiry']){tokenScope=scope;subject='synthetic-subject';issued='synthetic-client';expire=3600;if(problem==='scope')tokenScope+=' https://www.googleapis.com/auth/calendar.events';if(problem==='subject')subject='other';if(problem==='client')issued='other';if(problem==='expiry')expire=0;state=await authorize();assert.match((await callback(state)).headers.get('location'),/failed$/);const status=await (await call(base+'/status')).json();assert.equal(status.intent.status,'exchanging');assert.deepEqual(status.intent.diagnostic,{stage:['scope','expiry'].includes(problem)?'token_validation':'identity_validation',reason:{scope:'scope_mismatch',subject:'subject_mismatch',client:'client_mismatch',expiry:'expiry_shape'}[problem]});}
  tokenScope=scope;issued='synthetic-client';expire=3600;
  for(const tokenSubject of [undefined,'different-identifier-format']){subject=tokenSubject;state=await authorize();assert.match((await callback(state)).headers.get('location'),/ready$/);}
  for(const problem of ['foreign','invalid','provider','rotation']){
   driveProblem=problem;state=await authorize();assert.match((await callback(state)).headers.get('location'),/failed$/);
   if(problem==='rotation')await db.prepare('UPDATE google_connections SET active_iv=?').bind(encrypted.iv).run();
   const observed=await(await call(base+'/status')).json();assert.equal(observed.intent.status,'exchanging');
   if(problem!=='rotation')assert.deepEqual(observed.intent.diagnostic,{stage:'drive_identity',reason:{foreign:'account_mismatch',invalid:'identity_invalid',provider:'provider_unconfirmed'}[problem]});
   assert.equal((await call(base+'/picker/claim',{revision:1,intentId:observed.intent.id})).status,409);
  }
  driveProblem='';subject='synthetic-subject';
  state=await authorize();
  const callbackRaceDb={prepare(sql){const prepared=db.prepare(sql);if(!sql.includes("SET status='ready'"))return prepared;return {bind(...args){return {async run(){await db.prepare('UPDATE google_connections SET active_iv=?').bind('AAAAAAAAAAAAAAAA').run();return prepared.bind(...args).run();}};}};}};
  assert.match((await drivePickerCallback(new Request('https://fixture.test/admin/connections/google/callback?state='+state+'&code=synthetic-code',{headers:{cookie:'lancerlogin_picker_state='+state}}),{...env,DB:callbackRaceDb})).headers.get('location'),/failed$/);
  assert.equal((await db.prepare('SELECT status FROM google_picker_intents').first()).status,'exchanging');
  await db.prepare('UPDATE google_connections SET active_iv=?').bind(encrypted.iv).run();

  const successfulFetch=globalThis.fetch;
  for(const [kind,expected] of [
   ['exchange_rejected',{stage:'code_exchange',reason:'provider_unconfirmed'}],
   ['exchange_throw',{stage:'code_exchange',reason:'provider_unconfirmed'}],
   ['token_missing',{stage:'token_validation',reason:'access_token_shape'}],
   ['token_type',{stage:'token_validation',reason:'token_type_mismatch'}],
   ['token_expiry_string',{stage:'token_validation',reason:'expiry_shape'}],
   ['info_rejected',{stage:'token_information',reason:'provider_unconfirmed'}],
   ['info_scope',{stage:'identity_validation',reason:'scope_mismatch'}],
   ['info_expiry',{stage:'identity_validation',reason:'expiry_shape'}],
   ['consent',{stage:'admission',reason:'consent_declined'}],
   ['code',{stage:'admission',reason:'code_missing'}],
  ]){
   globalThis.fetch=async url=>{
    if(kind==='exchange_throw')throw Error('synthetic-private-provider-error');
    const info=String(url).includes('/tokeninfo');
    if(kind===(info?'info_rejected':'exchange_rejected'))return Response.json({error:'synthetic-private-provider-error'},{status:400});
    return Response.json(info?{scope:kind==='info_scope'?'synthetic-private-scope':scope,user_id:'synthetic-subject',audience:'synthetic-client',issued_to:'synthetic-client',expires_in:kind==='info_expiry'?'3600':3600}:{access_token:kind==='token_missing'?null:'synthetic-private-access-token',scope,token_type:kind==='token_type'?'synthetic-private-type':'Bearer',expires_in:kind==='token_expiry_string'?'3600':3600});
   };
   state=await authorize();const response=kind==='consent'||kind==='code'?await call('/admin/connections/google/callback?state='+state+(kind==='consent'?'&error=synthetic-private-error':''),undefined,'GET','lancerlogin_picker_state='+state):await callback(state);
   assert.equal(response.headers.get('location'),'https://fixture.test/settings/integrations?drivePicker=failed');
   const status=await (await call(base+'/status')).json();assert.deepEqual(status.intent.diagnostic,expected);
   assert.doesNotMatch(JSON.stringify(status),/synthetic-private|synthetic-client|synthetic-subject|ciphertext|verifier|failureStage/);
   const saved=await db.prepare('SELECT * FROM google_picker_intents').first();const envelope=await decryptIntegration(saved.ciphertext,saved.iv,key);
   assert.deepEqual(envelope,{installation:'primary',purpose:'drive-picker',failureStage:expected.stage,failureReason:expected.reason});
   assert.deepEqual(await db.prepare('SELECT * FROM google_connections').first(),before);
   const secondSession=await createSessionCodec(key).issue({userId:'admin',role:'admin'});assert.equal((await (await call(base+'/status',undefined,'GET','lancerlogin_session='+secondSession)).json()).intent,null);
   assert.equal((await call(base+'/picker/claim',{revision:1,intentId:status.intent.id})).status,409);
   const prior=saved.iv;await callback(state);assert.equal((await db.prepare('SELECT iv FROM google_picker_intents').first()).iv,prior);
  }
  // Authenticated malformed/old envelopes cannot turn storage into an output channel.
  for(const envelope of [{verifier:'synthetic-private-verifier'},{failureStage:'token_validation',failureReason:'subject_mismatch'},{failureStage:'synthetic-private-stage',failureReason:'scope_mismatch'},{failureStage:'identity_validation',failureReason:'synthetic-private-reason'}]){
   const sealed=await encryptIntegration({installation:'primary',purpose:'drive-picker',...envelope},key);
   await db.prepare('UPDATE google_picker_intents SET ciphertext=?,iv=?').bind(sealed.ciphertext,sealed.iv).run();
   assert.equal((await (await call(base+'/status')).json()).intent.diagnostic,undefined);
  }
  // Diagnostic failures and authority/expiry races cannot change callback outcome
  // or overwrite the consumed verifier after its authority has ended.
  for(const race of ['storage','expiry','demotion']){
   state=await authorize();const prior=await db.prepare('SELECT iv FROM google_picker_intents').first();
   globalThis.fetch=async()=>{
    if(race==='expiry')await db.prepare('UPDATE google_picker_intents SET expires_at=0').run();
    if(race==='demotion')await db.prepare("UPDATE users SET role='staff' WHERE id='admin'").run();
    return Response.json({error:'synthetic-private-error'},{status:400});
   };
   const unavailable={prepare(sql){if(sql.includes("SET ciphertext=?,iv=? WHERE"))return {bind(){return {async run(){throw Error('synthetic-private-storage');}};}};return db.prepare(sql);}};
   const response=await drivePickerCallback(new Request('https://fixture.test/admin/connections/google/callback?state='+state+'&code=synthetic-code',{headers:{cookie:'lancerlogin_picker_state='+state}}),{...env,DB:race==='storage'?unavailable:db});
   assert.equal(response.headers.get('location'),'https://fixture.test/settings/integrations?drivePicker=failed');
   assert.equal((await db.prepare('SELECT iv FROM google_picker_intents').first()).iv,prior.iv);
   if(race==='demotion'){assert.equal((await call(base+'/status')).status,403);await db.prepare("UPDATE users SET role='admin' WHERE id='admin'").run();}
  }
  globalThis.fetch=successfulFetch;
  // Product selection is isolated from Admin configuration and synthetic proof intent.
  tokenScope=scope;subject='synthetic-subject';issued='synthetic-client';expire=3600;
  await db.prepare("INSERT INTO platform_module_configuration(installation_id,hours_enabled,documentation_enabled) VALUES('primary',1,1)").run();
  await db.prepare("INSERT INTO platform_module_grants(installation_id,user_id,hours_manage,documentation_manage) VALUES('primary','staff',1,0)").run();
  const staffSession=await createSessionCodec(key).issue({userId:'staff',role:'staff'}),staffCookies='lancerlogin_session='+staffSession;
  const staffCall=(path,input,method=input?'POST':'GET')=>call(base+path,input,method,staffCookies);
  assert.equal((await staffCall('/picker/authorize',{revision:1,purpose:'documentation-source'})).status,403);
  await db.prepare("UPDATE platform_module_grants SET documentation_manage=1 WHERE user_id='staff'").run();
  assert.equal((await staffCall('/picker/authorize',{revision:1,purpose:'root'})).status,403);
  assert.equal((await staffCall('/configuration',{revision:1,configRevision:1,projectNumber:'123456',browserKey:'synthetic_browser_key_0000'},'PUT')).status,403);
  const staffAuthorization=await staffCall('/picker/authorize',{revision:1,purpose:'documentation-source'});assert.equal(staffAuthorization.status,200);
  const staffState=new URL((await staffAuthorization.json()).authorizationUrl).searchParams.get('state');
  assert.equal((await callback(staffState)).headers.get('location'),'https://fixture.test/documentation?drivePicker=ready');
  const staffIntent=(await (await staffCall('/status?purpose=documentation-source')).json()).intent;
  assert.equal(staffIntent.purpose,'documentation-source');
  assert.equal((await call(base+'/picker/claim',{revision:1,intentId:staffIntent.id})).status,409);
  assert.equal((await staffCall('/picker/claim',{revision:1,intentId:staffIntent.id})).status,200);
  globalThis.fetch=async(url,init)=>String(url).includes('/drive/v3/files/')?Response.json({id:'selected',name:'Synthetic ordinary source',mimeType:'application/vnd.google-apps.presentation',version:'7',trashed:false,ownedByMe:false,capabilities:{canCopy:true}}):successfulFetch(url,init);
  assert.equal((await staffCall('/selection',{revision:1,intentId:staffIntent.id,fileId:'selected'})).status,200);
  await db.prepare("UPDATE platform_module_grants SET documentation_manage=0 WHERE user_id='staff'").run();
  assert.equal((await staffCall('/status?purpose=documentation-source')).status,403);
  globalThis.fetch=successfulFetch;
  tokenScope=scope;subject='synthetic-subject';issued='synthetic-client';expire=3600;state=await authorize();await call('/auth/logout',{});assert.match((await callback(state)).headers.get('location'),/failed$/);
  state=await authorize();await db.prepare("UPDATE users SET role='staff' WHERE id='admin'").run();assert.match((await callback(state)).headers.get('location'),/failed$/);assert.equal((await call(base+'/status')).status,403);assert.deepEqual(await db.prepare('SELECT * FROM google_connections').first(),before);
  const callsBeforeRestore=calls;await db.prepare("DELETE FROM installations WHERE id='primary'").run();for(const table of ['google_picker_intents','google_drive_feasibility','google_drive_proof_runs'])assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM '+table).first()).n,0);assert.equal(calls,callsBeforeRestore);
 }finally{globalThis.fetch=original;await mf.dispose();}
});
