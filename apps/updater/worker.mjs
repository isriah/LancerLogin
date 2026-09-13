import { WorkerEntrypoint } from 'cloudflare:workers';
import { routeUpdater } from './worker-router.mjs';
export default {fetch(request,env){return routeUpdater(env,'public',request);}};
// Bind the application API to these named entrypoints, never to public fetch.
export class ApplicationUpdates extends WorkerEntrypoint {
  fetch(request){return routeUpdater(this.env,'application',request);}
}
export class MaintenanceLifecycle extends WorkerEntrypoint {
  fetch(request){return routeUpdater(this.env,'maintenance',request);}
}
