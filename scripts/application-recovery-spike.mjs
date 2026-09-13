import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, stat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { boundedBytes, REPOSITORY, DATABASE } from './development-recovery-spike.mjs';
import { buildModel, modelSQL, validateExport, cleanupSQL, operationalProbes, sha, canonical, quote, schemaSQL, normalizeSchema, sortRows, fixtureNames, damageSQL, LIMIT } from './application-recovery-model.mjs';

export const WRANGLER='4.127.1';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const modes=['prepare','initialize','export','damage','restore','verify','status'];
const failure=()=>{throw Error('Application recovery stage stopped; retain private checkpoints for review');};
export function parseArgs(args){const mode=args[0];if(!modes.includes(mode))failure();const result={mode};const names={'--repository':'repository','--expected-account':'account','--expected-database':'database','--approve-manifest':'approval'};for(let i=1;i<args.length;i+=2){const key=names[args[i]];if(!key||result[key]||!args[i+1]||args[i+1].startsWith('--'))failure();result[key]=args[i+1];}if(result.repository!==REPOSITORY||!/^[a-f0-9]{32}$/.test(result.account??'')||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(result.database??''))failure();return result;}
export function validateDestination(options,saved,live,env){if(options.repository!==REPOSITORY||env.CLOUDFLARE_ACCOUNT_ID!==options.account||!env.CLOUDFLARE_API_TOKEN||saved?.databaseId!==options.database||saved.accountId!==options.account||saved.name!==DATABASE||live?.uuid!==options.database||live.name!==DATABASE||[live.account_id,live.account?.id].some(v=>v!==undefined&&v!==options.account))failure();}
const transportCodes=new Set(['provider_transport','provider_http','provider_envelope','provider_inner_failure','provider_shape','storage_url','storage_upload','storage_etag','poll_limit','checkpoint_required']);
const causeCodes=new Map(Object.entries({
 dns:['ENOTFOUND','EAI_AGAIN'],
 tls:['ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_SSL_WRONG_VERSION_NUMBER'],
 socket:['ECONNRESET','ECONNREFUSED','EPIPE','ENETUNREACH','EHOSTUNREACH','UND_ERR_SOCKET'],
 timeout:['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'],
 aborted:['ABORT_ERR','UND_ERR_ABORTED'],
 request_construction:['ERR_INVALID_URL','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','UND_ERR_INVALID_ARG','UND_ERR_REQ_CONTENT_LENGTH_MISMATCH'],
}).flatMap(([category,codes])=>codes.map(code=>[code,category])));
const causeCategories=new Set([...causeCodes.values(),'unknown']);
// Exact literals from Node 24.14.1's bundled Undici 7.24.4. Never retain text.
const constructionReasons=new Map([
 ['duplicate content-length header','duplicate_content_length'],
 ['invalid content-length header','invalid_content_length'],
 ['invalid request path','invalid_path'],
 ['path must be a string','invalid_path'],
 ['path must be an absolute URL or start with a slash','invalid_path'],
 ['body must be a string, a Buffer, a Readable stream, an iterable, or an async iterable','unsupported_body'],
 ['Proxy URL is mandatory','proxy_configuration'],
 ['Proxy URL must use socks5:// or socks:// protocol','proxy_configuration'],
 ['Cannot establish tunnel connection without a proxy client','proxy_tunnel'],
]);
const constructionReasonValues=new Set([...constructionReasons.values(),'unknown']);
function constructionReason(error){try{return constructionReasons.get(error.message)??'unknown';}catch{return 'unknown';}}
function storageCause(error){
 // Only UND_ERR_INVALID_ARG permits exact literal comparison; no text escapes.
 const queue=[error],seen=new Set();
 for(let n=0;n<8&&queue.length;n++){
  const current=queue.shift();if(!current||typeof current!=='object'||seen.has(current))continue;seen.add(current);
  try{const category=causeCodes.get(current.code);if(category)return {category,...(category==='request_construction'?{constructionCode:current.code}:{}),...(current.code==='UND_ERR_INVALID_ARG'?{constructionReason:constructionReason(current)}:{})};if(current.name==='TimeoutError')return {category:'timeout'};if(current.name==='AbortError')return {category:'aborted'};if(current.cause)queue.push(current.cause);if(Array.isArray(current.errors))queue.push(...current.errors.slice(0,4));}catch{return {category:'unknown'};}
 }
 return {category:'unknown'};
}
const rejectionStages=new Set(['init-dispatched','ingest-dispatched','poll-dispatched']);
const successStates=new Set(['true','false','missing','invalid']);
const statusStates=new Set(['complete','active','error','missing','unknown']);
function rejectionShape(result,rejectedAt){
 let success,status;try{success=result?.success;status=result?.status;}catch{return {rejectedAt,successState:'invalid',statusState:'unknown'};}
 return {rejectedAt,successState:success===true?'true':success===false?'false':success===undefined?'missing':'invalid',statusState:status===undefined?'missing':['complete','active','error'].includes(status)?status:'unknown'};
}
function validRejection(value){return rejectionStages.has(value?.rejectedAt)&&successStates.has(value?.successState)&&statusStates.has(value?.statusState);}
export class RecoveryTransportError extends Error {
 constructor(code,status,causeCategory,constructionCode,constructionReason,rejection){super('Application recovery transport stopped; retain private checkpoints for review');this.diagnostic={code:transportCodes.has(code)?code:'provider_shape',...(Number.isInteger(status)&&status>=100&&status<=599?{httpStatus:status}:{}),...(causeCategories.has(causeCategory)?{transportCause:causeCategory}:{}),...(causeCategory==='request_construction'&&causeCodes.get(constructionCode)==='request_construction'?{constructionCode}:{}),...(causeCategory==='request_construction'&&constructionCode==='UND_ERR_INVALID_ARG'&&constructionReasonValues.has(constructionReason)?{constructionReason}:{}),...(code==='provider_inner_failure'&&validRejection(rejection)?{rejectedAt:rejection.rejectedAt,successState:rejection.successState,statusState:rejection.statusState}:{})};}
}
const transportFail=(code,status,causeCategory,constructionCode,constructionReason)=>{throw new RecoveryTransportError(code,status,causeCategory,constructionCode,constructionReason);};
const validBookmark=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,256}$/.test(value);
const importSubstages=new Set(['init-dispatched','upload-ready','upload-dispatched','upload-complete','ingest-dispatched','poll-ready','poll-dispatched','complete','terminal-failure']);
function validTransport(value,operation,digest){return /^[a-f0-9]{64}$/.test(digest??'')&&value&&value.version===1&&value.operation===operation&&value.payloadSha256===digest&&importSubstages.has(value.substage)&&(value.bookmark===null||validBookmark(value.bookmark))&&Object.keys(value).every(k=>['version','operation','payloadSha256','substage','bookmark','diagnostic'].includes(k))&&(!value.diagnostic||(transportCodes.has(value.diagnostic.code)&&Object.keys(value.diagnostic).every(k=>['code','httpStatus','transportCause','constructionCode','constructionReason','rejectedAt','successState','statusState'].includes(k))&&(!['rejectedAt','successState','statusState'].some(k=>Object.hasOwn(value.diagnostic,k))||value.diagnostic.code==='provider_inner_failure'&&validRejection(value.diagnostic))&&(value.diagnostic.constructionCode===undefined||value.diagnostic.transportCause==='request_construction'&&causeCodes.get(value.diagnostic.constructionCode)==='request_construction')&&(value.diagnostic.constructionReason===undefined||value.diagnostic.transportCause==='request_construction'&&value.diagnostic.constructionCode==='UND_ERR_INVALID_ARG'&&constructionReasonValues.has(value.diagnostic.constructionReason))&&(value.diagnostic.transportCause===undefined||causeCategories.has(value.diagnostic.transportCause))&&(value.diagnostic.httpStatus===undefined||Number.isInteger(value.diagnostic.httpStatus)&&value.diagnostic.httpStatus>=100&&value.diagnostic.httpStatus<=599)));}
export function provider(options,env,fetchImpl=fetch,sleep=pause){
 async function call(path,method='GET',body,expectedError,timeout=30000){
  let response,document;try{response=await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${options.account}/d1/database/${options.database}${path}`,{method,redirect:'error',signal:AbortSignal.timeout(timeout),headers:{authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const bytes=await boundedBytes(new Response(response.body,{status:200}),LIMIT);document=JSON.parse(bytes.toString());}catch{transportFail('provider_transport');}
  if(expectedError){const errors=canonical(document.errors??[]);if(!response.ok&&document.success===false&&errors.includes(expectedError))return true;transportFail('provider_shape',response.status);}
  if(!response.ok)transportFail('provider_http',response.status);if(document?.success!==true)transportFail('provider_envelope',response.status);return document.result;
 }
 const url=value=>{let u;try{u=new URL(value);}catch{transportFail('storage_url');}if(u.protocol!=='https:'||!/^([a-z0-9-]+\.)?r2\.cloudflarestorage\.com$/.test(u.hostname)||u.username||u.password||u.port)transportFail('storage_url');return u;};
 async function exportPoll(body){const started=performance.now();for(let n=0;n<30;n++){const remaining=Math.floor(120000-(performance.now()-started));if(remaining<=0)transportFail('poll_limit');const result=await call('/export','POST',body,undefined,Math.min(30000,remaining));if(result?.status==='complete')return result;if(result?.status==='error'||result?.error)transportFail('provider_inner_failure');const bookmark=result?.at_bookmark??result?.current_bookmark;if(!validBookmark(bookmark))transportFail('provider_shape');body={...body,current_bookmark:bookmark};await sleep(1000);}transportFail('poll_limit');}
 async function importRun(save,initial,work){
  if(typeof save!=='function')transportFail('checkpoint_required');let last=initial;
  const persist=async(substage,bookmark=last?.bookmark??null)=>{const next={substage,bookmark};await save(next);last=next;};
  const reject=async(result)=>{const diagnostic=rejectionShape(result,last?.substage);const error=new RecoveryTransportError('provider_inner_failure',undefined,undefined,undefined,undefined,diagnostic);const next={substage:'terminal-failure',bookmark:last?.bookmark??null,diagnostic:error.diagnostic};await save(next);last=next;throw error;};
  const accept=async(result)=>{
   if(result?.success!==true||result.status==='error'||result.error){await reject(result);}
   if(result.status==='complete'){await persist('complete');return true;}
   if(result.status!==undefined&&result.status!=='active'||!validBookmark(result.at_bookmark))transportFail('provider_shape');
   await persist('poll-ready',result.at_bookmark);return false;
  };
  const poll=async()=>{const started=performance.now();for(let n=0;n<30;n++){
   const remaining=Math.floor(120000-(performance.now()-started));if(remaining<=0)transportFail('poll_limit');
   if(!validBookmark(last?.bookmark))transportFail('provider_shape');const bookmark=last.bookmark;
   await persist('poll-dispatched',bookmark);
   const result=await call('/import','POST',{action:'poll',current_bookmark:bookmark},undefined,Math.min(30000,remaining));
   if(await accept(result))return;await sleep(1000);
  }transportFail('poll_limit');};
  try{return await work({persist,accept,poll,reject});}catch(error){if(error instanceof RecoveryTransportError&&last)await save({...last,diagnostic:error.diagnostic});throw error;}
 }
 return {identity:()=>call(''),async query(sql){const result=await call('/query','POST',{sql});if(!Array.isArray(result)||result.length!==1||result[0].success!==true||!Array.isArray(result[0].results))transportFail('provider_shape');return result[0].results;},probe:probe=>call('/query','POST',{sql:probe.sql},probe.error),
  async export(tables){const result=await exportPoll({output_format:'polling',dump_options:{tables}});const response=await fetchImpl(url(result.result?.signed_url),{redirect:'error',signal:AbortSignal.timeout(30000)});return boundedBytes(response,LIMIT);},
  async resumeImport(record,save){
   if(!record||!['poll-ready','poll-dispatched'].includes(record.substage)||!validBookmark(record.bookmark))transportFail('checkpoint_required');
   return importRun(save,{substage:record.substage,bookmark:record.bookmark},async({poll})=>poll());
  },
  async import(bytes,save){
   if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>LIMIT)transportFail('provider_shape');
   return importRun(save,null,async({persist,accept,poll,reject})=>{
    const etag=createHash('md5').update(bytes).digest('hex');await persist('init-dispatched');
    const result=await call('/import','POST',{action:'init',etag});
    if(!result||typeof result!=='object')transportFail('provider_shape');
    if(!Object.hasOwn(result,'upload_url')){if(!await accept(result))await poll();return;}
    if(result.success===false){await reject(result);}
    const upload=url(result.upload_url);if(typeof result.filename!=='string'||!result.filename||result.filename.length>1024)transportFail('provider_shape');
    await persist('upload-ready');await persist('upload-dispatched');
    // Native fetch derives exact Content-Length from this bounded Buffer.
    let response;try{response=await fetchImpl(upload,{method:'PUT',body:bytes,redirect:'error',signal:AbortSignal.timeout(30000)});}catch(error){const cause=storageCause(error);transportFail('storage_upload',undefined,cause.category,cause.constructionCode,cause.constructionReason);}
    void response.body?.cancel().catch(()=>undefined);
    if(response.status!==200)transportFail('storage_upload',response.status);
    if(response.headers.get('etag')?.replace(/^"|"$/g,'')!==etag)transportFail('storage_etag');
    await persist('upload-complete');await persist('ingest-dispatched');
    if(!await accept(await call('/import','POST',{action:'ingest',filename:result.filename,etag})))await poll();
   });
  }
 };
}
function comparableSchema(rows){return normalizeSchema(rows).filter(r=>!fixtureNames.includes(r.name)).sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0);}
export async function snapshot(api,model,allowEmpty=false){
 const schema=await api.query(schemaSQL);if(schema.some(r=>!model.snapshot.schema.some(e=>e.name===r.name)&&!fixtureNames.includes(r.name)))failure();
 const fixture=await api.query('SELECT id,value FROM recovery_fixture ORDER BY id');const job=await api.query('SELECT id,checkpoint,status,owner,lease_until FROM recovery_job ORDER BY id');
 if(canonical(fixture)!==canonical([{id:'synthetic-1',value:'baseline'},{id:'synthetic-2',value:'resumed'}])||canonical(job)!==canonical([{id:1,checkpoint:2,status:'migration-failed-recoverable',owner:null,lease_until:0}]))failure();
 const fixtureSchema=schema.filter(r=>fixtureNames.includes(r.name));if(fixtureSchema.length!==2||fixtureSchema.some(r=>r.type!=='table'))failure();
 const appSchema=comparableSchema(schema);if(allowEmpty&&appSchema.length===0)return {empty:true,fixture:sha(canonical({schema:fixtureSchema,fixture,job}))};
 if(canonical(appSchema)!==canonical(model.snapshot.schema))failure();
 const rows={};for(const name of model.tables){const records=await api.query('SELECT * FROM '+quote(name));if(records.length>100)failure();rows[name]=sortRows(records);}
 return {digest:sha(canonical({schema:appSchema,rows})),fixture:sha(canonical({schema:fixtureSchema,fixture,job}))};
}
export function damagedDigest(model){const copy=structuredClone(model.snapshot);copy.rows.organization_settings[0].organization_name='Synthetic restore damage';return sha(canonical(copy));}
export async function runStage(options,{api,store,transport,identity,env,model}){
 validateDestination(options,identity,{name:DATABASE,uuid:options.database},env);validateDestination(options,identity,await api.identity(),env);
 let manifest=await store.read('manifest.json');let state=await store.read('state.json');
 if(options.mode==='prepare'){
  if(manifest||state)failure();const before=await snapshot(api,model,true);if(!before.empty)failure();const bytes=modelSQL(model.snapshot,model.tableOrder);validateExport(bytes,model);
  manifest={version:1,repository:REPOSITORY,account:options.account,database:options.database,name:DATABASE,wrangler:WRANGLER,migrations:model.migrations,modelDigest:model.digest,fixtureDigest:before.fixture,initializeDigest:sha(bytes),tables:model.tables};
  await store.bytes('initialize.sql',bytes);await store.save('manifest.json',manifest,true);await store.save('state.json',{phase:'prepared',manifestDigest:sha(canonical(manifest))},true);return {phase:'prepared',manifestDigest:sha(canonical(manifest)),tables:model.tables.length,triggers:model.snapshot.schema.filter(r=>r.type==='trigger').length};
 }
 if(!manifest||!state||manifest.repository!==REPOSITORY||manifest.account!==options.account||manifest.database!==options.database||manifest.name!==DATABASE||manifest.wrangler!==WRANGLER||manifest.modelDigest!==model.digest||canonical(manifest.migrations)!==canonical(model.migrations)||canonical(manifest.tables)!==canonical(model.tables)||state.manifestDigest!==sha(canonical(manifest)))failure();
 const inspect=()=>snapshot(api,model,options.mode==='initialize'||state.phase==='initialize-pending');const matches=(value,digest)=>value.digest===digest&&value.fixture===manifest.fixtureDigest;
 if(options.mode==='status'){const value=await inspect();return {phase:state.phase,baseline:matches(value,model.digest),damaged:matches(value,damagedDigest(model)),fixturePreserved:value.fixture===manifest.fixtureDigest,manifestDigest:state.manifestDigest,transport:state.transport?{substage:importSubstages.has(state.transport.substage)?state.transport.substage:'unknown',hasBookmark:validBookmark(state.transport.bookmark)}:null};}
 if(options.approval!==state.manifestDigest)failure();
 const persist=async(phase,extra={})=>{state={...state,...extra,phase};await store.save('state.json',state);};
 const recordImport=(operation,digest)=>async update=>{
  const value={version:1,operation,payloadSha256:digest,...update};
  if(!validTransport(value,operation,digest))failure();await persist(state.phase,{transport:value});
 };
 // Repeating a pending mutation only reconciles known exact states. No implicit
 // re-initialize/import/probe follows a timeout, crash, or failed transport.
 if(state.phase==='export-pending'){const bytes=await store.load('export.sql');const proof=validateExport(bytes,model);if(!matches(await inspect(),model.digest))failure();await persist('exported',{exportDigest:proof.sha256,exportBytes:proof.bytes,reconstructedObjects:proof.reconstructedObjects,reconciled:true});return {phase:'exported',reconciled:true};}
 if(state.phase.endsWith('-pending')){
  const expected=state.phase==='damage-pending'?damagedDigest(model):model.digest;
  if(!['initialize-pending','damage-pending','restore-pending'].includes(state.phase))failure();
  if(state.phase!=='damage-pending'){
   const operation=state.phase==='initialize-pending'?'initialize':'restore',digest=operation==='initialize'?manifest.initializeDigest:state.restoreDigest;
   if(!validTransport(state.transport,operation,digest))failure();
   if(['poll-ready','poll-dispatched'].includes(state.transport.substage)){if(!validBookmark(state.transport.bookmark))failure();await api.resumeImport(state.transport,recordImport(operation,digest));if(state.transport?.substage!=='complete')failure();}
   else if(state.transport.substage!=='complete')failure();
  }
  if(!matches(await inspect(),expected))failure();
  const phase={'initialize-pending':'initialized','damage-pending':'damaged','restore-pending':'restored'}[state.phase];await persist(phase,{reconciled:true});return {phase,reconciled:true};
 }
 if(options.mode==='initialize'){
  if(state.phase!=='prepared')failure();const before=await inspect();if(!before.empty||before.fixture!==manifest.fixtureDigest)failure();const bytes=await store.load('initialize.sql');if(sha(bytes)!==manifest.initializeDigest)failure();validateExport(bytes,model);await persist('initialize-pending');await transport('initialize',model,bytes,recordImport('initialize',manifest.initializeDigest));if(state.transport?.substage!=='complete')failure();if(!matches(await inspect(),model.digest))failure();await persist('initialized');
 }else if(options.mode==='export'){
  if(state.phase!=='initialized'||!matches(await inspect(),model.digest))failure();await persist('export-pending');await transport('export',model);const bytes=await store.load('export.sql');const proof=validateExport(bytes,model);if(!matches(await inspect(),model.digest))failure();await persist('exported',{exportDigest:proof.sha256,exportBytes:proof.bytes,reconstructedObjects:proof.reconstructedObjects});
 }else if(options.mode==='damage'){
  if(state.phase!=='exported'||!matches(await inspect(),model.digest))failure();const bytes=await store.load('export.sql');if(sha(bytes)!==state.exportDigest||bytes.length!==state.exportBytes)failure();validateExport(bytes,model);await persist('damage-pending');await api.query(damageSQL);if(!matches(await inspect(),damagedDigest(model)))failure();await persist('damaged');
 }else if(options.mode==='restore'){
  if(state.phase!=='damaged'||!matches(await inspect(),damagedDigest(model)))failure();const bytes=await store.load('export.sql');if(sha(bytes)!==state.exportDigest||bytes.length!==state.exportBytes)failure();const proof=validateExport(bytes,model);const payload=Buffer.concat([Buffer.from(cleanupSQL(model)),modelSQL(proof.snapshot,model.tableOrder)]);if(payload.length>LIMIT)failure();await store.bytes('restore.sql',payload);await persist('restore-pending',{restoreDigest:sha(payload),restoreBytes:payload.length});await transport('restore',model,payload,recordImport('restore',sha(payload)));if(state.transport?.substage!=='complete')failure();if(!matches(await inspect(),model.digest))failure();await persist('restored');
 }else if(options.mode==='verify'){
  if(!['restored','complete'].includes(state.phase)||!matches(await inspect(),model.digest))failure();if(state.phase==='complete')return {phase:'complete',verified:true,repeated:true};await persist('probes-pending');
  for(const probe of operationalProbes(model))await api.probe(probe);
  if(!matches(await inspect(),model.digest))failure();await persist('complete',{probes:operationalProbes(model).map(p=>p.name)});
 }else failure();
 return {phase:state.phase,manifestDigest:state.manifestDigest,exportDigest:state.exportDigest,restoreDigest:state.restoreDigest};
}
async function durableJSON(path,value){const file=await open(path,'wx',0o600);try{await file.writeFile(canonical(value));await file.sync();}finally{await file.close();}}
async function storage(cwd){const dir=resolve(cwd,'.provision/application-recovery-spike');if(!execFileSync('git',['check-ignore','--','.provision/application-recovery-spike/manifest.json'],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim())failure();await mkdir(dir,{recursive:true});const path=name=>resolve(dir,name);return {dir,async read(name){try{return JSON.parse(await readFile(path(name),'utf8'));}catch(e){if(e.code==='ENOENT')return undefined;failure();}},async save(name,value,exclusive=false){const target=path(name);if(exclusive)return durableJSON(target,value);const temporary=target+'.'+randomUUID()+'.tmp';await durableJSON(temporary,value);await rename(temporary,target);},bytes:(name,bytes)=>writeFile(path(name),bytes,{flag:'wx',mode:0o600}),async load(name){if((await stat(path(name))).size>LIMIT)failure();return readFile(path(name));}};}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let model;try{
 const cwd=process.cwd(),options=parseArgs(process.argv.slice(2)),env=process.env;const remote=execFileSync('git',['remote','get-url','origin'],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();if(![`https://github.com/${REPOSITORY}.git`,`git@github.com:${REPOSITORY}.git`].includes(remote))failure();if(JSON.parse(await readFile(resolve(cwd,'node_modules/wrangler/package.json'),'utf8')).version!==WRANGLER)failure();
 const identity=JSON.parse(await readFile(resolve(cwd,'.provision/recovery-spike/identity.json'),'utf8'));const store=await storage(cwd);model=await buildModel();
 const api=provider(options,env);const transport=async(mode,current,validatedBytes,saveImport)=>{validateDestination(options,identity,await api.identity(),env);if(mode==='export'){const bytes=await api.export(current.tables);await store.bytes('export.sql',bytes);}else{await api.import(validatedBytes,saveImport);}};
 console.log(JSON.stringify(await runStage(options,{api,store,transport,identity,env,model})));
}catch(error){console.error(JSON.stringify({error:'Application recovery stage stopped; retain private checkpoints for coordinator review',...(error instanceof RecoveryTransportError?{diagnostic:error.diagnostic}:{})}));process.exitCode=1;}finally{model?.db.close();}}
