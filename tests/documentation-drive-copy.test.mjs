import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcilePreservedCopy,verifyPreservedCopy,preservedCopyQuery} from '../apps/api/src/documentation-drive-copy.ts';
const source={id:'source',name:'Synthetic original',mime:'application/vnd.google-apps.document',version:'42',native:true};
const copied={id:'copy',mimeType:source.mime,version:'1',trashed:false,ownedByMe:true,parents:['root'],appProperties:{lancerloginDocumentationCopy:'operation'}};
const permissions={permissions:[{type:'user',role:'owner'}]};
const rejects=fn=>assert.throws(fn,error=>error.status===409&&error.message.includes('no additional copy'));

test('uncertain copy reconciliation requires one exact result and never interprets no match as retry permission',()=>{
 assert.equal(reconcilePreservedCopy({files:[copied]},'operation','root'),'copy');
 for(const result of [{files:[]},{files:[copied,copied]},{files:[copied],nextPageToken:'more'},{files:[copied],incompleteSearch:true},{files:[{...copied,parents:['another']}]},{files:[{...copied,appProperties:{lancerloginDocumentationCopy:'another'}}]},{files:[{...copied,trashed:true}]}])rejects(()=>reconcilePreservedCopy(result,'operation','root'));
 rejects(()=>preservedCopyQuery("operation' or trashed=true",'root'));
});

test('preserved destination validates private ownership and native identity without inventing binary evidence',()=>{
 assert.deepEqual(verifyPreservedCopy(copied,permissions,'copy','operation','root',source),{id:'copy',mime:source.mime,version:'1',native:true});
 for(const update of [{id:'source'},{mimeType:'application/pdf'},{ownedByMe:false},{driveId:'shared'},{parents:['root','other']},{version:''}])rejects(()=>verifyPreservedCopy({...copied,...update},permissions,'copy','operation','root',source));
 for(const permission of [{permissions:[]},{permissions:[...permissions.permissions,{type:'anyone',role:'reader'}]},{...permissions,nextPageToken:'more'},{permissions:[{type:'user',role:'owner',deleted:true}]}])rejects(()=>verifyPreservedCopy(copied,permission,'copy','operation','root',source));
 const binary={...source,mime:'application/pdf',native:false,byteLength:10,sha256:'a'.repeat(64)},file={...copied,mimeType:binary.mime,size:'10',sha256Checksum:binary.sha256};
 assert.equal(verifyPreservedCopy(file,permissions,'copy','operation','root',binary).sha256,binary.sha256);
 rejects(()=>verifyPreservedCopy({...file,sha256Checksum:'b'.repeat(64)},permissions,'copy','operation','root',binary));
 rejects(()=>verifyPreservedCopy(file,permissions,'copy','operation','root',{...binary,sha256:undefined}));
});
