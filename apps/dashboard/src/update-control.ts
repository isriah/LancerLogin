import { api } from './dashboard-api';
import type { UpdaterStatus } from './update-indicator';
type Admission={requestId:string;releaseId:number};
type Controller={call:(action:string,body?:unknown)=>Promise<UpdaterStatus>;window:Window;admission:Admission;dispose:()=>void};
let active:Controller|null=null;
export function hasUpdateControl(admission?:Admission){if(active?.window.closed)active.dispose();return Boolean(active&&(!admission||(active.admission.requestId===admission.requestId&&active.admission.releaseId===admission.releaseId)));}
export function controlRequest(action:string,body?:unknown){if(!hasUpdateControl())return Promise.reject(Error('Update controller is closed. Open independent recovery.'));return active!.call(action,body);}
export async function connectUpdateControl(url:string,admission:Admission){
 const location=new URL(url);if(location.protocol!=='https:'||location.pathname!=='/control'||location.search||location.hash)throw Error('Invalid controller address.');
 active?.dispose();
 const popup=window.open(url,'lancerlogin-update-control','popup,width=760,height=720');if(!popup)throw Error('Allow the update controller window before starting.');
 const requests=new Map<string,{resolve:(value:UpdaterStatus)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 let readyResolve!:()=>void;let readyTimer:ReturnType<typeof setTimeout>;const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyTimer=setTimeout(()=>reject(Error('Controller did not become ready. Retry before starting.')),15000)});
 const dispose=()=>{window.removeEventListener('message',listener);clearTimeout(readyTimer);if(active?.window===popup)active=null;for(const pending of requests.values()){clearTimeout(pending.timer);pending.reject(Error('Controller ended. Refresh status or use independent recovery.'));}requests.clear();};
 const listener=(event:MessageEvent)=>{if(event.origin!==location.origin||event.source!==popup)return;if(event.data?.type==='ll-control-ready'){clearTimeout(readyTimer);readyResolve();}if(event.data?.type!=='ll-control-result')return;const pending=requests.get(event.data.id);if(!pending)return;clearTimeout(pending.timer);requests.delete(event.data.id);if(event.data.error)pending.reject(Error('Control response unavailable. Refresh before retrying.'));else pending.resolve(event.data.value as UpdaterStatus);if(active?.window===popup&&(event.data.ended||event.data.value?.ended||event.data.value?.authenticated===false||event.data.value?.admission?.state==='rejected'))dispose();};
 window.addEventListener('message',listener);
 const call=(action:string,body?:unknown)=>new Promise<UpdaterStatus>((resolve,reject)=>{const id=crypto.randomUUID();requests.set(id,{resolve,reject,timer:setTimeout(()=>{requests.delete(id);reject(Error('Control response unavailable. Refresh before retrying.'));},35000)});popup.postMessage({type:'ll-control-command',id,action,body},location.origin);});
 try{await ready;let value:UpdaterStatus&{requestId?:string}|undefined;try{value=await call('status')}catch{/* An unconsumed grant requires the authenticated application path. */}
 if(value?.requestId!==admission.requestId){const grant=await api<{grant:string;requestId:string;controlUrl:string}>('/admin/updater/control-grant',{method:'POST',body:JSON.stringify(admission)});if(grant.controlUrl!==url||grant.requestId!==admission.requestId)throw Error('Controller identity changed.');value=await call('exchange',{grant:grant.grant});}
 if(value?.requestId!==admission.requestId||value.ended)throw Error('Controller admission changed.');active={call,window:popup,admission,dispose};}
 catch(error){dispose();throw error;}
}
