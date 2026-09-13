import {HttpError} from './http-error.ts';
import type {PreservedDriveSource} from './documentation-drive-source.ts';

const marker='lancerloginDocumentationCopy';
const opaque=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
function unresolved():never{throw new HttpError(409,'Preserved copy needs reconciliation; no additional copy is permitted');}

/** Query only the immutable operation marker and private parent after uncertain dispatch. */
export function preservedCopyQuery(operationId:string,rootId:string){
 if(!opaque(operationId)||!opaque(rootId))return unresolved();
 return `trashed=false and appProperties has { key='${marker}' and value='${operationId}' } and '${rootId}' in parents`;
}

function matches(file:Record<string,unknown>,operationId:string,rootId:string){
 return opaque(file.id)&&file.trashed===false&&object(file.appProperties)?.[marker]===operationId&&Array.isArray(file.parents)&&file.parents.length===1&&file.parents[0]===rootId;
}

/** A zero, multiple, incomplete or malformed result never grants another dispatch. */
export function reconcilePreservedCopy(value:unknown,operationId:string,rootId:string):string{
 preservedCopyQuery(operationId,rootId);
 const result=object(value);
 if(!result||result.nextPageToken||result.incompleteSearch===true||!Array.isArray(result.files)||result.files.length!==1)return unresolved();
 const file=object(result.files[0]);
 if(!file||!matches(file,operationId,rootId))return unresolved();
 return file.id as string;
}

/** Called with freshly fetched destination metadata and its complete permissions page.
 * Binary compute validation and the post-copy source version check are separate required gates.
 */
export function verifyPreservedCopy(value:unknown,permissionValue:unknown,expectedId:string,operationId:string,rootId:string,source:PreservedDriveSource){
 preservedCopyQuery(operationId,rootId);
 const file=object(value),permissions=object(permissionValue);
 if(!file||!opaque(expectedId)||file.id!==expectedId||expectedId===source.id||!matches(file,operationId,rootId)||file.mimeType!==source.mime||file.ownedByMe!==true||file.driveId||typeof file.version!=='string'||!/^\d{1,30}$/.test(file.version))return unresolved();
 if(!permissions||permissions.nextPageToken||!Array.isArray(permissions.permissions)||permissions.permissions.length!==1)return unresolved();
 const owner=object(permissions.permissions[0]);
 if(!owner||owner.type!=='user'||owner.role!=='owner'||owner.deleted===true)return unresolved();
 if(source.native)return {id:expectedId,mime:source.mime,version:file.version,native:true as const};
 // The binary source checksum must have been established before dispatch (by
 // provider metadata or a bounded original-byte read); destination size alone is insufficient.
 if(!Number.isSafeInteger(source.byteLength)||!source.byteLength||source.byteLength>4194304||!source.sha256||!/^[a-f0-9]{64}$/.test(source.sha256)||file.size!==String(source.byteLength)||file.sha256Checksum!==source.sha256)return unresolved();
 return {id:expectedId,mime:source.mime,version:file.version,native:false as const,byteLength:source.byteLength,sha256:source.sha256};
}
