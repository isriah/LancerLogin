import { verifyMaintenanceRequest } from '../../packages/shared/src/updater/maintenance-auth.ts';
// Private binding only; no operator routes, diagnostic proof readback, or force clear.
export function createMaintenanceService({ core, capability, installationId, appSecret, now = () => Date.now() }) {
  return Object.freeze({ async fetch(request) {
    try {
      const { action, body } = await verifyMaintenanceRequest(request, appSecret, installationId, now());
      const result = action === 'admit' ? await core.admitWithProof(capability, body) : await core.withProof(capability, {permitId:body.permitId,epoch:body.epoch,proof:body.proof}, action, body.operationId, body.kind);
      return Response.json(result, {headers:{'cache-control':'no-store'}});
    } catch { return Response.json({error:'maintenance-unavailable'}, {status:503,headers:{'cache-control':'no-store'}}); }
  } });
}
