import { PDFDocument, rgb } from 'pdf-lib';
import { assemblePacket } from './assemble.mjs';
import images from './synthetic-images.json' with { type: 'json' };
const decode=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const entry=(id,extra)=>({id,revision:'fixed-r1',caption:'Fixed synthetic evidence. No uploads, provider access or personal data.',url:'https://example.invalid/synthetic',...extra});
export async function buildFixedPacket(kind) {
  const source=await PDFDocument.create(); source.setCreationDate(new Date('2000-01-01T00:00:00Z')); source.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  for(let i=0;i<3;i++) source.addPage([400,500]).drawRectangle({x:50,y:50,width:300,height:400,color:rgb(.2,.2+i*.2,.7)});
  const pdf=await source.save();
  const png=()=>({type:'image/png',bytes:decode(images.png)}), jpeg=()=>({type:'image/jpeg',bytes:decode(images.jpeg)});
  let items;
  if(kind==='vector') items=Array.from({length:13},(_,i)=>entry(`vector-${i}`,{type:'application/pdf',bytes:pdf,selectedPages:[3,1,2]}));
  else if(kind==='png') items=Array.from({length:4},(_,i)=>entry(`png-${i}`,png()));
  else if(kind==='jpeg') items=Array.from({length:6},(_,i)=>entry(`jpeg-${i}`,jpeg()));
  else if(kind==='mixed') items=[entry('png',png()),entry('jpeg',jpeg()),entry('pdf',{type:'application/pdf',bytes:pdf,selectedPages:[3,1]}),entry('link',{type:'link'})];
  else throw new Error('INVALID_FIXED_FIXTURE');
  return assemblePacket(items);
}
