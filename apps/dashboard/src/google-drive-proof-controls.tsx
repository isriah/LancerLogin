import {useEffect,useId,useRef,useState} from 'react';
import {api} from './dashboard-api';
const base='/admin/connections/google/drive/feasibility-runs',storageKey='lancerlogin-drive-proof-run-ids';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const steps={
 folders:{title:'Create private test folders',text:'Create three owner-only synthetic folders under the selected private test root.'},
 copy:{title:'Copy the selected synthetic source',text:'Copy the selected source into the private originals folder and verify its version and content.'},
 'private-upload':{title:'Upload the private synthetic PDF',text:'Start or send one bounded upload chunk for a private synthetic PDF. Several explicit steps may be needed.'},
 'public-upload':{title:'Upload the public PDF candidate privately',text:'Start or send one bounded upload chunk for a separate synthetic PDF. It remains private until the publish step.'},
 publish:{title:'Publish the synthetic PDF',text:'Grant anyone with the link reader access to the separate synthetic public PDF. The root, copied source and private PDF stay private.'},
 replace:{title:'Replace the published synthetic PDF',text:'Start or send one bounded upload chunk replacing the public PDF with different synthetic content at the same file ID and link. The private version is retained.'},
 verify:{title:'Verify private and published versions',text:'Read provider permissions and content checksums. Anonymous link access still needs a separate browser check.'},
} as const;
type Stage=keyof typeof steps|'complete';
type Run={id:string;revision:number;status:'ready'|'pending'|'verified';stage:Stage;pending:boolean;offset:number;published:boolean;verified:boolean;publicUrl:string|null};
function validated(value:unknown,id:string):Run{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error();const r=value as Run;
 if(Object.keys(r).sort().join(',')!=='id,offset,pending,publicUrl,published,revision,stage,status,verified'||r.id!==id||!Number.isSafeInteger(r.revision)||r.revision<0||!['ready','pending','verified'].includes(r.status)||!(r.stage==='complete'||Object.hasOwn(steps,r.stage))||typeof r.pending!=='boolean'||typeof r.published!=='boolean'||typeof r.verified!=='boolean'||!Number.isSafeInteger(r.offset)||r.offset<0||r.offset>1048576||r.pending!==(r.status==='pending')||r.verified!==(r.stage==='complete')||r.verified!==(r.status==='verified')||r.verified&&!r.published)throw Error();
 if(r.published?(typeof r.publicUrl!=='string'||!/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{1,128}\/view$/.test(r.publicUrl)):r.publicUrl!==null)throw Error();return r;
}
export function GoogleDriveProofControls({revision,sourceIntentId,available,disabled,onBusyChange}:{revision:number;sourceIntentId?:string;available:boolean;disabled:boolean;onBusyChange:(busy:boolean)=>void}){
 const id=useId(),lock=useRef(false),noticeRef=useRef<HTMLParagraphElement>(null),alive=useRef(true),focusPending=useRef(false);
 const [ids,setIds]=useState<string[]>([]),[selected,setSelected]=useState(''),[storageReady,setStorageReady]=useState(false),[run,setRun]=useState<Run>(),[readRevision,setReadRevision]=useState<number>(),[confirmed,setConfirmed]=useState(false),[notice,setNotice]=useState('');
 useEffect(()=>{alive.current=true;try{const raw=localStorage.getItem(storageKey),saved:unknown=raw===null?[]:JSON.parse(raw);if(!Array.isArray(saved)||saved.length>16||saved.some(x=>typeof x!=='string'||!uuid.test(x))||new Set(saved).size!==saved.length)throw Error();setIds(saved);setSelected(saved.at(-1)??'');setStorageReady(true);}catch{setNotice('Saved proof identities could not be read. Ask the maintainer to review browser storage before creating a run.');}return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(!disabled&&notice&&focusPending.current){noticeRef.current?.focus();focusPending.current=false;}},[disabled,notice]);
 const usable=!disabled&&available&&storageReady,fresh=run?.id===selected&&readRevision===revision;
 async function perform(action:'create'|'read'|'resume'){
  if(lock.current||!usable||action==='create'&&(!confirmed||!sourceIntentId||ids.length>=16||ids.length>0&&(!fresh||!run?.verified||selected!==ids.at(-1)))||action==='read'&&!selected||action==='resume'&&(!confirmed||!fresh||!run||run.verified))return;
  lock.current=true;focusPending.current=true;onBusyChange(true);setConfirmed(false);let target=selected;
  try{
   if(action==='create'){
    target=crypto.randomUUID();const next=[...ids,target];try{localStorage.setItem(storageKey,JSON.stringify(next));setIds(next);setSelected(target);setRun(undefined);setReadRevision(undefined);if(localStorage.getItem(storageKey)!==JSON.stringify(next))throw Error();}catch{setStorageReady(false);throw Error();}
   }
   const value=await api<unknown>(base+(action==='create'?'':'/'+target+(action==='resume'?'/resume':'')),action==='read'?undefined:{method:'POST',body:JSON.stringify(action==='create'?{revision,runId:target,sourceIntentId,confirmation:'RUN SYNTHETIC DRIVE PROOF'}:{revision,runRevision:run!.revision,confirmation:'CONTINUE SYNTHETIC DRIVE PROOF'})});
   if(alive.current){setRun(validated(value,target));setReadRevision(revision);setNotice(action==='read'?'Existing run status loaded. Review the next step before continuing.':'Step response confirmed. Review the next step; nothing will continue automatically.');}
  }catch{if(alive.current){setRun(undefined);setReadRevision(undefined);setNotice('The run outcome could not be confirmed. Keep the saved run ID and read its status before any further action. Do not create a replacement or repeat the mutation. If no run is found, ask the maintainer to review it.');}}
  finally{lock.current=false;onBusyChange(false);}
 }
 const next=fresh&&run&&run.stage!=='complete'?steps[run.stage]:undefined;
 return <section aria-labelledby={id+'-title'} className="integration-card google-connection"><h3 id={id+'-title'}>Staged synthetic Drive proof</h3><p>Development-only checks using the selected synthetic source and private test folder. Each action below performs one bounded step. Publishing will make only the separate synthetic public PDF readable by anyone with its link.</p>
 {notice&&<p className="ui-status" role="status" tabIndex={-1} ref={noticeRef}>{notice}</p>}
 {ids.length>0&&<label>Saved proof run<select value={selected} disabled={!usable} onChange={e=>{setSelected(e.target.value);setRun(undefined);setReadRevision(undefined);setConfirmed(false);setNotice('Read this saved run before continuing.');}}>{ids.map(value=><option key={value} value={value}>{value}</option>)}</select></label>}
 {selected&&<p>Development run ID: {selected}</p>}{selected&&<div className="google-actions"><button disabled={!usable} onClick={()=>void perform('read')}>Read proof status</button></div>}
 {fresh&&run&&<><p>Run status: {run.status}. Stage: {run.stage}. Confirmed upload offset: {run.offset} bytes.</p>{run.pending&&<p>The previous step is pending. Continuing reconciles the saved operation before another write; it does not blindly repeat an uncertain operation.</p>}{next&&<p><strong>{next.title}.</strong> {next.text}</p>}{run.verified&&<p>Provider checks complete. Independently verify anonymous access to the public link and denial of access to private originals. This is not production or full updater acceptance.</p>}{run.publicUrl&&<p><a href={run.publicUrl} target="_blank" rel="noopener noreferrer">Open synthetic published PDF</a></p>}</>}
 {!fresh&&selected&&<p>Saved identity retained. Read proof status to obtain the current run revision before continuing.</p>}
 <fieldset disabled={!usable}><legend>Explicit step confirmation</legend><label className="module-choice"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I reviewed the synthetic destination and the operation described above, including any public link access.</label><div className="google-actions">
 {next&&<button disabled={!confirmed} onClick={()=>void perform('resume')}>{run?.pending?'Reconcile pending proof step':next.title}</button>}
 {(!ids.length||fresh&&run?.verified&&selected===ids.at(-1))&&<button disabled={!confirmed||!sourceIntentId||ids.length>=16} onClick={()=>void perform('create')}>Create synthetic proof run</button>}
 </div></fieldset><p>Creating a run reserves five test file identities and records the selected source; it does not create folders or publish files. Select a synthetic source first; its authorization expires within ten minutes. If creation is rejected, read the saved run before selecting again. Existing recorded runs remain available without a fresh source selection. Only run UUIDs are saved in this browser; tokens and provider state remain on the server. A lost response always requires readback.</p></section>;
}
