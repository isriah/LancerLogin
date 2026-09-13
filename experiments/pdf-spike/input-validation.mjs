import {PDFDocument, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFName, PDFNumber} from 'pdf-lib';
import {assemblePacket, LIMITS} from './assemble.mjs';

// Experimental admission profile, deliberately narrower than the PDF specification.
export const INPUT_LIMITS = Object.freeze({...LIMITS, objects:2000, tokens:100000, depth:32,
  streamBytes:8*1024**2, expandedBytes:16*1024**2, imageSide:10000});
export class InputError extends Error { constructor(code) { super(code); this.code=code; } }
const fail=code=>{throw new InputError(code);};
const name=key=>PDFName.of(key);
const dangerous=new Set(['Encrypt','JavaScript','JS','OpenAction','AA','Launch','EmbeddedFiles','EmbeddedFile',
  'Filespec','RichMedia','XFA','AcroForm','URI','GoToR','SubmitForm','ImportData','Movie','Sound','Rendition']);
const unsupported=new Set(['ObjStm','XRef']);
const signature=(b,a)=>a.every((v,i)=>b[i]===v);
const dimensions=(w,h)=>{if(!w||!h||w>INPUT_LIMITS.imageSide||h>INPUT_LIMITS.imageSide||w*h>INPUT_LIMITS.imagePixels)fail('IMAGE_PIXEL_LIMIT');};

export async function boundedRead(stream,max=INPUT_LIMITS.fileBytes) {
  const reader=stream.getReader(), chunks=[];let size=0;
  try {for(;;){const {value,done}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||value.length>max-size){await reader.cancel();fail('BYTE_LIMIT');}
    size+=value.length;chunks.push(value);
  }} finally {reader.releaseLock();}
  const result=new Uint8Array(size);let p=0;for(const c of chunks){result.set(c,p);p+=c.length;}return result;
}
async function inflate(bytes,max) {
  try {return await boundedRead(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')),max);}
  catch(e){if(e instanceof InputError)fail('STREAM_EXPANSION_LIMIT');fail('CORRUPT_COMPRESSED_STREAM');}
}
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
async function png(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);let p=8,w,h,channels,seenData=false,ended=false;const chunks=[];
  while(p+12<=bytes.length){const n=view.getUint32(p);if(n>bytes.length-p-12)fail('CORRUPT_PNG');
    const type=String.fromCharCode(...bytes.subarray(p+4,p+8));
    if(crc32(bytes.subarray(p+4,p+8+n))!==view.getUint32(p+8+n))fail('CORRUPT_PNG');
    if(p===8&&type!=='IHDR')fail('CORRUPT_PNG');
    if(type==='IHDR'){if(p!==8||n!==13)fail('CORRUPT_PNG');w=view.getUint32(p+8);h=view.getUint32(p+12);dimensions(w,h);
      channels=({0:1,2:3,4:2,6:4})[bytes[p+17]];
      if(bytes[p+16]!==8||!channels||bytes[p+18]||bytes[p+19]||bytes[p+20])fail('PNG_PROFILE_UNSUPPORTED');
    }else if(type==='IDAT'){if(ended)fail('CORRUPT_PNG');seenData=true;chunks.push(bytes.subarray(p+8,p+8+n));}
    else if(type==='IEND'){if(n||!seenData||p+12!==bytes.length)fail('CORRUPT_PNG');ended=true;p+=12;break;}
    else {if(seenData)ended=true;if(!['sRGB','gAMA','pHYs'].includes(type))fail('PNG_PROFILE_UNSUPPORTED');}
    p+=n+12;
  }
  if(!ended||p!==bytes.length)fail('CORRUPT_PNG');
  const expected=h*(1+w*channels);if(expected>INPUT_LIMITS.expandedBytes)fail('STREAM_EXPANSION_LIMIT');
  const data=await inflate(new Uint8Array(await new Blob(chunks).arrayBuffer()),expected);
  if(data.length!==expected)fail('CORRUPT_PNG');
  for(let i=0;i<h;i++)if(data[i*(1+w*channels)]>4)fail('CORRUPT_PNG');
  return {width:w,height:h};
}
function jpeg(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);let p=2,w,h,scans=0;
  while(p<bytes.length){if(bytes[p++]!==255)fail('CORRUPT_JPEG');while(bytes[p]===255)p++;const marker=bytes[p++];
    if(marker===0xd9){if(p!==bytes.length||!w||!scans)fail('CORRUPT_JPEG');return {width:w,height:h};}
    if(p+2>bytes.length)fail('CORRUPT_JPEG');const len=view.getUint16(p);if(len<2||p+len>bytes.length)fail('CORRUPT_JPEG');
    if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker)){
      if(![0xc0,0xc2].includes(marker)||w||len<8||bytes[p+2]!==8||![1,3].includes(bytes[p+7]))fail('JPEG_PROFILE_UNSUPPORTED');
      h=view.getUint16(p+3);w=view.getUint16(p+5);dimensions(w,h);
    }
    p+=len;
    if(marker===0xda){if(!w||++scans>64)fail('CORRUPT_JPEG');while(p<bytes.length){if(bytes[p]!==255){p++;continue;}const next=bytes[p+1];if(next===0||next>=0xd0&&next<=0xd7){p+=2;continue;}break;}}
  }
  fail('CORRUPT_JPEG');
}

// Scan BEFORE pdf-lib, skipping bounded literal strings and exact direct-length stream bytes.
// Reject modern object/xref streams rather than allowing pdf-lib to expand them while loading.
function pdfLex(bytes) {
  const s=new TextDecoder('latin1').decode(bytes);let p=0,count=0,objects=0;const stack=[];let lastDict=null;
  const delimiter=c=>!c||/[\s\x00()<>\[\]{}/%]/.test(c);
  const token=t=>{if(++count>INPUT_LIMITS.tokens)fail('PDF_TOKEN_LIMIT');if(stack.length)stack.at(-1).tokens.push(t);};
  while(p<s.length){const c=s[p];if(/[\s\x00]/.test(c)){p++;continue;}if(c==='%'){while(p<s.length&&!/[\r\n]/.test(s[p]))p++;continue;}
    if(c==='('){let depth=1;p++;while(p<s.length&&depth){if(s[p]==='\\'){p+=2;continue;}if(s[p]==='('&&++depth>INPUT_LIMITS.depth)fail('PDF_DEPTH_LIMIT');if(s[p]===')')depth--;p++;}if(depth)fail('CORRUPT_PDF');token('string');continue;}
    if(s.slice(p,p+2)==='<<'){token('nested');stack.push({kind:'dict',tokens:[]});p+=2;if(stack.length>INPUT_LIMITS.depth)fail('PDF_DEPTH_LIMIT');continue;}
    if(s.slice(p,p+2)==='>>'){if(stack.at(-1)?.kind!=='dict')fail('CORRUPT_PDF');lastDict=stack.pop().tokens;p+=2;continue;}
    if(c==='['){token('nested');stack.push({kind:'array',tokens:[]});p++;if(stack.length>INPUT_LIMITS.depth)fail('PDF_DEPTH_LIMIT');continue;}
    if(c===']'){if(stack.pop()?.kind!=='array')fail('CORRUPT_PDF');p++;continue;}
    if(c==='<'){p++;while(p<s.length&&s[p]!=='>'){if(!/[\da-fA-F\s]/.test(s[p++]))fail('CORRUPT_PDF');}if(s[p++]!=='>')fail('CORRUPT_PDF');token('string');continue;}
    if(c==='/'){let n='';p++;while(p<s.length&&!delimiter(s[p])){if(s[p]==='#'){if(!/^[\da-fA-F]{2}$/.test(s.slice(p+1,p+3)))fail('CORRUPT_PDF');n+=String.fromCharCode(parseInt(s.slice(p+1,p+3),16));p+=3;}else n+=s[p++];}
      if(dangerous.has(n))fail(n==='Encrypt'?'PDF_ENCRYPTED':'PDF_ACTIVE_FEATURE');if(unsupported.has(n))fail('PDF_OBJECT_STREAM_UNSUPPORTED');token('/'+n);continue;}
    const start=p;while(p<s.length&&!delimiter(s[p]))p++;if(start===p)fail('CORRUPT_PDF');const t=s.slice(start,p);token(t);
    if(t==='obj'&&++objects>INPUT_LIMITS.objects)fail('PDF_OBJECT_LIMIT');
    if(t==='stream'){
      if(stack.length||!lastDict)fail('CORRUPT_PDF');const i=lastDict.indexOf('/Length');const length=lastDict[i+1];
      if(i<0||lastDict.lastIndexOf('/Length')!==i||!/^\d+$/.test(length)||/^\d+$/.test(lastDict[i+2]??''))fail('PDF_STREAM_LENGTH_UNSUPPORTED');
      const n=Number(length);if(!Number.isSafeInteger(n)||n>INPUT_LIMITS.fileBytes||n>s.length-p)fail('CORRUPT_PDF');
      if(s[p]==='\r')p++;if(s[p++]!=='\n')fail('CORRUPT_PDF');p+=n;
      if(s[p]==='\r')p++;if(s[p]==='\n')p++;if(s.slice(p,p+9)!=='endstream'||!delimiter(s[p+9]))fail('CORRUPT_PDF');p+=9;lastDict=null;
    }
  }
  if(stack.length||!objects||!/^%PDF-1\.[0-7][\r\n]/.test(s)||! /%%EOF\s*$/.test(s))fail('CORRUPT_PDF');
}
async function pdf(bytes,isolatedComparison) {
  if(!isolatedComparison)pdfLex(bytes);let doc;
  try {doc=await PDFDocument.load(bytes,{ignoreEncryption:true,throwOnInvalidObject:true,updateMetadata:false});}catch{fail('CORRUPT_PDF');}
  if(doc.isEncrypted)fail('PDF_ENCRYPTED');const objects=doc.context.enumerateIndirectObjects();if(objects.length>INPUT_LIMITS.objects)fail('PDF_OBJECT_LIMIT');
  let expanded=0;const walked=new Set();
  function walk(obj,path=new Set(),depth=0){if(depth>INPUT_LIMITS.depth)fail('PDF_DEPTH_LIMIT');
    if(obj instanceof PDFName&&dangerous.has(obj.decodeText()))fail('PDF_ACTIVE_FEATURE');
    if(obj instanceof PDFRef){const key=obj.toString();if(path.has(key))fail('PDF_RESOURCE_CYCLE');if(walked.has(key))return;const next=new Set(path);next.add(key);const resolved=doc.context.lookup(obj);if(!resolved)fail('CORRUPT_PDF');walk(resolved,next,depth+1);walked.add(key);return;}
    if(obj instanceof PDFRawStream)obj=obj.dict;
    if(obj instanceof PDFDict)for(const [k,v]of obj.entries()){const key=k.decodeText();if(dangerous.has(key))fail('PDF_ACTIVE_FEATURE');
      if(key==='Annots'&&(!(v instanceof PDFArray)||v.size()!==0))fail('PDF_ACTIVE_FEATURE');
      if(key!=='Parent')walk(v,path,depth+1);}
    if(obj instanceof PDFArray)for(let i=0;i<obj.size();i++)walk(obj.get(i),path,depth+1);
  }
  for(const [ref,obj] of objects){walk(ref);
    if(obj instanceof PDFRawStream){const filter=obj.dict.get(name('Filter'));if(obj.dict.has(name('DecodeParms')))fail('PDF_FILTER_UNSUPPORTED');
      let content=obj.contents;
      if(filter){if(!(filter instanceof PDFName))fail('PDF_FILTER_UNSUPPORTED');const f=filter.decodeText();
        if(f==='FlateDecode'){content=await inflate(content,Math.min(INPUT_LIMITS.streamBytes,INPUT_LIMITS.expandedBytes-expanded));obj.contents=content;obj.dict.delete(name('Filter'));obj.dict.set(name('Length'),PDFNumber.of(content.length));}
        else if(f==='DCTDecode')jpeg(content);else fail('PDF_FILTER_UNSUPPORTED');
      }
      expanded+=content.length;if(content.length>INPUT_LIMITS.streamBytes||expanded>INPUT_LIMITS.expandedBytes)fail('STREAM_EXPANSION_LIMIT');
      if(obj.dict.get(name('Subtype'))?.toString()==='/Image'){const w=obj.dict.lookup(name('Width'),PDFNumber).asNumber(),h=obj.dict.lookup(name('Height'),PDFNumber).asNumber();dimensions(w,h);}
    }
  }
  let pages;try{pages=doc.getPages();}catch{fail('CORRUPT_PDF');}if(!pages.length||pages.length>INPUT_LIMITS.sourcePages)fail('PDF_PAGE_LIMIT');
  for(const page of pages){const {width,height}=page.getSize();if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>14400||height>14400)fail('PDF_PAGE_GEOMETRY');}
  // Save only after inspection; assembly receives this inspected representation.
  const normalized=await doc.save({useObjectStreams:false});if(normalized.length>INPUT_LIMITS.expandedBytes)fail('BYTE_LIMIT');
  return {pageCount:pages.length,normalized};
}
export async function validateInput(bytes,mime,{isolatedComparison=false}={}) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>INPUT_LIMITS.fileBytes)fail('BYTE_LIMIT');
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  if(!['image/png','image/jpeg','application/pdf'].includes(mime))return {outcome:'linked-only',code:'UNSUPPORTED_EMBED_TYPE',sha256};
  const actual=signature(bytes,[137,80,78,71,13,10,26,10])?'image/png':signature(bytes,[255,216])?'image/jpeg':signature(bytes,[37,80,68,70,45])?'application/pdf':null;
  if(actual!==mime)fail('TYPE_MISMATCH');
  const details=mime==='image/png'?await png(bytes):mime==='image/jpeg'?jpeg(bytes):await pdf(bytes,isolatedComparison);
  return {outcome:'candidate',sha256,...details};
}
export async function validateAndAssemble(items,options={}) {
  if(!Array.isArray(items)||!items.length||items.length>INPUT_LIMITS.items)fail('ITEM_COUNT_LIMIT');
  let total=0,normalizedTotal=0,pngPixels=0;const prepared=[],results=[];
  for(const item of items){total+=item.bytes?.length??0;if(total>INPUT_LIMITS.totalBytes)fail('BYTE_LIMIT');
    const result=await validateInput(item.bytes,item.type,options);const {normalized,...safe}=result;results.push({id:item.id,...safe});
    normalizedTotal+=(normalized??item.bytes).length;if(normalizedTotal>INPUT_LIMITS.totalBytes)fail('BYTE_LIMIT');
    if(item.type==='image/png'){pngPixels+=result.width*result.height;if(pngPixels>INPUT_LIMITS.totalPngPixels)fail('TOTAL_PNG_PIXEL_LIMIT');}
    prepared.push(result.outcome==='linked-only'?{...item,type:'link',bytes:undefined,selectedPages:undefined}:{...item,bytes:normalized??item.bytes});
  }
  const packet=await assemblePacket(prepared);
  return {...packet,results:results.map(r=>({...r,outcome:r.outcome==='candidate'?'embedded':r.outcome}))};
}
