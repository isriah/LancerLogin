import test from 'node:test';
import assert from 'node:assert/strict';
import {preservedDriveSource,samePreservedDriveSource} from '../apps/api/src/documentation-drive-source.ts';
const native={id:'selected',name:'Ordinary document',mimeType:'application/vnd.google-apps.document',version:'42',trashed:false,capabilities:{canCopy:true}};
test('Drive originals use provider identity and preserve native semantics without invented binary commitments',()=>{
 const source=preservedDriveSource({...native,size:'999999999999',sha256Checksum:'not a native hash'},'selected');assert.deepEqual(source,{id:'selected',name:'Ordinary document',mime:native.mimeType,version:'42',native:true});
 const binary={...native,mimeType:'application/pdf',size:'4194304',sha256Checksum:'a'.repeat(64)};assert.equal(preservedDriveSource(binary,'selected').byteLength,4194304);
 for(const update of [{id:'another'},{trashed:true},{capabilities:{canCopy:false}},{version:''},{mimeType:'application/vnd.google-apps.folder'},{mimeType:'application/vnd.google-apps.shortcut'}])assert.throws(()=>preservedDriveSource({...native,...update},'selected'),e=>e.status===409);
 for(const update of [{size:'4194305'},{size:'0'},{size:'1.5'},{size:'9007199254740992'},{sha256Checksum:'bad'}])assert.throws(()=>preservedDriveSource({...binary,...update},'selected'),e=>e.status===409);
 assert.equal(samePreservedDriveSource(source,{...source,version:'43'}),false);assert.equal(samePreservedDriveSource(source,{...source,name:'Renamed label'}),true);
});
