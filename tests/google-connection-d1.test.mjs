import { fullFeaturePlugin } from './helpers/full-feature-esbuild.mjs';
import { migrationStatements } from './migration-statements.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import worker, {PlatformScheduler} from '../apps/api/src/index.ts';
import {createSessionCodec,hashPassword} from '../apps/api/src/runtime-security.ts';
import {build} from 'esbuild';
import {encryptIntegration,decryptIntegration} from '../apps/api/src/integration-crypto.ts';
import {googleScopes,activeGoogleConnection,googleCapability,googleConnectionCallback,GoogleConnectionError} from '../apps/api/src/google-connection.ts';
const key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const migrations=new URL('../apps/api/migrations/',import.meta.url);
const sql=name=>migrationStatements(readFileSync(new URL(name,migrations),'utf8'));
test('shared Google connection local D1 migration, consent isolation, races and backup',{timeout:60000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));const originalFetch=globalThis.fetch;
 const originalWarn=console.warn,diagnostics=[];console.warn=(...args)=>diagnostics.push(args);
 try {
 const db=await mf.getD1Database('DB');for(const name of readdirSync(migrations).filter(x=>x.endsWith('.sql')&&x<'0031').sort())await db.batch(sql(name).map(x=>db.prepare(x)));
 await db.batch([db.prepare("INSERT INTO installations(id,created_at,auth_mode,google_enabled,google_calendar_enabled) VALUES('primary','2026-01-01','both',1,1)"),db.prepare("INSERT INTO users(id,installation_id,email,local_username,password_hash,role,created_at) VALUES('admin','primary',NULL,'admin','synthetic-hash','admin','2026-01-01'),('staff','primary','staff@example.test',NULL,NULL,'staff','2026-01-01'),('google-admin','primary','admin@example.test',NULL,NULL,'admin','2026-01-01')")]);
 const legacyLogin=await encryptIntegration({clientId:'legacy-login',clientSecret:'synthetic-only'},key),legacyCalendar=await encryptIntegration({clientId:'legacy-calendar',clientSecret:'synthetic-only',refreshToken:'synthetic-legacy',calendarId:'calendar-fixture',calendarLabel:'Synthetic calendar'},key);
 await db.batch([db.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,updated_at,verified_at) VALUES('google','primary','google',?,?,'2026-01-01','2026-01-01')").bind(legacyLogin.ciphertext,legacyLogin.iv),db.prepare("INSERT INTO google_calendar_authorizations(installation_id,ciphertext,iv,updated_at,verified_at,authorized_at) VALUES('primary',?,?,'2026-01-01','2026-01-01','2026-01-01')").bind(legacyCalendar.ciphertext,legacyCalendar.iv)]);
 await db.prepare("UPDATE users SET password_hash=? WHERE id='admin'").bind(await hashPassword('synthetic recovery password')).run();
 const before=(await db.prepare('SELECT * FROM users ORDER BY id').all()).results;await db.batch(sql('0031_google_connection.sql').map(x=>db.prepare(x)));assert.deepEqual((await db.prepare('SELECT * FROM users ORDER BY id').all()).results,before);
 for(const name of readdirSync(migrations).filter(x=>x.endsWith('.sql')&&x>'0031_google_connection.sql').sort())await db.batch(sql(name).map(x=>db.prepare(x)));
 const env={DB:db,SESSION_KEY:key,INTEGRATION_KEY:key,APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.test'};
 const session=await createSessionCodec(key).issue({userId:'admin',role:'admin'});
 const call=(path,body,method=body?'POST':'GET',cookies='lancerlogin_session='+session)=>worker.fetch(new Request('https://fixture.test'+path,{method,headers:{cookie:cookies,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
 let rev=0;const stage=async(extra={})=>{const response=await call('/admin/connections/google/candidate',{revision:rev,clientId:'shared-client',clientSecret:'synthetic-only',loginEnabled:true,calendarEnabled:true,driveEnabled:true,...extra});assert.equal(response.status,200,await response.clone().text());rev=(await response.json()).revision;};
 await stage();assert.equal((await db.prepare("SELECT ciphertext FROM encrypted_integrations WHERE provider='google'").first()).ciphertext,legacyLogin.ciphertext);
 assert.equal((await call('/admin/connections/google/promote',{revision:rev})).status,409);
 let tokenStatus=200,providerCalls=0;const eventBodies=[];
 let tokens={access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic-id',scope:['openid','email','profile',...googleScopes.calendar,...googleScopes.drive].join(' ')},subject='organization-subject',email='organization@example.test',afterToken;
 globalThis.fetch=async(url,init)=>{const href=String(url);providerCalls++;assert.ok(init?.signal);assert.equal(init.redirect,'manual');if(href==='https://oauth2.googleapis.com/token'){await afterToken?.();return Response.json(tokenStatus===200?tokens:{error:'invalid_grant',error_description:'synthetic private provider detail'},{status:tokenStatus});}if(href.startsWith('https://oauth2.googleapis.com/tokeninfo?'))return Response.json({aud:'shared-client',iss:'https://accounts.google.com',email_verified:'true',sub:subject,email,exp:Math.floor(Date.now()/1000)+3600});if(href.includes('/calendar/v3/users/me/calendarList/calendar-fixture'))return Response.json({accessRole:'writer',summary:'Synthetic calendar'});if(href.endsWith('/calendar/v3/calendars/calendar-fixture/events')){eventBodies.push(JSON.parse(init.body));return Response.json({id:'synthetic-event'});}throw Error('Unexpected provider path');};
 const begin=async(purpose,caps=[])=>{const result=await call('/admin/connections/google/authorize',{revision:rev,purpose,capabilities:caps});assert.equal(result.status,200,await result.clone().text());const target=new URL((await result.json()).authorizationUrl);assert.equal(target.searchParams.get('client_id'),'shared-client');if(purpose==='login-proof')assert.equal(target.searchParams.get('scope'),'openid email profile');return {state:target.searchParams.get('state'),cookies:result.headers.get('set-cookie').split(';')[0]};};
 const callback=async(flow,query='code=synthetic-code')=>call('/admin/connections/google/callback?'+query+'&state='+flow.state,null,'GET',flow.cookies);
 const successfulCallback=async(pending)=>{const response=await pending;assert.equal(response.status,302);assert.equal(response.headers.get('location'),env.ALLOWED_ORIGIN+'/settings/integrations?googleConnection=review');};
 const failedCallback=async(pending)=>{const response=await pending;assert.equal(response.status,302);assert.equal(response.headers.get('location'),env.ALLOWED_ORIGIN+'/settings/integrations?googleConnection=failed');assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('set-cookie'),/Max-Age=0/);assert.equal(await response.text(),'');};
 await failedCallback(call('/admin/connections/google/callback?error_description=synthetic-private&code=synthetic-code&state=synthetic-state',null,'GET',''));
 // Real-provider failure stages remain distinguishable without logging responses.
 tokenStatus=400;await failedCallback(callback(await begin('login-proof')));assert.equal(diagnostics.at(-1)[0].stage,'code_exchange');
 tokenStatus=503;await failedCallback(callback(await begin('login-proof')));assert.equal(diagnostics.at(-1)[0].category,'unavailable');
 tokenStatus=200;const priorId=tokens.id_token;tokens.id_token=undefined;await failedCallback(callback(await begin('login-proof')));assert.equal(diagnostics.at(-1)[0].stage,'identity');tokens.id_token=priorId;
 let flow=await begin('organization',['calendar','drive']);const diagnosticCount=diagnostics.length;let result=await callback(flow);await successfulCallback(Promise.resolve(result));assert.equal(diagnostics.length,diagnosticCount);rev++;await failedCallback(callback(flow));assert.equal(await activeGoogleConnection(env),undefined);
 let staged=await db.prepare('SELECT candidate_ciphertext,candidate_iv FROM google_connections').first();let payload=JSON.parse((await decryptIntegration(staged.candidate_ciphertext,staged.candidate_iv,key)).payload);assert.equal(payload.grant.subject,'organization-subject');assert.equal(payload.loginProof,false);
 // Wrong login identity cannot verify or overwrite the organizational grant.
 flow=await begin('login-proof');await failedCallback(callback(flow));email='admin@example.test';subject='admin-subject';flow=await begin('login-proof');await successfulCallback(callback(flow));rev++;
 result=await call('/admin/connections/google/calendar',{revision:rev,calendarId:'calendar-fixture'},'PUT');assert.equal(result.status,200,await result.clone().text());rev++;
 result=await call('/admin/connections/google/promote',{revision:rev});assert.equal(result.status,200,await result.clone().text());rev++;
 const active=await activeGoogleConnection(env);assert.equal(active.grant.refreshToken,'synthetic-refresh');assert.equal(active.grant.subject,'organization-subject');assert.equal(active.loginProof,true);assert.equal((await db.prepare('SELECT count(*) n FROM google_calendar_authorizations').first()).n,0);assert.equal((await db.prepare("SELECT count(*) n FROM encrypted_integrations WHERE provider='google'").first()).n,0);
 assert.equal(await (await googleCapability(env,'drive')).accessToken(),'synthetic-access');
 // One shared Calendar job uses actual local D1 and the production scheduler admission wrapper.
 await db.batch([
  db.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES('meeting','primary','Private synthetic title','2026-01-01T18:00:00Z','2026-01-01T19:00:00Z',1,'admin','2026-01-01')"),
  db.prepare("INSERT INTO google_calendar_event_mappings(installation_id,meeting_id,event_id,generation,active,updated_at) VALUES('primary','meeting','synthetic-event',1,1,'2026-01-01')"),
  db.prepare("INSERT INTO google_calendar_operations(installation_id,meeting_id,event_id,action,starts_at,ends_at,status,attempts,updated_at) VALUES('primary','meeting','synthetic-event','upsert','2026-01-01T18:00:00Z','2026-01-01T19:00:00Z','pending',0,'2026-01-01')")
 ]);
 let actualQueries=0;const wrap=statement=>({bind(...values){return wrap(statement.bind(...values));},first(){actualQueries++;return statement.first();},all(){actualQueries++;return statement.all();},run(){actualQueries++;return statement.run();},original:statement});
 const countedDb={prepare:q=>wrap(db.prepare(q)),batch:rows=>{actualQueries+=rows.length;return db.batch(rows.map(r=>r.original??r));}};
 let schedulerState={enabled:true,jobs:{'attendance.google-calendar':{next:0,last:null,outcome:'waiting'}}};
 const storage={transaction:async action=>action(),get:async()=>structuredClone(schedulerState),put:async(_,value)=>{schedulerState=structuredClone(value);},getAlarm:async()=>null,setAlarm:async()=>{},deleteAlarm:async()=>{}};
 providerCalls=0;const scheduler=new PlatformScheduler({storage},{...env,DB:countedDb,PLATFORM_SCHEDULER_MODE:'durable'});await scheduler.alarm();
 assert.equal((await db.prepare("SELECT status FROM google_calendar_operations").first()).status,'delivered');assert.equal(providerCalls,2);assert.ok(actualQueries<=32,`Shared Calendar scheduler statements: ${actualQueries}`);assert.deepEqual(Object.keys(eventBodies[0]).sort(),['end','id','start','summary']);assert.equal(eventBodies[0].summary,'LancerLogin meeting');
 console.log(`Shared Calendar local D1: ${actualQueries} statements, ${providerCalls} bounded provider requests`);
 // Staff login consumes single-use state and never mutates the organizational grant.
 email='staff@example.test';subject='staff-subject';let login=await call('/auth/google/start');assert.equal(login.status,302);let loginState=new URL(login.headers.get('location')).searchParams.get('state'),loginCookie=login.headers.get('set-cookie').split(';')[0];
 result=await call('/auth/google/callback?code=synthetic-code&state='+encodeURIComponent(loginState),null,'GET',loginCookie);assert.equal(result.status,302,await result.clone().text());assert.equal((await createSessionCodec(key).verify(result.headers.get('set-cookie').split(';')[0].split('=')[1])).role,'staff');assert.equal((await call('/auth/google/callback?code=synthetic-code&state='+encodeURIComponent(loginState),null,'GET',loginCookie)).status,400);assert.deepEqual(await activeGoogleConnection(env),active);
 // Same-client incremental consent retains refresh token only for the same organizational subject.
 await stage({clientId:undefined,clientSecret:undefined});tokens={...tokens,refresh_token:undefined,scope:googleScopes.drive.join(' ')};subject='organization-subject';email='organization@example.test';flow=await begin('organization',['drive']);await successfulCallback(callback(flow));rev++;
 staged=await db.prepare('SELECT candidate_ciphertext,candidate_iv FROM google_connections').first();payload=JSON.parse((await decryptIntegration(staged.candidate_ciphertext,staged.candidate_iv,key)).payload);assert.equal(payload.grant.refreshToken,'synthetic-refresh');assert.deepEqual(payload.grant.scopes,[...googleScopes.drive]);assert.equal((await call('/admin/connections/google/promote',{revision:rev})).status,409);assert.deepEqual(await activeGoogleConnection(env),active);
 subject='another-subject';flow=await begin('organization',['drive']);await failedCallback(callback(flow));assert.deepEqual(await activeGoogleConnection(env),active);
 flow=await begin('organization',['drive']);await failedCallback(callback(flow,'error=access_denied'));await failedCallback(callback(flow));
 // Demotion during provider I/O prevents candidate mutation, retaining the active connection.
 subject='organization-subject';flow=await begin('organization',['drive']);afterToken=async()=>db.prepare("UPDATE users SET role='staff' WHERE id='admin'").run();await failedCallback(callback(flow));afterToken=undefined;await db.prepare("UPDATE users SET role='admin' WHERE id='admin'").run();assert.deepEqual(await activeGoogleConnection(env),active);
 // Explicit cancellation preserves the active generation and invalidates pending candidate work.
 flow=await begin('organization',['drive']);result=await call('/admin/connections/google/candidate',{revision:rev},'DELETE');assert.equal(result.status,200);rev++;await failedCallback(callback(flow));assert.deepEqual(await activeGoogleConnection(env),active);
 // Backup cannot promote an unverified candidate by moving its ciphertext into the active slot.
 await stage({clientId:undefined,clientSecret:undefined});
 const proposedBackup=await (await call('/admin/data/backup?scope=installation')).json();const swapped=structuredClone(proposedBackup);swapped.tables.google_connections[0].active_ciphertext=swapped.tables.google_connections[0].candidate_ciphertext;swapped.tables.google_connections[0].active_iv=swapped.tables.google_connections[0].candidate_iv;
 assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:swapped})).status,400);assert.deepEqual(await activeGoogleConnection(env),active);
 // Logout during provider I/O invalidates authority at the callback mutation itself.
 flow=await begin('organization',['drive']);afterToken=async()=>call('/auth/logout',{});await failedCallback(callback(flow));afterToken=undefined;
 result=await call('/admin/connections/google/candidate',{revision:rev},'DELETE');assert.equal(result.status,200);rev++;
 // Anonymous login state growth is capped; expiry cleanup restores admission without storing IPs.
 await db.prepare("DELETE FROM google_login_challenges").run();await db.prepare("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<256) INSERT INTO google_login_challenges(installation_id,state_hash,client_hash,expires_at) SELECT 'primary','synthetic-cap-'||n,'synthetic-client',? FROM seq").bind(Date.now()+600000).run();
 assert.equal((await call('/auth/google/start')).status,429);assert.equal((await db.prepare('SELECT count(*) n FROM google_login_challenges').first()).n,256);
 await db.prepare('UPDATE google_login_challenges SET expires_at=0').run();const pendingLogin=await call('/auth/google/start');assert.equal(pendingLogin.status,302);const pendingState=new URL(pendingLogin.headers.get('location')).searchParams.get('state'),pendingCookie=pendingLogin.headers.get('set-cookie').split(';')[0];assert.equal((await db.prepare('SELECT count(*) n FROM google_login_challenges').first()).n,1);
 assert.equal((await call('/admin/connections/google/candidate',{revision:rev,padding:'x'.repeat(4096)})).status,413);
 const backup=await (await call('/admin/data/backup?scope=installation')).json();assert.equal(backup.schemaVersion,28);assert.equal(backup.tables.google_connections.length,1);assert.equal(backup.tables.google_connection_challenges,undefined);
 const invalid=structuredClone(backup);invalid.tables.google_connections[0].active_iv='invalid';assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:invalid})).status,400);assert.deepEqual(await activeGoogleConnection(env),active);
 result=await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup});assert.equal(result.status,200,await result.clone().text());assert.deepEqual(await activeGoogleConnection(env),active);assert.deepEqual((await db.prepare('SELECT * FROM users ORDER BY id').all()).results,before);assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await call('/auth/google/callback?code=synthetic-code&state='+encodeURIComponent(pendingState),null,'GET',pendingCookie)).status,400);
 // Explicitly reduced refresh scopes are persisted; stale staged proof cannot restore lost access.
 await stage({clientId:undefined,clientSecret:undefined});tokens={...tokens,scope:googleScopes.calendar.join(' ')};
 await assert.rejects(async()=>{await (await googleCapability(env,'drive')).accessToken();},/did not grant/);rev++;
 let state=await (await call('/admin/connections/google')).json();assert.equal(state.active.driveReady,false);assert.equal(state.active.calendarReady,true);assert.deepEqual(state.active.grantedScopes,[...googleScopes.calendar]);assert.equal((await call('/admin/connections/google/promote',{revision:rev})).status,409);
 // Revocation after staging is persisted independently of candidate revision; promotion needs fresh consent.
 await stage({clientId:undefined,clientSecret:undefined,driveEnabled:false});
 const normalProvider=globalThis.fetch;const slowCapability=await googleCapability(env,'calendar'),temporaryCapability=await googleCapability(env,'calendar'),revokingCapability=await googleCapability(env,'calendar');
 let releaseSuccess,releaseTemporary,entered=0,ready;const bothEntered=new Promise(resolve=>{ready=resolve;});
 globalThis.fetch=async()=>{entered++;if(entered===1)return new Promise(resolve=>{releaseSuccess=resolve;});if(entered===2){ready();return new Promise(resolve=>{releaseTemporary=resolve;});}return Response.json({error:'invalid_grant'},{status:400});};
 const lateSuccess=slowCapability.accessToken();const lateSuccessResult=assert.rejects(lateSuccess,/revoked/);await new Promise(resolve=>{const check=()=>entered?resolve():setTimeout(check,1);check();});
 const lateTemporary=temporaryCapability.accessToken();const lateTemporaryResult=assert.rejects(lateTemporary,/authorization/);await bothEntered;
 await assert.rejects(()=>revokingCapability.accessToken(),/authorization/);releaseSuccess(Response.json({...tokens,scope:googleScopes.drive.join(' ')}));releaseTemporary(Response.json({error:'temporary'},{status:503}));await Promise.all([lateSuccessResult,lateTemporaryResult]);globalThis.fetch=normalProvider;
 assert.equal((await activeGoogleConnection(env)).grantError,'revoked');assert.deepEqual((await activeGoogleConnection(env)).grant.scopes,[...googleScopes.calendar]);
 // Reset only the synthetic provider state to exercise the inverse completion order independently.
 await db.prepare("UPDATE google_connections SET grant_error=NULL").run();const observedCapability=await googleCapability(env,'calendar'),lateRevocationCapability=await googleCapability(env,'calendar');let releaseRevocation,observedRequests=0,revocationEntered;const revocationWaiting=new Promise(resolve=>{revocationEntered=resolve;});
 globalThis.fetch=async()=>{observedRequests++;if(observedRequests===1){revocationEntered();return new Promise(resolve=>{releaseRevocation=resolve;});}return Response.json({...tokens,scope:[...googleScopes.calendar,...googleScopes.drive].join(' ')});};
 const pendingRevocation=lateRevocationCapability.accessToken();const pendingRevocationResult=assert.rejects(pendingRevocation,/authorization/);await revocationWaiting;
 assert.equal(await observedCapability.accessToken(),'synthetic-access');rev++;releaseRevocation(Response.json({error:'invalid_grant'},{status:400}));await pendingRevocationResult;globalThis.fetch=normalProvider;
 assert.equal((await activeGoogleConnection(env)).grantError,'revoked');assert.deepEqual((await activeGoogleConnection(env)).grant.scopes,[...googleScopes.calendar,...googleScopes.drive]);
 // An omitted refresh token cannot revive the already known revoked grant.
 subject='organization-subject';email='organization@example.test';tokens={...tokens,refresh_token:undefined,scope:googleScopes.calendar.join(' ')};flow=await begin('organization',['calendar']);await failedCallback(callback(flow));

 state=await (await call('/admin/connections/google')).json();assert.equal(state.active.grantError,'revoked');assert.equal(state.active.calendarReady,false);assert.equal((await call('/admin/connections/google/promote',{revision:rev})).status,409);assert.ok(!(await (await call('/admin/connections/google')).text()).includes('synthetic private provider detail'));
 // Disabling a revoked grant cannot launder its proof for a later re-enable.
 await stage({clientId:undefined,clientSecret:undefined,calendarEnabled:false,driveEnabled:false});result=await call('/admin/connections/google/promote',{revision:rev});assert.equal(result.status,200,await result.clone().text());rev++;
 state=await (await call('/admin/connections/google')).json();assert.equal(state.active.grantError,'revoked');
 await stage({clientId:undefined,clientSecret:undefined,calendarEnabled:true,driveEnabled:false});assert.equal((await call('/admin/connections/google/promote',{revision:rev})).status,409);
 // Removal cannot strand the installation without usable local recovery.
 await db.prepare("UPDATE users SET password_hash=NULL WHERE id='admin'").run();assert.equal((await call('/admin/connections/google',{revision:rev,confirmation:'REMOVE GOOGLE CONNECTION'},'DELETE')).status,409);
 await db.prepare("UPDATE users SET password_hash=? WHERE id='admin'").bind(before.find(x=>x.id==='admin').password_hash).run();result=await call('/admin/connections/google',{revision:rev,confirmation:'REMOVE GOOGLE CONNECTION'},'DELETE');assert.equal(result.status,200,await result.clone().text());assert.equal(await activeGoogleConnection(env),undefined);assert.equal((await db.prepare("SELECT auth_mode FROM installations").first()).auth_mode,'local');
 const stages=new Set(['admission','code_exchange','identity','registered_account','organization_grant','persistence']);
 const categories=new Set(['invalid_request','authorization_rejected','access_denied','changed','size_limit','provider_failure','unavailable','internal_error']);
 for(const args of diagnostics){assert.equal(args.length,1);assert.deepEqual(Object.keys(args[0]).sort(),['category','event','stage']);assert.equal(args[0].event,'google_connection_callback_failed');assert.ok(stages.has(args[0].stage));assert.ok(categories.has(args[0].category));}
 assert.deepEqual(new Set(diagnostics.map(args=>args[0].stage)),stages);
 assert.ok(!JSON.stringify(diagnostics).includes('synthetic'));
 }finally{globalThis.fetch=originalFetch;console.warn=originalWarn;await mf.dispose();}
});

test('callback diagnostics use fixed categories and preserve the original rejection even if logging fails',async()=>{
 const originalWarn=console.warn,logs=[];console.warn=(...args)=>logs.push(args);
 const request=new Request('https://fixture.test/admin/connections/google/callback?state=synthetic-private-state&code=synthetic-private-code',{headers:{cookie:'lancerlogin_connection_state=synthetic-private-state'}});
 const categories=[[400,'invalid_request'],[415,'invalid_request'],[401,'authorization_rejected'],[403,'access_denied'],[409,'changed'],[413,'size_limit'],[502,'provider_failure'],[503,'unavailable'],[418,'internal_error']];
 try {
  for(const [status,category] of categories){const error=new GoogleConnectionError(status,'synthetic-private-error-token@example.test');const env={DB:{prepare(){throw error;}}};await assert.rejects(()=>googleConnectionCallback(request,env),actual=>actual===error);assert.deepEqual(logs.at(-1),[{event:'google_connection_callback_failed',stage:'admission',category}]);}
  const error=new Error('synthetic-private-unknown-error');await assert.rejects(()=>googleConnectionCallback(request,{DB:{prepare(){throw error;}}}),actual=>actual===error);assert.deepEqual(logs.at(-1),[{event:'google_connection_callback_failed',stage:'admission',category:'internal_error'}]);
  assert.ok(!JSON.stringify(logs).includes('synthetic'));
  console.warn=()=>{throw new Error('synthetic logger failure');};await assert.rejects(()=>googleConnectionCallback(request,{DB:{prepare(){throw error;}}}),actual=>actual===error);
 }finally{console.warn=originalWarn;}
});

test('actual workerd exchanges synthetic OAuth forms and rejects provider redirects without forwarding',{timeout:60000},async()=>{
 const source=`import {googleConnectionCallback} from './apps/api/src/google-connection.ts';
 import {encryptIntegration} from './apps/api/src/integration-crypto.ts';
 import {discordRequest} from './apps/api/src/discord-platform.ts';
 export default {async fetch(request){
  const operation=new URL(request.url).pathname;
  if(operation==='/baseline'){let rejected=false;try{new Request('https://synthetic.invalid',{redirect:'error'});}catch{rejected=true;}return Response.json({rejected});}
  if(operation==='/discord'){try{const result=await discordRequest({botToken:'synthetic-bot'},'/applications/123/commands',{method:'POST',body:'{}'});return Response.json({status:result.response.status});}catch(error){return Response.json({status:error.status,discordStatus:error.discordStatus});}}
  const key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const verifier='synthetic-verifier-'.repeat(4);
  const candidate=await encryptIntegration({installation:'primary',slot:'candidate',payload:JSON.stringify({clientId:'synthetic-client',clientSecret:'synthetic-secret',generation:'synthetic-generation',loginEnabled:true,loginProof:false})},key);
  const encryptedVerifier=await encryptIntegration({verifier},key);
  let consumed=false,persisted=false;
  const db={prepare(sql){return{bind(){return this;},async first(){if(sql.includes('FROM google_connection_challenges'))return{revision:1,actor_user_id:'synthetic-admin',session_hash:'unused',purpose:'login-proof',expires_at:Date.now()+600000,requested_scopes:'[]',verifier_ciphertext:encryptedVerifier.ciphertext,verifier_iv:encryptedVerifier.iv};if(sql.includes('FROM google_connections'))return{revision:1,candidate_ciphertext:candidate.ciphertext,candidate_iv:candidate.iv};if(sql.includes('FROM users'))return{id:'synthetic-admin'};throw Error('Unexpected fixture query');},async run(){consumed=true;return{meta:{changes:1}};}};},async batch(){persisted=true;return[{meta:{changes:1}},{meta:{changes:1}}];}};
  const original=console.warn;let diagnostic;console.warn=value=>{diagnostic=value;};
  try{const result=await googleConnectionCallback(new Request('https://fixture.test/admin/connections/google/callback?state=synthetic-state&code=synthetic-code',{headers:{cookie:'lancerlogin_connection_state=synthetic-state'}}),{DB:db,INTEGRATION_KEY:key,ALLOWED_ORIGIN:'https://fixture.test'});return Response.json({success:result.status===302&&result.headers.get('location').endsWith('=review'),consumed,persisted});}
  catch(error){return Response.json({status:error.status,diagnostic,consumed,persisted});}finally{console.warn=original;}
 }};`;
 const bundled=await build({plugins:[fullFeaturePlugin],stdin:{contents:source,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
 let mode='success',tokenCalls=0,identityCalls=0,discordCalls=0,unexpectedCalls=0;
 const outbound=async request=>{
  const url=new URL(request.url);
  if(url.origin==='https://oauth2.googleapis.com'&&url.pathname==='/token'){
   tokenCalls++;assert.equal(request.method,'POST');assert.ok(request.headers.get('content-type').startsWith('application/x-www-form-urlencoded'));
   const form=new URLSearchParams(await request.text());assert.deepEqual(Object.fromEntries(form),{client_id:'synthetic-client',client_secret:'synthetic-secret',code:'synthetic-code',code_verifier:'synthetic-verifier-'.repeat(4),redirect_uri:'https://fixture.test/api/admin/connections/google/callback',grant_type:'authorization_code'});
   if(mode.startsWith('redirect-'))return new Response('not JSON and must not be read',{status:Number(mode.slice(9)),headers:{location:'https://never-contact.invalid/private'}});
   if(mode==='denied')return Response.json({error:'synthetic-private-provider-error'},{status:400});
   if(mode==='limited')return Response.json({error:'synthetic-private-provider-error'},{status:429});
   if(mode==='malformed')return new Response('synthetic-private-invalid-json');
   if(mode==='oversized')return new Response('x'.repeat(65537));
   if(mode==='timeout')await new Promise(resolve=>setTimeout(resolve,10500));
   const chunks=['{"id_','token":"synthetic-id"}'];return new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();}}));
  }
  if(url.origin==='https://oauth2.googleapis.com'&&url.pathname==='/tokeninfo'){
   identityCalls++;if(mode==='identity-redirect')return new Response(null,{status:307,headers:{location:'https://never-contact.invalid/private'}});
   return Response.json({aud:'synthetic-client',iss:'https://accounts.google.com',email_verified:'true',sub:'synthetic-subject',email:'synthetic@example.test',exp:Math.floor(Date.now()/1000)+3600});
  }
  if(url.origin==='https://discord.com'){
   discordCalls++;assert.equal(request.headers.get('authorization'),'Bot synthetic-bot');assert.equal(await request.text(),'{}');
   if(mode==='discord-redirect')return new Response('not JSON',{status:308,headers:{location:'https://never-contact.invalid/private'}});
   return Response.json({id:'synthetic-command'});
  }
  unexpectedCalls++;return new Response(null,{status:502});
 };
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-08-01',script:bundled.outputFiles[0].text,outboundService:outbound}));
 const call=async(path='/callback')=>(await mf.dispatchFetch('http://localhost'+path)).json();
 try{
  assert.deepEqual(await call('/baseline'),{rejected:true});assert.equal(tokenCalls,0);
  assert.deepEqual(await call(),{success:true,consumed:true,persisted:true});assert.equal(tokenCalls,1);assert.equal(identityCalls,1);
  for(const [next,status,category,stage='code_exchange'] of [['redirect-301',502,'provider_failure'],['redirect-302',502,'provider_failure'],['redirect-303',502,'provider_failure'],['redirect-307',502,'provider_failure'],['redirect-308',502,'provider_failure'],['denied',401,'authorization_rejected'],['limited',503,'unavailable'],['malformed',502,'provider_failure'],['oversized',502,'provider_failure'],['identity-redirect',502,'provider_failure','identity'],['timeout',502,'provider_failure']]){
   mode=next;const result=await call();assert.deepEqual(result,{status,diagnostic:{event:'google_connection_callback_failed',stage,category},consumed:true,persisted:false},next);
  }
  mode='success';assert.deepEqual(await call('/discord'),{status:200});mode='discord-redirect';assert.deepEqual(await call('/discord'),{status:502,discordStatus:308});assert.equal(discordCalls,2);assert.equal(unexpectedCalls,0);
 }finally{await mf.dispose();}
});
