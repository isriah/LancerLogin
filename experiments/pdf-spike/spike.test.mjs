import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {PDFDocument,PDFName} from 'pdf-lib';
import {assemblePacket,LIMITS,readBoundedStream} from './assemble.mjs';
const file=async name=>new Uint8Array(await readFile(new URL(`output/${name}`,import.meta.url)));
export const entry=(id,extra={})=>({id,revision:'synthetic-r1',caption:'Geometric demonstration evidence. Selected and numbered for the synthetic packet.',type:'link',url:'https://example.invalid/synthetic-evidence',...extra});
test('ordered PDF pages, PNG/JPEG, explicit linked item, deterministic manifest and bytes',async()=>{
  const items=[entry('png',{type:'image/png',bytes:await file('geometry.png')}),entry('pdf',{type:'application/pdf',bytes:await file('source.pdf'),selectedPages:[3,1]}),entry('jpeg',{type:'image/jpeg',bytes:await file('geometry.jpeg')}),entry('video-link')];
  const a=await assemblePacket(items), b=await assemblePacket(items);
  assert.deepEqual(a,b); assert.equal(a.pageCount,5);
  assert.deepEqual(a.manifest.map(x=>x.firstPage),[2,3,5,null]);
  const parsed=await PDFDocument.load(a.bytes);
  assert.equal(parsed.getPage(0).node.lookup(PDFName.of('Annots')).size(),4);
  await writeFile(new URL('output/representative.pdf',import.meta.url),a.bytes);
});
const rejects=(items,code)=>assert.rejects(assemblePacket(items),e=>e.code===code);
test('metadata, duplicate selection, missing bytes, explicit unsupported type',async()=>{
  await rejects([entry('same'),entry('same')],'INVALID_OR_DUPLICATE_ID');
  await rejects([entry('x',{caption:'Unicode requires a real font: \u2603'})],'INVALID_METADATA');
  await rejects([entry('x',{url:'javascript:alert(1)'})],'HTTPS_LINK_REQUIRED');
  await rejects([entry('x',{type:'video/mp4'})],'UNSUPPORTED_TYPE_USE_LINK');
  await rejects([entry('x',{type:'application/pdf'})],'MISSING_BYTES');
  await rejects([entry('x',{bytes:new Uint8Array([1])})],'INVALID_LINK_SELECTION');
});
test('corrupt/encrypted evidence and invalid selected page ranges fail closed',async()=>{
  for(const [name,code] of [['corrupt.pdf','CORRUPT_PDF_REEXPORT'],['encrypted.pdf','ENCRYPTED_PDF_REEXPORT']]) await rejects([entry('pdf',{type:'application/pdf',bytes:await file(name),selectedPages:[1]})],code);
  for(const selectedPages of [[0],[4],[1,1],[],[1.5]]) await rejects([entry('pdf',{type:'application/pdf',bytes:await file('source.pdf'),selectedPages})],'INVALID_PAGE_SELECTION');
  await rejects([entry('png',{type:'image/png',bytes:new Uint8Array([1,2,3])})],'CORRUPT_IMAGE');
});
test('byte, pixel, item, and source-page budgets',async()=>{
  const smallPng=await file('geometry.png');
  await rejects(Array.from({length:5},(_,i)=>entry(`png${i}`,{type:'image/png',bytes:smallPng})),'TOTAL_PNG_PIXEL_LIMIT');
  await rejects(Array.from({length:21},(_,i)=>entry(`i${i}`)),'ITEM_COUNT_LIMIT');
  await rejects([entry('large',{type:'application/pdf',bytes:new Uint8Array(LIMITS.fileBytes+1)})],'INPUT_BYTES_LIMIT');
  const png=await file('geometry.png'); new DataView(png.buffer).setUint32(16,100000);
  await rejects([entry('wide',{type:'image/png',bytes:png})],'IMAGE_PIXEL_LIMIT');
  const p=await PDFDocument.create(); for(let i=0;i<41;i++) p.addPage();
  await rejects([entry('pages',{type:'application/pdf',bytes:await p.save(),selectedPages:[1]})],'SOURCE_PAGE_LIMIT');
});
test('bounded stream supports chunked input and cancels overflow',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));c.enqueue(new Uint8Array([3,4]));},cancel(){cancelled=true;}});
  await assert.rejects(readBoundedStream(stream,3),e=>e.code==='FILE_BYTES_LIMIT'); assert.ok(cancelled);
  assert.deepEqual(await readBoundedStream(new Blob([new Uint8Array([4,5])]).stream()),new Uint8Array([4,5]));
});
test('20-item index paginates without dropping linked evidence',async()=>{
  const result=await assemblePacket(Array.from({length:20},(_,i)=>entry(`item-${i+1}`)));
  assert.equal(result.pageCount,4); assert.equal(result.manifest.length,20);
  await writeFile(new URL('output/index-boundary.pdf',import.meta.url),result.bytes);
});
