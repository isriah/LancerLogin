import { createUpdaterReleaseVerifier } from '../../../packages/shared/src/updater/updater-release.mjs';
const check = (ok, code) => { if (!ok) throw Error(code); };
const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const exact = (value, keys) => check(value && Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'updater-code-pins');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const order = bindings => [...bindings].sort((a, b) => a.name.localeCompare(b.name));
const configurationKeys = ['compatibility_date','compatibility_flags','usage_model','logpush','tail_consumers','observability','placement','limits','tags'];

// Intentionally distinct from application transport. No URLs, resources or bindings
// come from either release bytes or action requests. The executor owns dispatch fencing.
export function createUpdaterCodeTransport({ pins: supplied, trust, token, fetch: fetcher = globalThis.fetch }) {
  const pins = structuredClone(supplied), verifier = createUpdaterReleaseVerifier(trust);
  exact(pins, ['installationId','accountId','worker','updaterDatabaseId','workerSettings','nonsecretBindings','secretBindings']);
  check(/^[A-Za-z0-9_-]{1,80}$/.test(pins.installationId) && /^[a-f0-9]{32}$/.test(pins.accountId) && /^[a-z0-9][a-z0-9-]{0,62}$/.test(pins.worker) && uuid(pins.updaterDatabaseId), 'updater-code-pins');
  check(typeof token === 'string' && token.length >= 16 && typeof fetcher === 'function', 'updater-code-credentials');
  check(pins.workerSettings && Object.keys(pins.workerSettings).every(k => configurationKeys.includes(k)) && Array.isArray(pins.nonsecretBindings) && Array.isArray(pins.secretBindings), 'updater-code-pins');
  check(pins.nonsecretBindings.some(b => b.type === 'd1' && b.id === pins.updaterDatabaseId) && pins.nonsecretBindings.every(b => b.name && !['secret_text','secret_key'].includes(b.type)), 'updater-code-bindings');
  for (const b of pins.secretBindings) { exact(b, ['name','type']); check(b.name && ['secret_text','secret_key'].includes(b.type), 'updater-code-bindings'); }
  const allBindings = [...pins.nonsecretBindings,...pins.secretBindings]; check(new Set(allBindings.map(b => b.name)).size === allBindings.length, 'updater-code-bindings');
  const path = `/accounts/${pins.accountId}/workers/scripts/${pins.worker}`;
  async function request(suffix, { method = 'GET', body, binary = false } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetcher('https://api.cloudflare.com/client/v4' + path + suffix, { method, body, headers: { Authorization: 'Bearer ' + token }, redirect: 'manual', signal: controller.signal });
      check(response.ok && !response.redirected, 'updater-provider-unconfirmed');
      const reader = response.body?.getReader(); check(reader, 'updater-provider-body'); const chunks = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; check(size <= (binary ? 17825792 : 1048576), 'updater-provider-size'); chunks.push(next.value); } }
      finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      if (binary) return new Response(bytes, { headers: response.headers });
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); check(result.success === true && Object.hasOwn(result, 'result'), 'updater-provider-response'); return result.result;
    } finally { clearTimeout(timer); }
  }
  async function release(record) { return verifier.verify(record.manifestBytes, record.signatureBytes); }
  async function inspect(record) {
    const verified = await release(record), settings = await request('/settings');
    check(Array.isArray(settings.bindings), 'updater-settings');
    check(canonical(order(settings.bindings.filter(b => !['secret_text','secret_key'].includes(b.type)))) === canonical(order(pins.nonsecretBindings)), 'updater-binding-drift');
    check(canonical(order(settings.bindings.filter(b => ['secret_text','secret_key'].includes(b.type)).map(({name,type}) => ({name,type})))) === canonical(order(pins.secretBindings)), 'updater-secret-drift');
    for (const key of configurationKeys) check(Object.hasOwn(settings,key) === Object.hasOwn(pins.workerSettings,key) && canonical(settings[key]) === canonical(pins.workerSettings[key]), 'updater-setting-drift');
    const deployments = await request('/deployments'), active = deployments.deployments?.[0];
    check(active?.versions?.length === 1 && active.versions[0].percentage === 100 && uuid(active.versions[0].version_id) && typeof active.id === 'string', 'updater-active-version');
    const version = await request('/versions/' + active.versions[0].version_id); check(version.id === active.versions[0].version_id, 'updater-active-version');
    const response = await request('/content/v2', { binary: true }); let bytes;
    if (response.headers.get('content-type')?.startsWith('multipart/')) {
      const parts = [...(await response.formData()).entries()]; check(parts.length === 1 && parts[0][0] === 'updater.mjs' && parts[0][1] instanceof Blob, 'updater-modules'); bytes = new Uint8Array(await parts[0][1].arrayBuffer());
    } else bytes = new Uint8Array(await response.arrayBuffer());
    await verifier.verifyArtifact(verified, bytes);
    // A stable second read prevents combining code and deployment identities across drift.
    const again = await request('/deployments'); check(canonical(again.deployments?.[0]) === canonical(active), 'updater-deployment-drift');
    return { manifestSha256: verified.manifestSha256, versionId: version.id, deploymentId: active.id, annotation: version.annotations?.['workers/message'] ?? null, configuration: structuredClone(pins) };
  }
  const marker = (operationId, digest) => `LancerLogin updater self ${operationId} ${digest}`;
  return Object.freeze({
    identity: structuredClone(pins),
    inspect,
    async dispatch({ record, bytes, operationId, assertAuthority }) {
      check(uuid(operationId) && typeof assertAuthority === 'function', 'updater-dispatch-authority');
      const verified = await release(record), original = await verifier.verifyArtifact(verified, bytes);
      const form = new FormData(); form.set('metadata', JSON.stringify({ ...pins.workerSettings, main_module:'updater.mjs', bindings:pins.nonsecretBindings, keep_bindings:['secret_text','secret_key'], keep_assets:true, annotations:{'workers/message':marker(operationId,verified.manifestSha256)} })); form.set('updater.mjs', new Blob([original],{type:'application/javascript+module'}),'updater.mjs');
      await assertAuthority();
      try { await request('', {method:'PUT',body:form}); } catch { return {outcome:'unknown'}; }
      return {outcome:'pending'};
    },
    async reconcile({record,operationId}) {
      const verified = await release(record);
      try {
        const versions = await request('/versions?page=1&per_page=100'); check(Array.isArray(versions.items),'updater-versions');
        const matches = versions.items.filter(v => v.annotations?.['workers/message'] === marker(operationId,verified.manifestSha256));
        if(matches.length!==1)return {outcome:'unknown'};
        const receipt=await inspect(record); if(receipt.versionId!==matches[0].id||receipt.annotation!==marker(operationId,verified.manifestSha256))return {outcome:'unknown'};
        return {outcome:'applied',receipt};
      } catch {return {outcome:'unknown'};}
    },
  });
}
