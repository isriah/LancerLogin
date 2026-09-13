import {readFile,writeFile} from 'node:fs/promises';
import {assemblePacket} from './assemble.mjs';
const png=new Uint8Array(await readFile(new URL('output/geometry.png',import.meta.url)));
const jpeg=new Uint8Array(await readFile(new URL('output/noise.jpeg',import.meta.url)));
const pdf=new Uint8Array(await readFile(new URL('output/source.pdf',import.meta.url)));
const measurements=[];
for(const [name,count,type,bytes,selectedPages] of [['png-4',4,'image/png',png],['jpeg-noise-6',6,'image/jpeg',jpeg],['pdf-39-pages',13,'application/pdf',pdf,[1,2,3]]]) {
  const items=Array.from({length:count},(_,i)=>({id:`synthetic-${i}`,revision:'r1',caption:`Synthetic benchmark ${i+1}`,url:'https://example.invalid/evidence',type,bytes:new Uint8Array(bytes),...(selectedPages?{selectedPages}:{})}));
  const before=process.memoryUsage(),start=performance.now(),cpu=process.cpuUsage();
  const result=await assemblePacket(items);
  const usage=process.cpuUsage(cpu),after=process.memoryUsage();
  measurements.push({name,node:process.version,inputBytes:result.inputBytes,outputBytes:result.bytes.length,pages:result.pageCount,wallMs:Math.round(performance.now()-start),cpuMs:Math.round((usage.user+usage.system)/1000),before,after,processLifetimeMaxRSSKiB:process.resourceUsage().maxRSS});
}
await writeFile(new URL('output/measurements.json',import.meta.url),JSON.stringify(measurements,null,2));
console.log(JSON.stringify(measurements,null,2));
