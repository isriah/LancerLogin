import {PDFDocument} from 'pdf-lib';
import images from './synthetic-images.json' with {type:'json'};
import {validateAndAssemble} from './input-validation.mjs';
export const proofCases=Object.freeze(['png-v1','jpeg-v1','modern-pdf-v1','mixed-v1','recovery-v1','cpu-fault-v1','memory-fault-v1']);
export async function computeFixture(kind,enabled){
 if(!enabled||!proofCases.includes(kind))throw Error('PROOF_DISABLED');
 if(kind==='cpu-fault-v1'){for(;;){/* Only fixed synthetic proof; platform CPU termination must stop this. */}}
 if(kind==='memory-fault-v1'){const held=[];for(let i=0;i<48;i++){const b=new Uint8Array(4*1024**2);b.fill(i+1);held.push(b);}if(held.reduce((n,b)=>n+b[0]+b[b.length-1],0)>0)throw Error('FAULT_BOUNDARY_INCONCLUSIVE');}
 const decode=v=>Uint8Array.from(atob(v),c=>c.charCodeAt(0));
 const doc=await PDFDocument.create();doc.setCreationDate(new Date('2000-01-01'));doc.setModificationDate(new Date('2000-01-01'));const page=doc.addPage([500,700]);page.drawText('Fixed synthetic modern PDF');page.drawImage(await doc.embedJpg(decode(images.jpeg)),{x:30,y:30,width:300,height:200});
 const pdf=await doc.save();const entry=(id,type,bytes)=>({id,type,bytes,revision:'fixed-v1',caption:'Synthetic evidence; no personal data',url:'https://example.invalid/private',...(type==='application/pdf'?{selectedPages:[1]}:{})});
 const png=entry('png','image/png',decode(images.png)),jpeg=entry('jpeg','image/jpeg',decode(images.jpeg)),modern=entry('pdf','application/pdf',pdf);
 return validateAndAssemble(kind==='png-v1'?[png]:kind==='jpeg-v1'||kind==='recovery-v1'?[jpeg]:kind==='modern-pdf-v1'?[modern]:[png,jpeg,modern],{isolatedComparison:true});
}
