import { signedUpdaterRequest, boundedUpdaterBytes, updaterAction } from '../../../packages/shared/src/updater/service-auth.ts';
import { HttpError } from './http-error.ts';
export type UpdaterBinding = { fetch(request: Request): Promise<Response> };
type UpdaterEnv = { UPDATER?: UpdaterBinding; UPDATER_APP_KEY?: string; UPDATER_INSTALLATION_ID?: string; RELEASE_VERSION?: string };
export const updaterConfigured = (env: UpdaterEnv) => Boolean(env.UPDATER && env.UPDATER_APP_KEY && env.UPDATER_INSTALLATION_ID);
export async function updaterRoute(request: Request, env: UpdaterEnv, actor: { userId: string }) {
  const action = new URL(request.url).pathname.slice('/admin/updater/'.length);
  if (action === 'status' ? request.method !== 'GET' : request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!updaterConfigured(env)) {
    if (action !== 'status') throw new HttpError(503, 'The independent updater is not configured.');
    return Response.json({ configured: false, installedVersion: env.RELEASE_VERSION ?? 'development', job: null, recoveryAvailable: false, availability: { status: 'unconfigured', checked: 0, total: 0, checkedAt: 0 } });
  }
  let body;
  try { const bytes = await boundedUpdaterBytes(request); body = updaterAction(action, bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {}); }
  catch { throw new HttpError(400, 'Invalid updater action.'); }
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const signed = await signedUpdaterRequest({ secret: env.UPDATER_APP_KEY!, installationId: env.UPDATER_INSTALLATION_ID!, actorId: actor.userId, action, body });
    const result = await Promise.race([env.UPDATER!.fetch(new Request(signed, { signal: controller.signal })).then(async response => ({ response, bytes: await boundedUpdaterBytes(response, 16384) })), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 35000); })]);
    const value = JSON.parse(new TextDecoder().decode(result.bytes));
    if (!result.response.ok) throw new HttpError(result.response.status === 503 ? 503 : 409, 'The updater could not complete this action. Refresh its status before retrying.');
    return Response.json(value, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'Updater response unavailable. Refresh status to check whether the request was accepted.'); }
  finally { clearTimeout(timer); controller.abort(); }
}
