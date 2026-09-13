// LOCAL EXPERIMENT ONLY. No auth runtime imports, provider bindings, deployment configuration or fetches.
import {boundedRead,validateAndAssemble,InputError} from './input-validation.mjs';
export default {async fetch(request){
  const mode=new URL(request.url).pathname;
  if(request.method!=='POST'||!['/strict','/isolated-comparison'].includes(mode))return new Response(null,{status:404});
  try {
    const bytes=await boundedRead(request.body), type=request.headers.get('content-type');
    const pages=(request.headers.get('x-pages')??'1').split(',').map(Number);
    const start=Date.now();
    const packet=await validateAndAssemble([{id:'local-fixture',revision:'r1',caption:'Synthetic local validation fixture',
      url:'https://example.invalid/private-evidence',type,bytes,...(type==='application/pdf'?{selectedPages:pages}:{})}],{isolatedComparison:mode==='/isolated-comparison'});
    return Response.json({outcome:packet.results[0].outcome,sha256:packet.results[0].sha256,pageCount:packet.pageCount,
      outputBytes:packet.bytes.length,elapsedMs:Date.now()-start,profile:mode.slice(1),productionEligible:false});
  }catch(e){return Response.json({outcome:'rejected',code:e instanceof InputError?e.code:
    typeof e?.code==='string'&&/^[A-Z_]+$/.test(e.code)?e.code:'PARSER_OR_EMBED_FAILURE',productionEligible:false},{status:422});}
}};
