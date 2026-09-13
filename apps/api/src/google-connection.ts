import { documentationAvailable } from '../../../packages/shared/src/release-capabilities.ts';
import { providerFetch } from './maintenance.ts';
import { encryptIntegration, decryptIntegration } from './integration-crypto.ts';
import { schedulerBudgetKey } from './scheduler-budget.ts';
import type { Env } from './index.ts';
export class GoogleConnectionError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status=status; } }
const fail = (status: number, message: string): never => { throw new GoogleConnectionError(status, message); };
export const googleScopes = { calendar: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'], drive: ['https://www.googleapis.com/auth/drive.file'] } as const;
type Grant = { proofId: string; refreshToken: string; subject: string; scopes: string[] };
export type GoogleConnection = { clientId: string; clientSecret: string; loginEnabled: boolean; calendarEnabled: boolean; driveEnabled: boolean; generation: string; loginProof: boolean; organizationProof: boolean; loginVerifiedAt?: string; loginProofUserId?: string; loginProofEmail?: string; authorizedAt?: string; calendarVerifiedAt?: string; grant?: Grant; calendarId?: string; calendarPinnedId?: string; calendarLabel?: string; calendarProof: boolean; legacyFingerprint: string; baseGrantProofId?: string; grantError?: "revoked" | "temporary" };
type Row = { grant_proof_id: string | null; shared_mode: number; grant_error: "revoked" | "temporary" | null; revision: number; active_ciphertext: string | null; active_iv: string | null; candidate_ciphertext: string | null; candidate_iv: string | null; updated_at: string };
type Actor = { userId: string; expiresAt: number };
const dbOf = (env: Env) => env.DB ?? fail(503, 'D1 is not linked');
const keyOf = (env: Env) => env.INTEGRATION_KEY ?? fail(503, 'Integration encryption is not configured');
const adminSQL = "EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND id=? AND role='admin' AND active=1)";
const recoverySQL = "EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND role='admin' AND active=1 AND password_hash GLOB 'scrypt$32768$8$1$*' AND length(local_username)>0)";
const cookie = (request: Request, name: string) => request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);
const json = (value: unknown) => Response.json(value, {headers:{'cache-control':'no-store'}});
export const googleHash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
export async function googleConnectionRow(env: Env): Promise<Row | null> { return dbOf(env).prepare("SELECT grant_proof_id,shared_mode,grant_error,revision,active_ciphertext,active_iv,candidate_ciphertext,candidate_iv,updated_at FROM google_connections WHERE installation_id='primary'").first<Row>(); }
async function unpack(env: Env, ciphertext: string, iv: string, slot='candidate'): Promise<GoogleConnection> { const envelope=await decryptIntegration(ciphertext,iv,keyOf(env));if(envelope.installation!=='primary'||envelope.slot!==slot)return fail(409,'Google connection envelope does not match its purpose');return JSON.parse(envelope.payload) as GoogleConnection; }
async function pack(env: Env, value: GoogleConnection, slot='candidate') { return encryptIntegration({payload:JSON.stringify(value),installation:'primary',slot},keyOf(env)); }
export async function activeGoogleConnection(env: Env): Promise<GoogleConnection | undefined> { const row=await googleConnectionRow(env); if(!row?.active_ciphertext||!row.active_iv)return undefined;const value=await unpack(env,row.active_ciphertext,row.active_iv,'active');value.grantError=row.grant_error??undefined;return value; }
async function candidate(env: Env) { const row=await googleConnectionRow(env); if(!row?.candidate_ciphertext || !row.candidate_iv) return fail(409,'Stage a Google connection first'); return {row,value:await unpack(env,row.candidate_ciphertext,row.candidate_iv)}; }
async function legacyFingerprint(env: Env) {
 const db=dbOf(env); const values=await Promise.all([
  db.prepare("SELECT ciphertext,iv FROM encrypted_integrations WHERE installation_id='primary' AND provider='google'").first(),
  db.prepare("SELECT ciphertext,iv FROM google_calendar_authorizations WHERE installation_id='primary'").first(),
  db.prepare("SELECT google_enabled,google_calendar_enabled,auth_mode FROM installations WHERE id='primary'").first()
 ]); return JSON.stringify(values);
}
async function mutate(env: Env, actor: Actor, row: Row | null, value: GoogleConnection | null, challengeHash: string | null = null) {
 const encrypted=value?await pack(env,value):null, db=dbOf(env), now=new Date().toISOString();
 const write=row ? db.prepare(`UPDATE google_connections SET candidate_ciphertext=?,candidate_iv=?,revision=revision+1,updated_at=? WHERE installation_id='primary' AND revision=? AND ${adminSQL} AND ? > ? AND (? IS NULL OR EXISTS(SELECT 1 FROM google_connection_challenges WHERE installation_id='primary' AND state_hash=? AND consumed=1 AND expires_at>?))`).bind(encrypted?.ciphertext??null,encrypted?.iv??null,now,row.revision,actor.userId,actor.expiresAt,Date.now(),challengeHash,challengeHash,Date.now())
 : db.prepare(`INSERT INTO google_connections(installation_id,candidate_ciphertext,candidate_iv,revision,updated_at) SELECT 'primary',?,?,1,? WHERE ${adminSQL} AND NOT EXISTS(SELECT 1 FROM google_connections WHERE installation_id='primary')`).bind(encrypted?.ciphertext??null,encrypted?.iv??null,now,actor.userId);
 const results=await db.batch([write,audit(env,actor.userId,'google.connection.staged',now)]);
 if(results[0].meta?.changes!==1) fail(409,'Google connection changed or Admin access ended; reload');
}
function audit(env: Env, actor: string, action: string, now: string, id=crypto.randomUUID()) { return dbOf(env).prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,'primary',?,?,'integration','google',? WHERE changes()=1").bind(id,actor,action,now); }
async function body(request: Request): Promise<Record<string,unknown>> {
 if(!request.headers.get('content-type')?.startsWith('application/json')) return fail(415,'Content-Type must be application/json');
 const raw=await boundedText(request,4096);if(new TextEncoder().encode(raw).length>4096) return fail(413,'Google connection request is too large');
 try {const value=JSON.parse(raw); if(!value||typeof value!=='object'||Array.isArray(value)) throw Error();return value;}catch{return fail(400,'Invalid Google connection request');}
}
function fields(value: Record<string,unknown>, allowed: string[]) { if(Object.keys(value).some(k=>!allowed.includes(k))) fail(400,'Unknown Google connection field'); }
function revision(value: Record<string,unknown>, row: Row | null) { if(!Number.isSafeInteger(value.revision)||value.revision!==(row?.revision??0)) fail(409,'Google connection changed; reload'); }
const hasScopes=(value: GoogleConnection, scopes: readonly string[]) => Boolean(value.grant?.refreshToken && scopes.every(s=>value.grant!.scopes.includes(s)));
function summary(value: GoogleConnection | undefined) { return value ? { generation:value.generation, loginEnabled:value.loginEnabled, loginVerified:value.loginProof, calendarEnabled:value.calendarEnabled, driveEnabled:documentationAvailable&&value.driveEnabled, organizationAuthorized:Boolean(value.grant), grantedScopes:value.grant?.scopes??[], grantError:value.grantError,calendarReady:value.organizationProof&&value.grantError!=='revoked'&&value.calendarEnabled&&value.calendarProof&&hasScopes(value,googleScopes.calendar), driveReady:documentationAvailable&&value.organizationProof&&value.grantError!=='revoked'&&value.driveEnabled&&hasScopes(value,googleScopes.drive), calendarName:value.calendarLabel, calendarSelected:Boolean(value.calendarId),loginVerifiedAt:value.loginVerifiedAt,authorizedAt:value.authorizedAt,calendarVerifiedAt:value.calendarVerifiedAt } : null; }
export async function googleConnectionStatus(env: Env) {
 const row=await googleConnectionRow(env);return {revision:row?.revision??0,mode:row?.shared_mode?'shared':'legacy',active:summary(row?.active_ciphertext&&row.active_iv?{...await unpack(env,row.active_ciphertext,row.active_iv,'active'),grantError:row.grant_error??undefined}:undefined),candidate:summary(row?.candidate_ciphertext&&row.candidate_iv?await unpack(env,row.candidate_ciphertext,row.candidate_iv):undefined),callbackUri:callbackUri(env),loginCallbackUri:env.ALLOWED_ORIGIN+'/api/auth/google/callback'};
}
function callbackUri(env: Env) {const url=new URL(env.ALLOWED_ORIGIN);if(url.protocol!=='https:'||url.origin!==env.ALLOWED_ORIGIN) return fail(503,'Public dashboard origin is invalid');return url.origin+'/api/admin/connections/google/callback';}
async function providerJson(url: string, init: RequestInit = {}, env?: Env) {
 // workerd does not implement redirect:'error'. Manual mode prevents credential
 // forwarding; reject redirects without fetching their Location or reading bodies.
 try { const result=await providerFetch(env)(url,{...init,redirect:'manual',signal:AbortSignal.timeout(10_000)});if(result.status>=300&&result.status<400)return fail(502,'Google returned an unexpected redirect');if(!result.ok) return fail(result.status===429||result.status>=500?503:401,'Google authorization or access failed; review consent and retry');
  return await readGoogleBody(result);
 }catch(error){if(error instanceof GoogleConnectionError)throw error;return fail(502,'Google is unavailable; retry authorization');}
}
async function exchange(value: GoogleConnection, fields: Record<string,string>, env?: Env) {env?.[schedulerBudgetKey]?.request();return providerJson('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:value.clientId,client_secret:value.clientSecret,...fields})}, env);}
async function access(value: GoogleConnection, env?: Env) {if(!value.grant) return fail(409,'Organizational authorization is required');const token=await exchange(value,{grant_type:'refresh_token',refresh_token:value.grant.refreshToken},env);if(typeof token.access_token!=='string'||!token.access_token||token.access_token.length>16000)return fail(401,'Google did not return access');if(token.scope!==undefined)value.grant.scopes=reportedScopes(token.scope);return token.access_token;}
export async function validateGoogleIdentity(token: unknown, clientId: string, env?: Env) {
 if(typeof token!=='string'||!token||token.length>16000)return fail(401,'Google did not return identity proof');
 const profile=await providerJson('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(token), undefined, env);
 if(profile.aud!==clientId||!['accounts.google.com','https://accounts.google.com'].includes(String(profile.iss))||String(profile.email_verified)!=='true'||typeof profile.sub!=='string'||!profile.sub||profile.sub.length>255||typeof profile.email!=='string'||profile.email.length>320||!Number.isFinite(Number(profile.exp))||Number(profile.exp)*1000<=Date.now())return fail(401,'Google identity proof is invalid');return profile as {sub:string;email:string};
}
export async function googleCapability(env: Env, capability: 'calendar'|'drive') {
 if(capability==='drive'&&!documentationAvailable)return fail(409,'Activity Documentation is unavailable in this release');
 // Metadata, authority signature and token closure must describe one encrypted row.
 const captured=await googleConnectionRow(env);
 const value=captured?.active_ciphertext&&captured.active_iv?await unpack(env,captured.active_ciphertext,captured.active_iv,'active'):undefined;
 if(!value || captured?.grant_error==='revoked' || !value.organizationProof || !(capability==='calendar'?value.calendarEnabled:value.driveEnabled)||!hasScopes(value,googleScopes[capability]))return fail(409,'Google capability needs organizational consent');
 return {signature:captured!.active_iv!,generation:value.generation,calendarId:value.calendarId,calendarLabel:value.calendarLabel,calendarVerified:value.calendarProof,
  // Server-only closure. Feature modules never receive the client secret or refresh token.
  accessToken:async()=>{
   const row=await googleConnectionRow(env);const current=await activeGoogleConnection(env);if(current?.generation!==value.generation)return fail(409,'Google connection changed; retry');
   try {
    const tokens=await exchange(value,{grant_type:'refresh_token',refresh_token:value.grant!.refreshToken},env);
    if(typeof tokens.access_token!=='string'||!tokens.access_token||tokens.access_token.length>16000)return fail(401,'Google did not return access');
    const check=await activeGoogleConnection(env);if(check?.generation!==value.generation||check.grant?.proofId!==value.grant?.proofId)return fail(409,'Google connection changed; retry');if(check.grantError==='revoked')return fail(409,'Renew revoked Google consent before retrying');
    if(tokens.scope!==undefined) {
     const scopes=reportedScopes(tokens.scope);
     if(JSON.stringify([...scopes].sort())!==JSON.stringify([...value.grant!.scopes].sort())) {
      value.grant={...value.grant!,scopes};if(!hasScopes(value,googleScopes.calendar)){value.calendarProof=false;value.calendarVerifiedAt=undefined;}
      const encrypted=await pack(env,value,'active'),db=dbOf(env);
      // Keep the direct-write count adjacent and atomic; D1 metadata includes trigger writes.
      const result=await db.batch([db.prepare("UPDATE google_connections SET active_ciphertext=?,active_iv=?,grant_error=NULL,grant_proof_id=?,revision=revision+1 WHERE installation_id='primary' AND active_ciphertext=? AND grant_error IS NOT 'revoked'").bind(encrypted.ciphertext,encrypted.iv,value.grant!.proofId,row!.active_ciphertext),db.prepare("SELECT changes() AS direct_changes")]);
      if((result[1].results?.[0] as {direct_changes?:number}|undefined)?.direct_changes!==1)return fail(409,'Google connection changed; retry');
     }
    }
    if(!hasScopes(value,googleScopes[capability]))return fail(409,'Google did not grant this capability; renew consent');
    if(row?.grant_error)await dbOf(env).prepare("UPDATE google_connections SET grant_error=NULL WHERE installation_id='primary' AND active_ciphertext=? AND grant_error='temporary'").bind(row.active_ciphertext).run();return tokens.access_token;
   }
   catch(error){if(error instanceof GoogleConnectionError&&[401,502,503].includes(error.status))await dbOf(env).prepare("UPDATE google_connections SET grant_error=CASE WHEN grant_error='revoked' THEN 'revoked' ELSE ? END WHERE installation_id='primary' AND grant_proof_id=?").bind(error.status===401?'revoked':'temporary',value.grant!.proofId).run();throw error;}
  }};
}
export async function googleConnectionRoute(request: Request, env: Env, actor: Actor): Promise<Response> {
 const path=new URL(request.url).pathname.replace('/admin/connections/google','');
 if(path===''&&request.method==='GET')return json(await googleConnectionStatus(env));
 if(path==='/calendars'&&request.method==='GET') {
  const staged=await candidate(env),url=new URL(request.url);if(Number(url.searchParams.get('revision'))!==staged.row.revision)return fail(409,'Google connection changed; reload');
  if(!hasScopes(staged.value,googleScopes.calendar))return fail(409,'Calendar consent is required');
  const pageToken=url.searchParams.get('pageToken');if(pageToken&&pageToken.length>2048)return fail(400,'Calendar page token is too large');
  const query=new URLSearchParams({minAccessRole:'writer',showHidden:'false',maxResults:'100',fields:'items(id,summary,accessRole),nextPageToken',...(pageToken?{pageToken}:{})});
  const token=await access(staged.value, env);if(!hasScopes(staged.value,googleScopes.calendar))return fail(409,'Google Calendar consent is missing');const result=await providerJson('https://www.googleapis.com/calendar/v3/users/me/calendarList?'+query,{headers:{authorization:'Bearer '+token}}, env);
  const items=Array.isArray(result.items)?result.items:[];return json({revision:staged.row.revision,calendars:items.filter(item=>item&&['writer','owner'].includes(String(item.accessRole))).slice(0,100).map(item=>({id:String(item.id).slice(0,1024),name:String(item.summary??'Calendar').slice(0,200)})),nextPageToken:typeof result.nextPageToken==='string'?result.nextPageToken.slice(0,2048):undefined});
 }
 const input=await body(request);const row=await googleConnectionRow(env);revision(input,row);
 if(path===''&&request.method==='DELETE') {
  fields(input,['revision','confirmation']);if(input.confirmation!=='REMOVE GOOGLE CONNECTION')return fail(400,'Type REMOVE GOOGLE CONNECTION to continue');
  if(!row?.active_ciphertext)return fail(409,'There is no active shared Google connection');
  const now=new Date().toISOString(),auditId=crypto.randomUUID(),db=dbOf(env);
  const result=await db.batch([
   db.prepare(`UPDATE google_connections SET active_ciphertext=NULL,active_iv=NULL,candidate_ciphertext=NULL,candidate_iv=NULL,grant_error=NULL,grant_proof_id=NULL,revision=revision+1,updated_at=? WHERE installation_id='primary' AND revision=? AND ${adminSQL} AND ${recoverySQL}`).bind(now,row.revision,actor.userId),
   audit(env,actor.userId,'google.connection.removed',now,auditId),
   db.prepare("UPDATE installations SET google_enabled=0,google_calendar_enabled=0,auth_mode='local' WHERE id='primary' AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)").bind(auditId),
   db.prepare("DELETE FROM google_connection_challenges WHERE installation_id='primary' AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)").bind(auditId),
   db.prepare("DELETE FROM google_calendar_operations WHERE installation_id='primary' AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)").bind(auditId),
   db.prepare("DELETE FROM google_calendar_event_mappings WHERE installation_id='primary' AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)").bind(auditId)
  ]);if(result[1].meta?.changes!==1)return fail(409,'Removal requires current Admin, unchanged settings and local Admin recovery');return json(await googleConnectionStatus(env));
 }
 if(path==='/candidate'&&request.method==='POST') {
  fields(input,['revision','clientId','clientSecret','loginEnabled','calendarEnabled','driveEnabled']);
  if(input.driveEnabled&&!documentationAvailable)return fail(400,'Activity Documentation is unavailable in this release');
  for(const flag of ['loginEnabled','calendarEnabled','driveEnabled'])if(typeof input[flag]!=='boolean')return fail(400,'Explicit Google capability choices are required');
  let active=row?.active_ciphertext&&row.active_iv?await unpack(env,row.active_ciphertext,row.active_iv,'active'):undefined;
  const clientId=input.clientId===undefined?active?.clientId:input.clientId,clientSecret=input.clientSecret===undefined?active?.clientSecret:input.clientSecret;
  if(typeof clientId!=='string'||typeof clientSecret!=='string'||!clientId.trim()||!clientSecret.trim()||clientId.length>500||clientSecret.length>500)return fail(400,'A Google client ID and secret are required');
  const same=active?.clientId===clientId.trim()&&active.clientSecret===clientSecret.trim();
  const value:GoogleConnection={clientId:clientId.trim(),clientSecret:clientSecret.trim(),loginEnabled:input.loginEnabled as boolean,calendarEnabled:input.calendarEnabled as boolean,driveEnabled:input.driveEnabled as boolean,generation:crypto.randomUUID(),loginProof:same?active!.loginProof:false,organizationProof:same&&row?.grant_error!=='revoked'?active!.organizationProof:false,calendarProof:same?active!.calendarProof:false,loginVerifiedAt:same?active!.loginVerifiedAt:undefined,loginProofUserId:same?active!.loginProofUserId:undefined,loginProofEmail:same?active!.loginProofEmail:undefined,authorizedAt:same?active!.authorizedAt:undefined,calendarVerifiedAt:same?active!.calendarVerifiedAt:undefined,legacyFingerprint:await legacyFingerprint(env),baseGrantProofId:active?.grant?.proofId,...(same?{grant:active!.grant,calendarId:active!.calendarId,calendarLabel:active!.calendarLabel}:{})};
  if(active?.calendarId){value.calendarId=active.calendarId;value.calendarPinnedId=active.calendarId;value.calendarLabel=active.calendarLabel;}
  const prior=await dbOf(env).prepare("SELECT ciphertext,iv FROM google_calendar_authorizations WHERE installation_id='primary' AND verified_at IS NOT NULL").first<{ciphertext:string;iv:string}>();
  if(prior&&!value.calendarId){const old=await decryptIntegration(prior.ciphertext,prior.iv,keyOf(env));value.calendarId=old.calendarId;value.calendarPinnedId=old.calendarId;value.calendarLabel=old.calendarLabel;}
  await mutate(env,actor,row,value);return json(await googleConnectionStatus(env));
 }
 if(path==='/candidate'&&request.method==='DELETE'){fields(input,['revision']);await mutate(env,actor,row,null);return json(await googleConnectionStatus(env));}
 const staged=await candidate(env);revision(input,staged.row);
 if(path==='/authorize'&&request.method==='POST') {
  fields(input,['revision','purpose','capabilities']);if(!['login-proof','organization'].includes(String(input.purpose)))return fail(400,'Choose an authorization purpose');
  const caps=input.capabilities??[];if(!documentationAvailable&&Array.isArray(caps)&&caps.includes('drive'))return fail(400,'Activity Documentation is unavailable in this release');if(!Array.isArray(caps)||caps.some(x=>!['calendar','drive'].includes(x))||new Set(caps).size!==caps.length)return fail(400,'Invalid requested Google capabilities');
  if(input.purpose==='login-proof'&&caps.length)return fail(400,'Staff sign-in proof cannot request organizational access');
  if(input.purpose==='organization'&&!caps.length)return fail(400,'Choose Calendar or Drive consent');
  const scopes=['openid','email','profile',...caps.flatMap(x=>[...googleScopes[x as 'calendar'|'drive']])];
  const verifier=crypto.randomUUID()+crypto.randomUUID(),encryptedVerifier=await encryptIntegration({verifier},keyOf(env));
  const codeChallenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const state=crypto.randomUUID()+crypto.randomUUID(),session=cookie(request,'lancerlogin_session')??fail(401,'Sign in required'),now=Date.now();
  const inserted=await dbOf(env).batch([dbOf(env).prepare("DELETE FROM google_connection_challenges WHERE installation_id='primary' AND (expires_at<? OR actor_user_id=?)").bind(now,actor.userId),dbOf(env).prepare(`INSERT INTO google_connection_challenges(installation_id,state_hash,revision,actor_user_id,session_hash,purpose,expires_at,requested_scopes,verifier_ciphertext,verifier_iv) SELECT 'primary',?,?,?,?,?,?,?,?,? WHERE ${adminSQL} AND EXISTS(SELECT 1 FROM google_connections WHERE installation_id='primary' AND revision=?)`).bind(await googleHash(state),staged.row.revision,actor.userId,await googleHash(session),input.purpose,Math.min(now+600000,actor.expiresAt),JSON.stringify(scopes),encryptedVerifier.ciphertext,encryptedVerifier.iv,actor.userId,staged.row.revision)]);
  if(inserted[1].meta?.changes!==1)return fail(409,'Google connection or Admin access changed; reload');
  const target=new URL('https://accounts.google.com/o/oauth2/v2/auth');target.search=new URLSearchParams({client_id:staged.value.clientId,redirect_uri:callbackUri(env),response_type:'code',scope:scopes.join(' '),code_challenge:codeChallenge,code_challenge_method:'S256',state,prompt:input.purpose==='organization'?'consent select_account':'select_account',...(input.purpose==='organization'?{access_type:'offline',include_granted_scopes:'true'}:{})}).toString();
  return Response.json({authorizationUrl:target.href},{headers:{'cache-control':'no-store','set-cookie':`lancerlogin_connection_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`}});
 }
 if(path==='/calendar'&&request.method==='PUT') {
  fields(input,['revision','calendarId']);if(typeof input.calendarId!=='string'||!input.calendarId||input.calendarId.length>1024)return fail(400,'Choose a writable calendar');
  if(!hasScopes(staged.value,googleScopes.calendar))return fail(409,'Calendar consent is required');
  if(staged.value.calendarPinnedId && staged.value.calendarPinnedId!==input.calendarId)return fail(409,'Replacement must preserve the current attendance calendar');
  const token=await access(staged.value, env);if(!hasScopes(staged.value,googleScopes.calendar))return fail(409,'Google Calendar consent is missing');const calendar=await providerJson('https://www.googleapis.com/calendar/v3/users/me/calendarList/'+encodeURIComponent(input.calendarId),{headers:{authorization:'Bearer '+token}}, env);
  if(!['writer','owner'].includes(String(calendar.accessRole)))return fail(400,'Choose a calendar with writer or owner access');
  staged.value.calendarId=input.calendarId;staged.value.calendarLabel=String(calendar.summary??'Selected calendar').slice(0,200);staged.value.calendarProof=true;staged.value.calendarVerifiedAt=new Date().toISOString();
  await mutate(env,actor,staged.row,staged.value);return json(await googleConnectionStatus(env));
 }
 if(path==='/promote'&&request.method==='POST') {
  fields(input,['revision']);const value=staged.value;
  if((value.calendarEnabled||value.driveEnabled)&&!value.organizationProof)return fail(409,'Verify organizational access before promotion');
  if(value.loginEnabled&&!value.loginProof)return fail(409,'Verify replacement staff sign-in first');
  if(value.calendarEnabled&&(!value.calendarProof||!hasScopes(value,googleScopes.calendar)))return fail(409,'Verify organizational consent and the attendance calendar first');
  if(value.driveEnabled&&!hasScopes(value,googleScopes.drive))return fail(409,'Approve Drive file access first');
  const active=await activeGoogleConnection(env);if(value.grant&&value.grant.proofId===active?.grant?.proofId&&JSON.stringify([...value.grant.scopes].sort())!==JSON.stringify([...active.grant.scopes].sort()))return fail(409,'Organizational scopes changed; stage or renew consent again');if(value.baseGrantProofId&&value.baseGrantProofId!==active?.grant?.proofId&&value.grant?.proofId===value.baseGrantProofId)return fail(409,'Organizational access changed; renew candidate consent');if(staged.row.grant_error==='revoked'&&(value.calendarEnabled||value.driveEnabled)&&value.grant?.proofId===active?.grant?.proofId)return fail(409,'Renew revoked organizational consent before promotion');
  const nextGrantError=staged.row.grant_error==='revoked'&&value.grant?.proofId===active?.grant?.proofId?'revoked':null;
  if(nextGrantError)value.organizationProof=false;
  if(value.legacyFingerprint!==await legacyFingerprint(env))return fail(409,'Legacy Google settings changed; stage replacement again');
  const legacy=JSON.parse(value.legacyFingerprint) as [null|{ciphertext:string;iv:string},null|{ciphertext:string;iv:string},{google_enabled:number;google_calendar_enabled:number;auth_mode:string}];
  const encrypted=await pack(env,value,'active'),db=dbOf(env),now=new Date().toISOString();
  const result=await db.batch([
   db.prepare(`UPDATE google_connections SET shared_mode=1,active_ciphertext=?,active_iv=?,grant_error=?,grant_proof_id=?,candidate_ciphertext=NULL,candidate_iv=NULL,revision=revision+1,updated_at=? WHERE installation_id='primary' AND revision=? AND ${adminSQL} AND ${recoverySQL} AND grant_error IS ? AND active_ciphertext IS ? AND (?=0 OR EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND id=? AND email=? AND active=1 AND role='admin'))
    AND COALESCE((SELECT ciphertext FROM encrypted_integrations WHERE installation_id='primary' AND provider='google'),'')=?
    AND COALESCE((SELECT iv FROM encrypted_integrations WHERE installation_id='primary' AND provider='google'),'')=?
    AND COALESCE((SELECT ciphertext FROM google_calendar_authorizations WHERE installation_id='primary'),'')=?
    AND COALESCE((SELECT iv FROM google_calendar_authorizations WHERE installation_id='primary'),'')=?
    AND EXISTS(SELECT 1 FROM installations WHERE id='primary' AND google_enabled=? AND google_calendar_enabled=? AND auth_mode=?)`).bind(encrypted.ciphertext,encrypted.iv,nextGrantError,value.grant?.proofId??null,now,staged.row.revision,actor.userId,staged.row.grant_error,staged.row.active_ciphertext,value.loginEnabled?1:0,value.loginProofUserId??null,value.loginProofEmail??null,legacy[0]?.ciphertext??'',legacy[0]?.iv??'',legacy[1]?.ciphertext??'',legacy[1]?.iv??'',legacy[2].google_enabled,legacy[2].google_calendar_enabled,legacy[2].auth_mode),
   audit(env,actor.userId,'google.connection.promoted',now),
   db.prepare("UPDATE installations SET google_enabled=?,google_calendar_enabled=?,auth_mode=? WHERE id='primary' AND EXISTS(SELECT 1 FROM google_connections WHERE installation_id='primary' AND active_ciphertext=?)").bind(value.loginEnabled?1:0,value.calendarEnabled?1:0,value.loginEnabled?'both':'local',encrypted.ciphertext),
   db.prepare("DELETE FROM encrypted_integrations WHERE installation_id='primary' AND provider='google' AND EXISTS(SELECT 1 FROM google_connections WHERE installation_id='primary' AND active_ciphertext=?)").bind(encrypted.ciphertext),
   db.prepare("DELETE FROM google_calendar_authorizations WHERE installation_id='primary' AND EXISTS(SELECT 1 FROM google_connections WHERE installation_id='primary' AND active_ciphertext=?)").bind(encrypted.ciphertext),
  ]);if(result[1].meta?.changes!==1)return fail(409,'Promotion requires current Admin, unchanged settings and usable local Admin recovery');return json(await googleConnectionStatus(env));
 }
 return fail(404,'Google connection action not found');
}
export async function googleConnectionCallback(request: Request,env: Env) {
 let stage: 'admission'|'code_exchange'|'identity'|'registered_account'|'organization_grant'|'persistence' = 'admission';
 try {
 const url=new URL(request.url),state=url.searchParams.get('state');if(!state||state!==cookie(request,'lancerlogin_connection_state'))return fail(400,'Google authorization state is invalid');
 const db=dbOf(env),hash=await googleHash(state),challenge=await db.prepare("SELECT revision,actor_user_id,session_hash,purpose,expires_at,requested_scopes,verifier_ciphertext,verifier_iv FROM google_connection_challenges WHERE installation_id='primary' AND state_hash=? AND consumed=0 AND expires_at>?").bind(hash,Date.now()).first<{revision:number;actor_user_id:string;session_hash:string;purpose:string;expires_at:number;requested_scopes:string;verifier_ciphertext:string;verifier_iv:string}>();
 if(!challenge)return fail(400,'Google authorization expired or was already used');
 const staged=await candidate(env);if(staged.row.revision!==challenge.revision)return fail(409,'Google connection changed; start authorization again');
 const presentSession=cookie(request,'lancerlogin_session');if(presentSession&&await googleHash(presentSession)!==challenge.session_hash)return fail(403,'Google authorization belongs to another session');
 const claimed=await db.prepare(`UPDATE google_connection_challenges SET consumed=1 WHERE installation_id='primary' AND state_hash=? AND consumed=0 AND expires_at>? AND ${adminSQL} AND EXISTS(SELECT 1 FROM google_connections WHERE installation_id='primary' AND revision=?)`).bind(hash,Date.now(),challenge.actor_user_id,challenge.revision).run();
 if(claimed.meta?.changes!==1)return fail(403,'Google authorization is no longer permitted');
 const code=url.searchParams.get('code');if(url.searchParams.has('error')||!code||code.length>4096)return fail(400,'Google consent was not completed; existing connection is unchanged');
 stage='code_exchange';
 const {verifier}=await decryptIntegration(challenge.verifier_ciphertext,challenge.verifier_iv,keyOf(env));
 const tokens=await exchange(staged.value,{code,code_verifier:verifier,redirect_uri:callbackUri(env),grant_type:'authorization_code'}, env);
 stage='identity';
 const profile=await validateGoogleIdentity(tokens.id_token,staged.value.clientId, env);
 if(challenge.purpose==='login-proof') {
  stage='registered_account';
  const user=await db.prepare("SELECT id FROM users WHERE installation_id='primary' AND email=? AND active=1 AND role='admin'").bind(profile.email.toLowerCase()).first<{id:string}>();
  if(!user)return fail(403,'Verify sign-in with a registered active Google Admin account');staged.value.loginProof=true;staged.value.loginProofUserId=user.id;staged.value.loginProofEmail=profile.email.toLowerCase();staged.value.loginVerifiedAt=new Date().toISOString();
 } else {
  stage='organization_grant';
  if(typeof tokens.access_token!=='string'||!tokens.access_token||tokens.access_token.length>16000||(tokens.refresh_token!==undefined&&(typeof tokens.refresh_token!=='string'||!tokens.refresh_token||tokens.refresh_token.length>16000)))return fail(401,'Google returned invalid organizational tokens');
  if(typeof tokens.scope!=='string'||tokens.scope.length>4096)return fail(401,'Google did not report granted scopes');
  const scopes=reportedScopes(tokens.scope);const prior=staged.value.grant;
  const currentActive=await activeGoogleConnection(env);
  if(!tokens.refresh_token&&currentActive?.grantError==='revoked'&&prior?.proofId===currentActive.grant?.proofId)return fail(401,'Google did not replace the revoked refresh token; authorize again');
  const refresh=typeof tokens.refresh_token==='string'&&tokens.refresh_token?tokens.refresh_token:prior?.subject===profile.sub?prior.refreshToken:undefined;
  if(!refresh)return fail(401,'Google did not return durable access for this organizational account');
  staged.value.grant={proofId:crypto.randomUUID(),refreshToken:refresh,subject:profile.sub,scopes};staged.value.organizationProof=true;staged.value.calendarProof=false;staged.value.calendarVerifiedAt=undefined;staged.value.authorizedAt=new Date().toISOString();
 }
 stage='persistence';
 await mutate(env,{userId:challenge.actor_user_id,expiresAt:challenge.expires_at},staged.row,staged.value,hash);
 return new Response(null,{status:302,headers:{location:env.ALLOWED_ORIGIN+'/settings/integrations?googleConnection=review','cache-control':'no-store','set-cookie':'lancerlogin_connection_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'}});
 } catch(error) {
  // Fixed allowlists only. Never log the error, URL, request, provider response,
  // OAuth parameters, account identity, or any encrypted/plaintext credentials.
  const status=error instanceof GoogleConnectionError?error.status:0;
  const category=status===400||status===415?'invalid_request':status===401?'authorization_rejected':status===403?'access_denied':status===409?'changed':status===413?'size_limit':status===502?'provider_failure':status===503?'unavailable':'internal_error';
  try {console.warn({event:'google_connection_callback_failed',stage,category});} catch { /* Diagnostics must not change the callback outcome. */ }
  throw error;
 }
}
export function validateGoogleConnectionBackup(rows: Record<string,unknown>[]) {
 if(rows.some(row=>row.grant_proof_id!==null&&(typeof row.grant_proof_id!=='string'||row.grant_proof_id.length>100)))return fail(400,'Invalid Google grant identity');
 if(rows.some(row=>![0,1].includes(Number(row.shared_mode))||typeof row.shared_mode!=='number'||(row.active_ciphertext!==null&&row.shared_mode!==1)))return fail(400,'Invalid shared Google mode');
 if(rows.some(row=>row.grant_error!==null&&!['revoked','temporary'].includes(String(row.grant_error))))return fail(400,'Invalid Google grant status');
 if(rows.length>1)return fail(400,'Backup contains multiple Google connections');
 for(const row of rows){if(row.installation_id!=='primary'||!Number.isSafeInteger(row.revision)||Number(row.revision)<0||typeof row.updated_at!=='string')return fail(400,'Invalid Google connection backup');for(const prefix of ['active','candidate']){const c=row[prefix+'_ciphertext'],iv=row[prefix+'_iv'];if(!((c===null&&iv===null)||(typeof c==='string'&&c.length>0&&c.length<65536&&typeof iv==='string'&&/^[A-Za-z0-9_-]{16}$/.test(iv))))return fail(400,'Invalid encrypted Google connection backup');}}
}
export async function sharedGoogleManaged(env: Env) {const row=await googleConnectionRow(env);return Boolean(row?.shared_mode||row?.active_ciphertext||row?.candidate_ciphertext);}
export async function rememberGoogleLogin(env: Env,state: string,client: Record<string,string>) {
 const db=dbOf(env),hash=await googleHash(JSON.stringify(client));
 const results=await db.batch([db.prepare("DELETE FROM google_login_challenges WHERE installation_id='primary' AND expires_at<?").bind(Date.now()),db.prepare("INSERT INTO google_login_challenges(installation_id,state_hash,client_hash,expires_at) SELECT 'primary',?,?,? WHERE (SELECT COUNT(*) FROM google_login_challenges WHERE installation_id='primary')<256").bind(await googleHash(state),hash,Date.now()+600000)]);
 if(results[1].meta?.changes!==1)return fail(429,'Google sign-in is busy; try again shortly');
}
export async function consumeGoogleLogin(env: Env,state:string,client:Record<string,string>) {
 const result=await dbOf(env).prepare("DELETE FROM google_login_challenges WHERE installation_id='primary' AND state_hash=? AND client_hash=? AND expires_at>?").bind(await googleHash(state),await googleHash(JSON.stringify(client)),Date.now()).run();
 if(result.meta?.changes!==1)return fail(400,'Google sign-in expired, changed, or was already used');
}


export async function invalidateGoogleSession(env: Env, request: Request) {
 const session=cookie(request,'lancerlogin_session');if(!session||!env.DB)return;
 await env.DB.prepare("DELETE FROM google_connection_challenges WHERE installation_id='primary' AND session_hash=?").bind(await googleHash(session)).run();
}
export async function prepareGoogleConnectionRestore(env: Env, rows: Record<string,unknown>[], installations: Record<string,unknown>[], users: Record<string,unknown>[]) {
 validateGoogleConnectionBackup(rows);
 for(const row of rows)for(const slot of ['active','candidate']) {
  if(row[slot+'_ciphertext']===null)continue;
  let value:GoogleConnection;
  try { value=await unpack(env,String(row[slot+'_ciphertext']),String(row[slot+'_iv']),slot); validatePayload(value); }
  catch{return fail(400,'Google connection backup cannot be decrypted or validated with this installation key');}
  if(slot==='active') {
   if(row.grant_proof_id!==(value.grant?.proofId??null))return fail(400,'Google grant identity is inconsistent in backup');
   const installation=installations.find(x=>x.id==='primary');
   if(!installation||installation.google_enabled!==(value.loginEnabled?1:0)||installation.google_calendar_enabled!==(value.calendarEnabled?1:0)||installation.auth_mode!==(value.loginEnabled?'both':'local'))return fail(400,'Google connection backup conflicts with installation settings');
   if(!users.some(x=>x.installation_id==='primary'&&x.role==='admin'&&x.active===1&&typeof x.password_hash==='string'&&x.password_hash.startsWith('scrypt$32768$8$1$')&&typeof x.local_username==='string'&&x.local_username.length>0))return fail(400,'Google connection restore requires usable local Admin recovery');
   if((value.loginEnabled&&!value.loginProof)||((value.calendarEnabled||value.driveEnabled)&&!value.organizationProof))return fail(400,'Active Google backup lacks required verified proofs');
  }
  if(slot==='candidate') {
   // Restored staging is an unverified proposal. No OAuth challenge survives restoration.
   value.loginProof=false;value.organizationProof=false;value.calendarProof=false;value.loginVerifiedAt=undefined;value.loginProofUserId=undefined;value.loginProofEmail=undefined;value.calendarVerifiedAt=undefined;value.grant=undefined;value.authorizedAt=undefined;value.generation=crypto.randomUUID();
   const encrypted=await pack(env,value);row.candidate_ciphertext=encrypted.ciphertext;row.candidate_iv=encrypted.iv;
  }
 }
}
function validatePayload(value: GoogleConnection) {
 const text=(input:unknown,max:number)=>typeof input==='string'&&input.length>0&&input.length<=max;
 if(!value||typeof value!=='object'||!text(value.clientId,500)||!text(value.clientSecret,500)||!text(value.generation,100)||!text(value.legacyFingerprint,16000))throw Error();
 for(const flag of ['loginEnabled','calendarEnabled','driveEnabled','loginProof','organizationProof','calendarProof'] as const)if(typeof value[flag]!=='boolean')throw Error();
 for(const field of ['loginVerifiedAt','calendarVerifiedAt','authorizedAt'] as const)if(value[field]!==undefined&&!Number.isFinite(Date.parse(value[field]!)))throw Error();
 if(value.calendarPinnedId!==undefined&&!text(value.calendarPinnedId,1024))throw Error();if(value.calendarId!==undefined&&!text(value.calendarId,1024))throw Error();if(value.calendarLabel!==undefined&&!text(value.calendarLabel,200))throw Error();
 if(value.grant && (!text(value.grant.proofId,100)||!text(value.grant.refreshToken,16000)||!text(value.grant.subject,255)||!Array.isArray(value.grant.scopes)||value.grant.scopes.length>64||value.grant.scopes.some(s=>!text(s,1000))||new Set(value.grant.scopes).size!==value.grant.scopes.length))throw Error();
 if(value.loginProof&&(!value.loginVerifiedAt||!text(value.loginProofUserId,100)||!text(value.loginProofEmail,320)))throw Error();if(value.calendarProof&&(!value.calendarId||!value.calendarVerifiedAt||!hasScopes(value,googleScopes.calendar)))throw Error();
 const legacy=JSON.parse(value.legacyFingerprint);if(!Array.isArray(legacy)||legacy.length!==3||!legacy[2])throw Error();
}

async function boundedText(source: Request | Response, maximum: number): Promise<string> {
 const reader=source.body?.getReader();if(!reader)return '';const chunks:Uint8Array[]=[];let size=0;
 while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maximum){await reader.cancel();return fail(413,'Google request or response exceeded its limit');}chunks.push(part.value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return new TextDecoder().decode(bytes);
}
export async function readGoogleBody(source: Response, maximum=65536): Promise<Record<string,unknown>> {
 if([204,205].includes(source.status))return {};
 try { const value=JSON.parse(await boundedText(source,maximum));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value; }
 catch{return fail(502,'Google response was invalid or exceeded its limit');}
}

function reportedScopes(value: unknown): string[] {
 if(typeof value!=='string'||value.length>4096)return fail(401,'Google did not report valid granted scopes');
 const scopes=[...new Set(value.split(/\s+/).filter(Boolean))];if(scopes.length>64||scopes.some(s=>s.length>1000))return fail(401,'Google reported too many scopes');return scopes;
}
