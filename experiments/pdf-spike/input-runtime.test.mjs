import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {deflateSync} from 'node:zlib';
import {PDFDocument,PDFName,PDFNumber} from 'pdf-lib';
import images from './synthetic-images.json' with {type:'json'};
import {runIsolated} from './input-supervisor.mjs';
const miniflare=process.env.LOCAL_MINIFLARE;
assert.ok(miniflare,'Set LOCAL_MINIFLARE to the existing installed package directory; no downloads');
const out=resolve('output/input-validation');await mkdir(out,{recursive:true});
const results=[];
async function fixture(id,bytes,mime,expected,mode='strict',options){
  const path=resolve(out,id);await writeFile(path,bytes);
  const result=await runIsolated(miniflare,path,mime,mode,options);results.push({fixture:id,...result});
  assert.equal(result.code??result.outcome,expected,JSON.stringify({id,result}));return result;
}
async function document({modern=false,image=false,action=false,pages=1}={}){
  const doc=await PDFDocument.create();
  for(let i=0;i<pages;i++){const page=doc.addPage([500,700]);page.drawText('Ordinary synthetic PDF');
    if(image)page.drawImage(await doc.embedJpg(Buffer.from(images.jpeg,'base64')),{x:20,y:20,width:300,height:200});}
  if(action)doc.catalog.set(PDFName.of('OpenAction'),doc.context.obj({S:'JavaScript',JS:'synthetic action'}));
  return doc.save({useObjectStreams:modern});
}
function rawPdf(content,dict=''){
  const chunks=[Buffer.from('%PDF-1.7\n')],offsets=[0];
  const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 700] /Resources << >> /Contents 4 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} ${dict} >>\nstream\n`),content,Buffer.from('\nendstream')])];
  for(let i=0;i<objects.length;i++){offsets.push(chunks.reduce((n,b)=>n+b.length,0));chunks.push(Buffer.from(`${i+1} 0 obj\n`),objects[i],Buffer.from('\nendobj\n'));}
  const xref=chunks.reduce((n,b)=>n+b.length,0);chunks.push(Buffer.from(`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));return Buffer.concat(chunks);
}
test('ordinary images and vector/image PDFs actually embed in disposable local workerd',async()=>{
  await fixture('ordinary.png',Buffer.from(images.png,'base64'),'image/png','embedded');
  await fixture('ordinary.jpeg',Buffer.from(images.jpeg,'base64'),'image/jpeg','embedded');
  await fixture('ordinary-vector.pdf',await document(),'application/pdf','embedded');
  await fixture('ordinary-image.pdf',await document({image:true}),'application/pdf','embedded');
  await fixture('plain-content.pdf',rawPdf(Buffer.from('q 1 0 0 1 0 0 cm Q')),'application/pdf','embedded');
});
test('modern compressed-object PDFs compare compatibility without claiming production eligibility',async()=>{
  const bytes=await document({modern:true,image:true});
  await fixture('modern-strict.pdf',bytes,'application/pdf','PDF_OBJECT_STREAM_UNSUPPORTED');
  const r=await fixture('modern-isolated.pdf',bytes,'application/pdf','embedded','isolated-comparison');assert.equal(r.productionEligible,false);
});
test('transport and unsupported linked evidence remain distinct',async()=>{
  await fixture('linked.txt',Buffer.from('Synthetic linked evidence'),'text/plain','linked-only');
  await fixture('mismatch.bin',Buffer.from(images.png,'base64'),'application/pdf','TYPE_MISMATCH');
  await fixture('oversize.bin',Buffer.alloc(4*1024**2+1),'application/pdf','BYTE_LIMIT');
  await fixture('empty.bin',Buffer.alloc(0),'image/png','BYTE_LIMIT');
});
test('malformed, active, encrypted and unsupported PDF features fail explicitly',async()=>{
  await fixture('truncated.pdf',Buffer.from('%PDF-1.7\ntruncated'),'application/pdf','CORRUPT_PDF');
  await fixture('active.pdf',await document({action:true}),'application/pdf','PDF_ACTIVE_FEATURE');
  await fixture('active-modern.pdf',await document({action:true,modern:true}),'application/pdf','PDF_ACTIVE_FEATURE','isolated-comparison');
  await fixture('encoded-active.pdf',rawPdf(Buffer.from(''),'/J#53 (not executed)'),'application/pdf','PDF_ACTIVE_FEATURE');
  await fixture('embedded-file-isolated.pdf',rawPdf(Buffer.from(''),'/Type /EmbeddedFile'),'application/pdf','PDF_ACTIVE_FEATURE','isolated-comparison');
  await fixture('encrypted.pdf',rawPdf(Buffer.from(''),'/Encrypt << >>'),'application/pdf','PDF_ENCRYPTED');
  await fixture('password-encrypted.pdf',await readFile('output/encrypted.pdf'),'application/pdf','PDF_ENCRYPTED');
  await fixture('password-encrypted-isolated.pdf',await readFile('output/encrypted.pdf'),'application/pdf','PDF_ENCRYPTED','isolated-comparison');
  await fixture('indirect-length.pdf',rawPdf(Buffer.from('q Q')).toString('latin1').replace('/Length 3','/Length 9 0 R'),'application/pdf','PDF_STREAM_LENGTH_UNSUPPORTED');
  await fixture('unsupported-filter.pdf',rawPdf(Buffer.from('data'),'/Filter /LZWDecode'),'application/pdf','PDF_FILTER_UNSUPPORTED');
  await fixture('depth.pdf',rawPdf(Buffer.from(''),'/Extra '+ '['.repeat(40)+'0'+']'.repeat(40)),'application/pdf','PDF_DEPTH_LIMIT');
  await fixture('cycle.pdf',rawPdf(Buffer.from(''),'/Extra 4 0 R'),'application/pdf','PDF_RESOURCE_CYCLE');
  await fixture('too-many-pages.pdf',await document({pages:41}),'application/pdf','PDF_PAGE_LIMIT');
});
test('bounded expansion fails before retaining excessive decoded content',async()=>{
  await fixture('deflate-bomb.pdf',rawPdf(deflateSync(Buffer.alloc(8*1024**2+1,32)), '/Filter /FlateDecode'),'application/pdf','STREAM_EXPANSION_LIMIT');
  await fixture('broken-deflate.pdf',rawPdf(Buffer.from('broken'),'/Filter /FlateDecode'),'application/pdf','CORRUPT_COMPRESSED_STREAM');
  const png=Buffer.from(images.png,'base64');png[png.length-5]^=1;
  await fixture('bad-crc.png',png,'image/png','CORRUPT_PNG');
  await fixture('trailing.jpeg',Buffer.concat([Buffer.from(images.jpeg,'base64'),Buffer.from('trailing')]),'image/jpeg','CORRUPT_JPEG');
});
test('phone-photo pixel and object budgets are explicit compatibility limits',async()=>{
  const png=Buffer.from(images.png,'base64');png.writeUInt32BE(4032,16);png.writeUInt32BE(3024,20);
  let crc=0xffffffff;for(const byte of png.subarray(12,29)){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}png.writeUInt32BE((crc^0xffffffff)>>>0,29);
  await fixture('phone-dimensions.png',png,'image/png','IMAGE_PIXEL_LIMIT');
  const doc=await PDFDocument.create();doc.addPage();for(let i=0;i<2001;i++)doc.context.register(PDFNumber.of(i));
  await fixture('object-limit.pdf',await doc.save({useObjectStreams:false}),'application/pdf','PDF_OBJECT_LIMIT');
  await fixture('modern-object-limit.pdf',await doc.save(),'application/pdf','PDF_OBJECT_LIMIT','isolated-comparison');
});
test('supervisor terminates an actually hung workerd, then independent run recovers',async()=>{
  await fixture('hang.bin',Buffer.from('synthetic'),'text/plain','WALL_DEADLINE','hang',{wallMs:500});
  await fixture('after-hang.jpeg',Buffer.from(images.jpeg,'base64'),'image/jpeg','embedded');
  await writeFile(resolve(out,'results.json'),JSON.stringify({runtime:'local workerd, one disposable process per input',productionEligible:false,results},null,2));
});
