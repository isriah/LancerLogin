// Synthetic-only deployment smoke endpoint. No provider reads, credentials, or submitted files.
import { PDFDocument, rgb } from 'pdf-lib';
import { assemblePacket } from './assemble.mjs';
export default {
  async fetch(request) {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/synthetic-packet') return new Response('Not found',{status:404});
    const source=await PDFDocument.create();
    source.addPage([400,500]).drawRectangle({x:50,y:50,width:300,height:400,color:rgb(.2,.4,.7)});
    const result=await assemblePacket([{id:'synthetic-worker',revision:'r1',caption:'Synthetic rectangle. No provider access or personal data.',url:'https://example.invalid/synthetic',type:'application/pdf',bytes:await source.save(),selectedPages:[1]}]);
    return new Response(result.bytes,{headers:{'content-type':'application/pdf','cache-control':'no-store','x-packet-pages':String(result.pageCount)}});
  }
};
