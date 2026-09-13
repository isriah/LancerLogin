import { PDFDocument, StandardFonts, PDFName, PDFString, rgb } from 'pdf-lib';

// Proposed conservative spike limits, not production service guarantees.
export const LIMITS = Object.freeze({ items: 20, fileBytes: 4 * 1024 ** 2, totalBytes: 12 * 1024 ** 2,
  sourcePages: 40, evidencePages: 40, imagePixels: 4_000_000, totalPngPixels: 4_000_000, outputBytes: 16 * 1024 ** 2 });
export class PreflightError extends Error {
  constructor(code, itemId = null) { super(`${code}${itemId ? `: ${itemId}` : ''}`); this.code = code; this.itemId = itemId; }
}
const fail = (code, id) => { throw new PreflightError(code, id); };
const ascii = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]*$/.test(value);
function safeLink(value, id) {
  try { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password || value.length > 1000) throw 0; }
  catch { fail('HTTPS_LINK_REQUIRED', id); }
}
// Provider adapter must authenticate, authorize revision/installation, and choose the URL.
// This routine accepts bytes/streams only; it never fetches user-supplied links.
export async function readBoundedStream(stream, max = LIMITS.fileBytes) {
  const reader = stream.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > max) { await reader.cancel(); fail('FILE_BYTES_LIMIT'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
}
function imageSize(bytes, type, id) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 'image/png') {
    if (bytes.length < 24 || [137,80,78,71,13,10,26,10].some((b,i) => bytes[i] !== b) || v.getUint32(12) !== 0x49484452) fail('CORRUPT_IMAGE', id);
    return [v.getUint32(16), v.getUint32(20)];
  }
  if (bytes[0] !== 255 || bytes[1] !== 216) fail('CORRUPT_IMAGE', id);
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos++] !== 255) fail('CORRUPT_IMAGE', id);
    while (bytes[pos] === 255) pos++;
    const marker = bytes[pos++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = v.getUint16(pos);
    if (length < 2 || pos + length > bytes.length) fail('CORRUPT_IMAGE', id);
    if ([0xc0,0xc1,0xc2].includes(marker) && length >= 8) return [v.getUint16(pos+5), v.getUint16(pos+3)];
    pos += length;
  }
  fail('UNSUPPORTED_JPEG_ENCODING', id);
}
export async function assemblePacket(items) {
  if (!Array.isArray(items) || !items.length || items.length > LIMITS.items) fail('ITEM_COUNT_LIMIT');
  const ids = new Set(); let total = 0, pages = 0, pngPixels = 0;
  const prepared = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') fail('INVALID_METADATA');
    const { id, revision, caption, type, bytes, selectedPages, url } = item;
    if (!ascii(id,32) || !id || ids.has(id)) fail('INVALID_OR_DUPLICATE_ID'); ids.add(id);
    if (!ascii(revision,24) || !revision || !ascii(caption,180)) fail('INVALID_METADATA',id);
    safeLink(url,id);
    if (type === 'link') { if (bytes !== undefined || selectedPages !== undefined) fail('INVALID_LINK_SELECTION',id); prepared.push(item); continue; }
    if (!['image/png','image/jpeg','application/pdf'].includes(type)) fail('UNSUPPORTED_TYPE_USE_LINK',id);
    if (!(bytes instanceof Uint8Array) || !bytes.length) fail('MISSING_BYTES',id);
    total += bytes.length;
    if (bytes.length > LIMITS.fileBytes || total > LIMITS.totalBytes) fail('INPUT_BYTES_LIMIT',id);
    if (type === 'application/pdf') {
      let source, sourcePageCount;
      // Inspect encryption metadata only; never embed or attempt to decrypt encrypted sources.
      try { source = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: true, updateMetadata: false }); }
      catch { fail('CORRUPT_PDF_REEXPORT',id); }
      if (source.isEncrypted) fail('ENCRYPTED_PDF_REEXPORT',id);
      try { sourcePageCount=source.getPageCount(); } catch { fail('CORRUPT_PDF_REEXPORT',id); }
      if (sourcePageCount > LIMITS.sourcePages) fail('SOURCE_PAGE_LIMIT',id);
      if (!Array.isArray(selectedPages) || !selectedPages.length || new Set(selectedPages).size !== selectedPages.length || selectedPages.some(p => !Number.isInteger(p) || p < 1 || p > source.getPageCount())) fail('INVALID_PAGE_SELECTION',id);
      pages += selectedPages.length; prepared.push({ ...item, source });
    } else {
      if (selectedPages !== undefined) fail('INVALID_PAGE_SELECTION',id);
      const [width,height] = imageSize(bytes,type,id);
      if (!width || !height || width * height > LIMITS.imagePixels) fail('IMAGE_PIXEL_LIMIT',id);
      if (type === 'image/png') { pngPixels += width * height; if (pngPixels > LIMITS.totalPngPixels) fail('TOTAL_PNG_PIXEL_LIMIT',id); }
      pages++; prepared.push(item);
    }
    if (pages > LIMITS.evidencePages) fail('EVIDENCE_PAGE_LIMIT',id);
  }
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setCreationDate(new Date('2000-01-01T00:00:00Z')); doc.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  const text = (page,value,x,y,size=11) => page.drawText(value,{ x,y,size,font,color:rgb(.1,.15,.23) });
  const wrap = value => {
    const lines=[]; let line='';
    for (const character of value) {
      if (font.widthOfTextAtSize(line+character,10)>528) { lines.push(line); line=''; }
      line+=character;
    }
    lines.push(line); return lines;
  };
  const indexCount = Math.ceil(items.length / 5);
  const index = Array.from({length:indexCount},(_,i) => { const p=doc.addPage([612,792]); text(p,'Synthetic evidence index',42,746,21); text(p,`Index ${i+1} of ${indexCount} | fixed selection snapshot`,42,724,10); return p; });
  const manifest = [];
  for (let n=0;n<prepared.length;n++) {
    const item=prepared[n], page=index[Math.floor(n/5)], y=678-(n%5)*124;
    const firstPage=item.type === 'link' ? null : doc.getPageCount()+1;
    text(page,`${n+1}. ${item.id} | revision ${item.revision}`,42,y,12);
    wrap(item.caption).forEach((line,i)=>text(page,line,42,y-20-i*15,10));
    text(page,item.type === 'link' ? 'Linked evidence (not embedded)' : `Attached from packet page ${firstPage}`,42,y-70,10);
    text(page,'Open selected source',42,y-88,10);
    page.node.addAnnot(doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[42,y-91,160,y-76],Border:[0,0,0],A:{Type:'Action',S:PDFName.of('URI'),URI:PDFString.of(item.url)}})));
    manifest.push({number:n+1,id:item.id,revision:item.revision,caption:item.caption,type:item.type,url:item.url,selectedPages:item.selectedPages ?? [],firstPage});
    if(item.type === 'link') continue;
    let embeds;
    try { embeds=item.source ? await doc.embedPdf(item.source,item.selectedPages.map(p=>p-1)) : [await (item.type==='image/png'?doc.embedPng(item.bytes):doc.embedJpg(item.bytes))]; }
    catch { fail('EVIDENCE_EMBED_FAILED_REEXPORT',item.id); }
    for(let j=0;j<embeds.length;j++) {
      const p=doc.addPage([612,792]), e=embeds[j];
      text(p,`Evidence ${n+1} | ${item.id}${item.source ? ` | source page ${item.selectedPages[j]}` : ''}`,42,750,13);
      wrap(item.caption).forEach((line,i)=>text(p,line,42,727-i*14,10));
      const scale=Math.min(528/e.width,600/e.height);
      const options={x:42+(528-e.width*scale)/2,y:65+(600-e.height*scale)/2,width:e.width*scale,height:e.height*scale};
      if(item.source) p.drawPage(e,options); else p.drawImage(e,options);
    }
  }
  for(const [i,p] of doc.getPages().entries()) text(p,`Synthetic feasibility fixture | Packet page ${i+1} of ${doc.getPageCount()}`,42,28,9);
  let bytes;
  try { bytes=await doc.save(); } catch { fail('PACKET_SERIALIZATION_FAILED'); }
  if(bytes.length > LIMITS.outputBytes) fail('OUTPUT_BYTES_LIMIT');
  return {bytes,manifest,pageCount:doc.getPageCount(),inputBytes:total};
}
