import {HttpError} from './http-error.ts';

export type PreservedDriveSource={id:string;name:string;mime:string;version:string;native:boolean;byteLength?:number;sha256?:string};
const opaque=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
/** Provider metadata only; client Picker labels and pasted URLs never establish this contract. */
export function preservedDriveSource(value:unknown,expectedId:string):PreservedDriveSource{
 const fail=():never=>{throw new HttpError(409,'Select a copyable Drive original; binary files must be at most 4 MiB');};
 if(!value||typeof value!=='object'||Array.isArray(value)||!opaque(expectedId))return fail();const v=value as Record<string,unknown>,cap=v.capabilities as Record<string,unknown>|undefined;
 if(v.id!==expectedId||v.trashed!==false||cap?.canCopy!==true||typeof v.name!=='string'||!v.name||v.name.length>255||typeof v.mimeType!=='string'||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/.test(v.mimeType)||v.mimeType.length>150||typeof v.version!=='string'||!/^\d{1,30}$/.test(v.version))return fail();
 const native=v.mimeType.startsWith('application/vnd.google-apps.');
 if(['application/vnd.google-apps.folder','application/vnd.google-apps.shortcut'].includes(v.mimeType))return fail();
 const base={id:expectedId,name:v.name,mime:v.mimeType,version:v.version,native};if(native)return base;
 if(typeof v.size!=='string'||!/^\d{1,16}$/.test(v.size))return fail();const byteLength=Number(v.size);if(!Number.isSafeInteger(byteLength)||byteLength<1||byteLength>4194304)return fail();
 if(v.sha256Checksum!==undefined&&(typeof v.sha256Checksum!=='string'||!/^[a-f0-9]{64}$/.test(v.sha256Checksum)))return fail();
 return {...base,byteLength,...(typeof v.sha256Checksum==='string'?{sha256:v.sha256Checksum}:{})};
}
/** A native copy has no synthetic byte/hash identity; binary copies require exact original bytes. */
export function samePreservedDriveSource(before:PreservedDriveSource,after:PreservedDriveSource){
 return before.id===after.id&&before.mime===after.mime&&before.version===after.version&&before.native===after.native&&before.byteLength===after.byteLength&&before.sha256===after.sha256;
}
