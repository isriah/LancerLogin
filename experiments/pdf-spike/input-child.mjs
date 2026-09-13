// One disposable local workerd per input. Parent owns the hard wall deadline.
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {Miniflare,Log,LogLevel,convertV4MiniflareOptions}=require(resolve(process.argv[2]));
const [fixture,mime,mode]=process.argv.slice(3);
const options={name:'input-validation-local',modules:true,compatibilityDate:'2026-09-04',
  log:new Log(LogLevel.NONE),telemetry:{enabled:false},
  outboundService:()=>new Response(null,{status:403}),
  ...(mode==='hang'?{script:'export default {fetch(){while(true){} }}'}:{scriptPath:resolve('dist/input-worker.mjs')})};
const mf=new Miniflare(convertV4MiniflareOptions(options));
try{await mf.ready;process.send?.({ready:true});
  const response=await mf.dispatchFetch(`https://example.invalid/${mode}`,{method:'POST',headers:{'content-type':mime},body:await readFile(fixture)});
  process.send?.({result:await response.json()});
}catch{process.send?.({result:{outcome:'runtime-failure',productionEligible:false}});}
finally{await mf.dispose();}
