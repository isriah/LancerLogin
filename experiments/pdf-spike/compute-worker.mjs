export {DocumentComputeQueue} from './compute-runtime.mjs';
import {singleton} from './compute-runtime.mjs';
export default {fetch(request,env){
 if(!env.DOCUMENT_COMPUTE_QUEUE)return new Response(null,{status:503});
 return env.DOCUMENT_COMPUTE_QUEUE.get(env.DOCUMENT_COMPUTE_QUEUE.idFromName(singleton)).fetch(request);
}};
