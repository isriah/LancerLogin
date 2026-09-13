const encoder = new TextEncoder();
export const UPDATER_AUDIENCE = 'lancerlogin-updater-v1';
export const UPDATER_RESTORE_CONFIRMATION = 'RESTORE APPLICATION DATABASE';
const check = (ok: unknown) => { if (!ok) throw new Error('updater-request'); };
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const identifier = (value: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const hex = (bytes: Uint8Array) => [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
async function key(secret: string) {
  check(/^[a-f0-9]{64}$/.test(secret));
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g)!, value => parseInt(value, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function boundedUpdaterBytes(body: Request | Response, limit = 4096): Promise<Uint8Array<ArrayBuffer>> {
  const length = body.headers.get('content-length'); check(length === null || (/^[0-9]+$/.test(length) && Number(length) <= limit));
  if (!body.body) return new Uint8Array();
  const reader = body.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; check(size + value.length <= limit); size += value.length; chunks.push(value); } }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; } return bytes;
}
export function updaterAction(action: string, input: unknown): Record<string, unknown> {
  check(input && typeof input === 'object' && !Array.isArray(input));
  const body = input as Record<string, unknown>;
  const fields: Record<string, string[]> = { status: [], check: [], start: ['requestId', 'releaseId'], 'control-grant': ['requestId', 'releaseId'], advance: ['jobId'], 'retry-preparation': ['jobId', 'failedOperationId'], recovery: ['requestId', 'failedJobId', 'mode', 'confirmation'] };
  check(Object.hasOwn(fields, action) && Object.keys(body).length === fields[action].length && fields[action].every(field => Object.hasOwn(body, field)));
  for (const field of ['requestId', 'jobId', 'failedJobId', 'failedOperationId']) if (Object.hasOwn(body, field)) check(uuid(body[field]));
  if (action === 'start' || action === 'control-grant') check(Number.isSafeInteger(body.releaseId) && Number(body.releaseId) > 0);
  if (action === 'recovery') check((body.mode === 'code-recovery' && body.confirmation === 'RECOVER APPLICATION CODE') || (body.mode === 'restore' && body.confirmation === UPDATER_RESTORE_CONFIRMATION));
  return body;
}
async function message(method: string, path: string, headers: Headers, bytes: Uint8Array<ArrayBuffer>) {
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  return encoder.encode(['LancerLogin updater request v1', method, path, ...['installation', 'audience', 'timestamp', 'nonce', 'actor'].map(name => headers.get(`x-ll-${name}`)), digest].join('\n'));
}
export async function signedUpdaterRequest({ secret, installationId, actorId, action, body = {}, now = Date.now(), nonce = crypto.randomUUID() }: { secret: string; installationId: string; actorId: string; action: string; body?: unknown; now?: number; nonce?: string }) {
  check(identifier(installationId) && identifier(actorId) && uuid(nonce)); updaterAction(action, body);
  const method = action === 'status' ? 'GET' : 'POST', path = `/v1/${action}`;
  const bytes = method === 'GET' ? new Uint8Array() : encoder.encode(JSON.stringify(body)); check(bytes.length <= 4096);
  const headers = new Headers({ 'content-type': 'application/json', 'x-ll-installation': installationId, 'x-ll-audience': UPDATER_AUDIENCE, 'x-ll-timestamp': String(Math.floor(now / 1000)), 'x-ll-nonce': nonce, 'x-ll-actor': actorId });
  headers.set('x-ll-signature', hex(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), await message(method, path, headers, bytes)))));
  return new Request(`https://updater.internal${path}`, { method, headers, body: method === 'POST' ? bytes : undefined });
}
export async function verifyUpdaterRequest(request: Request, secret: string, installationId: string, now = Date.now()) {
  const url = new URL(request.url), action = url.pathname.slice('/v1/'.length), headers = request.headers;
  check(url.pathname.startsWith('/v1/') && !url.search && (action === 'status' ? request.method === 'GET' : request.method === 'POST'));
  check(headers.get('x-ll-installation') === installationId && headers.get('x-ll-audience') === UPDATER_AUDIENCE && identifier(headers.get('x-ll-actor') ?? '') && uuid(headers.get('x-ll-nonce')));
  const timestamp = headers.get('x-ll-timestamp') ?? '', signature = headers.get('x-ll-signature') ?? '';
  check(/^[0-9]{1,12}$/.test(timestamp) && Math.abs(Math.floor(now / 1000) - Number(timestamp)) <= 60 && /^[a-f0-9]{64}$/.test(signature));
  const bytes = await boundedUpdaterBytes(request);
  check(await crypto.subtle.verify('HMAC', await key(secret), Uint8Array.from(signature.match(/../g)!, value => parseInt(value, 16)), await message(request.method, url.pathname, headers, bytes)));
  const body = updaterAction(action, bytes.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : {});
  return { action, body, actorId: headers.get('x-ll-actor')!, nonce: headers.get('x-ll-nonce')!, expiresAt: Number(timestamp) + 120 };
}
