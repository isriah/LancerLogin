import {authorized} from './pdf-job.mjs';
export {PdfSpikeJob} from './pdf-job.mjs';
export default {
  async fetch(request,env) {
    if(!await authorized(request,env)) return Response.json({error:'UNAUTHORIZED'},{status:401,headers:{'cache-control':'no-store'}});
    if(new URL(request.url).search || !/^\/jobs\/(vector|png|jpeg|mixed)-[123](\/result)?$/.test(new URL(request.url).pathname)) return new Response('Not found',{status:404});
    // One fixed object bounds namespace growth and permits one job at a time.
    const id=env.PDF_SPIKE_JOBS.idFromName('fixed-synthetic-suite-v1');
    return env.PDF_SPIKE_JOBS.get(id).fetch(request);
  }
};
