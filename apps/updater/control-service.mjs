import { sha256 } from '../../packages/shared/src/updater/application-release.mjs';
import { boundedUpdaterBytes, updaterAction } from '../../packages/shared/src/updater/service-auth.ts';
import { controlPage } from './control-ui.mjs';
const cookie='__Host-lancerlogin_control', random=()=>[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');
const check=(ok)=>{if(!ok)throw Error('control-rejected');}, hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const encoder=new TextEncoder();
export function createControlService({engine,store,database,capability,installationId,origin,dashboardOrigin,now=()=>Date.now()}){
  for(const value of [origin,dashboardOrigin]){const url=new URL(value);check(url.protocol==='https:'&&url.origin===value&&!url.username&&!url.password);}check(origin!==dashboardOrigin);
  const digest=(kind,value)=>sha256(encoder.encode(`LancerLogin control ${kind} v1\n${installationId}\n${value}`));
  const time=()=>Math.floor(now()/1000),headers={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY'};
  const reply=(value,status=200,extra={})=>Response.json(value,{status,headers:{...headers,...extra}}), expired=`${cookie}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  async function grant(actorId,body,identity){
    const secret=random(),hash=await digest('grant',secret),serialized=JSON.stringify(identity);
    check(identity.releaseId===body.releaseId&&serialized.length<=16384);
    const row=await database.prepare(`INSERT INTO updater_control_requests(installation_id,request_id,actor_id,release_id,release_identity,dashboard_origin,grant_hash,grant_expires)
      SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM updater_admissions WHERE installation_id=? AND request_id=?)
      ON CONFLICT(installation_id,request_id) DO UPDATE SET grant_hash=excluded.grant_hash,grant_expires=excluded.grant_expires,session_hash=NULL,csrf=NULL,session_expires=NULL
      WHERE updater_control_requests.actor_id=excluded.actor_id AND updater_control_requests.release_id=excluded.release_id AND updater_control_requests.release_identity=excluded.release_identity AND updater_control_requests.dashboard_origin=excluded.dashboard_origin
      AND NOT EXISTS(SELECT 1 FROM updater_admissions WHERE installation_id=? AND request_id=?) RETURNING request_id`).bind(installationId,body.requestId,actorId,body.releaseId,serialized,dashboardOrigin,hash,time()+60,installationId,body.requestId,installationId,body.requestId).first();
    check(row);return{grant:secret,requestId:body.requestId,controlUrl:`${origin}/control`};
  }
  async function auth(request){try{const values=(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookie+'='));check(values.length===1);const token=values[0].slice(cookie.length+1);check(hex(token));const row=await database.prepare('SELECT * FROM updater_control_requests WHERE installation_id=? AND session_hash=? ').bind(installationId,await digest('session',token)).first();check(row);check(row.session_expires>time());return row;}catch{throw Object.assign(Error('control-ended'),{status:401});}}
  async function revoke(row){await database.prepare('UPDATE updater_control_requests SET session_hash=NULL,csrf=NULL WHERE installation_id=? AND request_id=? AND session_hash=?').bind(installationId,row.request_id,row.session_hash).run();}
  async function status(row,completed=null,authorizeJob=null){
    const admission=await database.prepare('SELECT actor_id,release_id,state,reason FROM updater_admissions WHERE installation_id=? AND request_id=?').bind(installationId,row.request_id).first();
    const base={configured:true,installedVersion:'',job:null,recoveryAvailable:false,recoveryUrl:`${origin}/recovery`,availability:{status:'not-checked',checked:0,total:0,checkedAt:0},expiresAt:row.session_expires,csrfToken:row.csrf,requestId:row.request_id};
    if(!admission){check(!authorizeJob);return{...base,admission:{requestId:row.request_id,state:'pending',reason:null}};}
    check(admission.actor_id===row.actor_id&&admission.release_id===row.release_id);
    if(admission.state==='rejected'){check(!authorizeJob);return{...base,admission:{requestId:row.request_id,state:'rejected',reason:admission.reason},ended:true};}
    const current=(await store.read()).state;
    if(current.job?.requestId!==row.request_id){if(admission.state!=='pending'||completed||authorizeJob){throw Object.assign(Error('control-ended'),{status:401});}return{...base,admission:{requestId:row.request_id,state:'pending',reason:null}};}
    if(current.job.mode!=='update'||current.job.release.releaseId!==row.release_id){throw Object.assign(Error('control-ended'),{status:401});} if(authorizeJob){check(current.job.id===authorizeJob);if(['succeeded','recovered'].includes(current.job.status)){const value=await engine.status(capability);if(value.maintenance?.state==='open'){await revoke(row);throw Object.assign(Error('control-ended'),{status:401});}}return;}
    const value=completed??await engine.status(capability);check(value.job?.id===current.job.id);
    if(value.maintenance?.state==='open'&&['succeeded','recovered'].includes(value.job.status)){if(completed)await revoke(row);return{...base,...value,recoveryAvailable:false,ended:true,job:{...value.job,requestId:row.request_id},admission:{requestId:row.request_id,state:'accepted',reason:null}};}
    return{...base,...value,recoveryAvailable:false,job:{...value.job,requestId:row.request_id},admission:{requestId:row.request_id,state:'accepted',reason:null}};
  }
  async function fetch(request){
    try{
      const url=new URL(request.url);check(url.origin===origin&&!url.search&&(!request.headers.has('origin')||request.headers.get('origin')===origin));
      if(url.pathname==='/control'&&request.method==='GET'){const nonce=random();return new Response(controlPage(nonce,dashboardOrigin),{headers:{...headers,'content-type':'text/html; charset=utf-8','content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`}});}
      check(request.headers.get('sec-fetch-site')!=='cross-site');
      const action=url.pathname.slice('/control/'.length);check(url.pathname.startsWith('/control/')&&['exchange','status','advance','retry-preparation','logout'].includes(action)&&request.method===(action==='status'?'GET':'POST'));
      let body={};if(request.method==='POST'){check(request.headers.get('origin')===origin&&request.headers.get('content-type')?.split(';')[0]==='application/json');body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedUpdaterBytes(request)));}
      if(action==='exchange'){
        check(Object.keys(body).length===1&&hex(body.grant));const token=random(),csrf=random(),expires=time()+900;
        const row=await database.prepare(`UPDATE updater_control_requests SET grant_hash=NULL,session_hash=?,csrf=?,session_expires=?,attempts=0 WHERE installation_id=? AND grant_hash=? AND grant_expires>? AND NOT EXISTS(SELECT 1 FROM updater_admissions a WHERE a.installation_id=updater_control_requests.installation_id AND a.request_id=updater_control_requests.request_id) RETURNING request_id`).bind(await digest('session',token),csrf,expires,installationId,await digest('grant',body.grant),time()).first();check(row);
        return reply({authenticated:true},200,{'set-cookie':`${cookie}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900`});
      }
      const row=await auth(request);if(action==='status'){const value=await status(row);return reply(value,200,value.ended?{'set-cookie':expired}:{});}
      check(request.headers.get('x-control-csrf')===row.csrf);const nonce=request.headers.get('x-control-nonce');check(typeof nonce==='string'&&/^[a-f0-9-]{36}$/.test(nonce));
      if(action==='logout')check(Object.keys(body).length===0);else body=updaterAction(action,body);
      check(await database.prepare('UPDATE updater_control_requests SET attempts=attempts+1 WHERE installation_id=? AND request_id=? AND session_hash=? AND attempts<4096 RETURNING attempts').bind(installationId,row.request_id,row.session_hash).first());
      check(await database.prepare('INSERT INTO updater_control_nonces(session_hash,nonce,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING nonce').bind(row.session_hash,nonce,row.session_expires).first());
      if(action==='logout'){await database.prepare('UPDATE updater_control_requests SET session_hash=NULL,csrf=NULL WHERE installation_id=? AND request_id=? AND session_hash=?').bind(installationId,row.request_id,row.session_hash).run();return reply({authenticated:false},200,{'set-cookie':expired});}
      await status(row,null,body.jobId);
      const completed=action==='advance'?await engine.advance(capability,body.jobId):await engine.retryPreparation(capability,body);
      const value=await status(row,completed);return reply(value,200,value.ended?{'set-cookie':expired}:{});
    }catch(error){return reply({error:'Control unavailable. Refresh the controller or use independent recovery.'},error.status===401?401:409,error.status===401?{'set-cookie':expired}:{});}
  }
  return Object.freeze({grant,fetch});
}
