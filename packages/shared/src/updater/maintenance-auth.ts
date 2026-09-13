import { boundedUpdaterBytes } from './service-auth.ts';
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const check = (ok: unknown) => { if (!ok) throw Error('maintenance-request'); };
const fields: Record<string, string[]> = { admit: ['permitId','proof'], release: ['permitId','epoch','proof'], ambiguity: ['permitId','epoch','proof','operationId','kind'], operation: ['permitId','epoch','proof','operationId'] };
export function maintenanceBody(action: string, input: unknown): Record<string, unknown> {
  check(Object.hasOwn(fields, action) && input && typeof input === 'object' && !Array.isArray(input));
  const body = input as Record<string, unknown>;
  check(Object.keys(body).length === fields[action].length && fields[action].every(key => Object.hasOwn(body,key)));
  for (const name of ['permitId','operationId','kind']) if (name in body) check(typeof body[name] === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(body[name] as string));
  check(typeof body.proof === 'string' && /^[a-f0-9]{64}$/.test(body.proof));
  if ('epoch' in body) check(Number.isSafeInteger(body.epoch) && Number(body.epoch) >= 0);
  return body;
}
async function key(secret: string) {
  check(/^[a-f0-9]{64}$/.test(secret));
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g)!, byte => parseInt(byte,16)), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
}
const message = (path: string, installation: string, timestamp: string, bytes: Uint8Array) => encoder.encode(['LancerLogin private maintenance v1','POST',path,installation,timestamp,new TextDecoder().decode(bytes)].join('\n'));
export async function signMaintenanceRequest(secret: string, installationId: string, action: string, body: unknown, now = Date.now()) {
  check(/^[A-Za-z0-9_-]{1,80}$/.test(installationId)); maintenanceBody(action,body);
  const bytes = encoder.encode(JSON.stringify(body)), path = `/private/maintenance/${action}`, timestamp = String(Math.floor(now/1000));
  check(bytes.length <= 2048);
  const signature = hex(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), message(path,installationId,timestamp,bytes))));
  return new Request(`https://maintenance.internal${path}`, {method:'POST',redirect:'manual',headers:{'content-type':'application/json','x-ll-installation':installationId,'x-ll-time':timestamp,'x-ll-maintenance-signature':signature},body:bytes});
}
export async function verifyMaintenanceRequest(request: Request, secret: string, installationId: string, now = Date.now()) {
  const url = new URL(request.url), action = url.pathname.slice('/private/maintenance/'.length);
  check(url.origin === 'https://maintenance.internal' && request.method === 'POST' && !url.search && !url.hash && url.pathname === `/private/maintenance/${action}` && Object.hasOwn(fields,action));
  const timestamp = request.headers.get('x-ll-time') ?? '', signature = request.headers.get('x-ll-maintenance-signature') ?? '';
  check(request.headers.get('x-ll-installation') === installationId && /^\d{1,12}$/.test(timestamp) && Math.abs(Math.floor(now/1000)-Number(timestamp))<=60 && /^[a-f0-9]{64}$/.test(signature));
  const bytes = await boundedUpdaterBytes(request,2048);
  check(await crypto.subtle.verify('HMAC',await key(secret),Uint8Array.from(signature.match(/../g)!,byte=>parseInt(byte,16)),message(url.pathname,installationId,timestamp,bytes)));
  return {action,body:maintenanceBody(action,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))};
}
