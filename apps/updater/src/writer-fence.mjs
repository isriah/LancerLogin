import { sha256 } from '../../../packages/shared/src/updater/application-release.mjs';

const check = (value, code = 'writer-fence-identity') => { if (!value) throw Error(code); };
const exact = (value, keys) => check(value && Object.keys(value).sort().join(',') === [...keys].sort().join(','));
const canonical = value => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const same = (a, b) => canonical(a) === canonical(b);
const hash = value => sha256(new TextEncoder().encode(canonical(value)));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const entryPoints = ['http', 'scheduled', 'scheduler-fetch', 'scheduler-alarm'];
const settingKeys = ['compatibility_date','compatibility_flags','usage_model','logpush','tail_consumers','observability','placement','limits','tags'];
const order = bindings => [...bindings].sort((a, b) => a.name.localeCompare(b.name));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

/** Positive code/configuration evidence, conditional on independently established adoption and writer ownership. */
export function createWriterFence({ pins: input, adoption: inputAdoption, coverage: inputCoverage, token, verifier, store, withAuthority, fetch: fetcher = globalThis.fetch }) {
  const pins = structuredClone(input), adoption = structuredClone(inputAdoption), coverage = structuredClone(inputCoverage);
  exact(pins, ['installationId','applicationDatabaseId','accountId','worker','maintenanceService','workerSettings','nonsecretBindings','secretBindings']);
  check(/^[A-Za-z0-9_-]{1,80}$/.test(pins.installationId) && /^[a-f0-9]{32}$/.test(pins.accountId) && uuid(pins.applicationDatabaseId));
  check([pins.worker,pins.maintenanceService].every(value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)));
  exact(adoption, ['recordSha256','installationId','applicationDatabaseId','accountId','worker','maintenanceService','contract']);
  check(hex(adoption.recordSha256) && adoption.contract === 'exclusive-writers-fenced-adoption-v1');
  for (const key of ['installationId','applicationDatabaseId','accountId','worker','maintenanceService']) check(adoption[key] === pins[key], 'writer-fence-adoption');
  check(Array.isArray(coverage) && coverage.length > 0 && coverage.length <= 128);
  for (const item of coverage) { exact(item, ['apiSha256','protocol','entryPoints']); check(hex(item.apiSha256) && item.protocol === 'maintenance-v1' && same([...item.entryPoints].sort(), [...entryPoints].sort()), 'writer-fence-coverage'); }
  check(new Set(coverage.map(item => item.apiSha256)).size === coverage.length);
  check(Object.keys(pins.workerSettings).every(key => settingKeys.includes(key)) && typeof pins.workerSettings.compatibility_date === 'string');
  check(Array.isArray(pins.nonsecretBindings) && pins.nonsecretBindings.length <= 64 && Array.isArray(pins.secretBindings) && pins.secretBindings.length <= 64);
  check(new Set([...pins.nonsecretBindings,...pins.secretBindings].map(item => item.name)).size === pins.nonsecretBindings.length + pins.secretBindings.length);
  check(pins.nonsecretBindings.every(item => !['secret_text','secret_key'].includes(item.type)) && pins.secretBindings.every(item => { exact(item, ['name','type']); return ['secret_text','secret_key'].includes(item.type); }));
  const binding = name => pins.nonsecretBindings.find(item => item.name === name);
  check(binding('DB')?.type === 'd1' && binding('DB').id === pins.applicationDatabaseId);
  check(binding('MAINTENANCE')?.type === 'service' && binding('MAINTENANCE').service === pins.maintenanceService);
  check(binding('MAINTENANCE_INSTALLATION_ID')?.type === 'plain_text' && binding('MAINTENANCE_INSTALLATION_ID').text === pins.installationId);
  check(binding('RELEASE_VERSION')?.type === 'plain_text' && pins.secretBindings.some(item => item.name === 'MAINTENANCE_APP_KEY' && item.type === 'secret_text'));
  check(typeof token === 'string' && token.length >= 16 && typeof withAuthority === 'function');
  const base = `https://api.cloudflare.com/client/v4/accounts/${pins.accountId}/workers/scripts/${pins.worker}`;

  async function inspect(expected, authority, mode) {
    const current = await verifier.verify(authority.currentRelease.manifestBytes, authority.currentRelease.signatureBytes);
    const prior = await verifier.verify(authority.priorRelease.manifestBytes, authority.priorRelease.signatureBytes);
    const api = release => release.manifest.artifacts.find(item => item.role === 'api');
    for (const release of [current,prior]) check(coverage.some(item => item.apiSha256 === api(release).sha256), 'writer-fence-coverage');
    const { holdId, ...tuple } = expected;
    const identity = { ...tuple, accountId:pins.accountId, worker:pins.worker, manifestSha256:current.manifestSha256, priorManifestSha256:prior.manifestSha256, adoptionSha256:adoption.recordSha256, coverageSha256:await hash(coverage) };
    if (mode === 'prior') { const descriptor = api(prior); await verifier.verifyArtifact(prior, descriptor.name, await store.read(`${prior.manifestSha256}:${descriptor.name}`)); return identity; }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    async function bytes(path, maximum = 262144) {
      const response = await fetcher(base + path, { method: 'GET', redirect: 'manual', cache: 'no-store', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' } });
      check(response.ok && response.body, 'writer-fence-provider');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > maximum) { await reader.cancel(); throw Error('writer-fence-size'); } chunks.push(item.value); }
      const result = new Uint8Array(size); let at = 0; for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; } return { bytes: result, headers: response.headers };
    }
    async function json(path) { const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await bytes(path)).bytes)); check(result.success === true && result.result, 'writer-fence-provider'); return result.result; }
    try {
      const deployments = await json('/deployments'), deployment = deployments.deployments?.[0];
      check(typeof deployment?.id === 'string' && deployment.id.length <= 128 && deployment.versions?.length === 1 && deployment.versions[0].percentage === 100 && uuid(deployment.versions[0].version_id), 'writer-fence-deployment');
      const versionId = deployment.versions[0].version_id;
      if (mode === 'proof') { const version = await json(`/versions/${versionId}`); check(version.id === versionId, 'writer-fence-deployment');
      const content = await bytes('/content/v2', 17825792); let deployedBytes = content.bytes;
      if (content.headers.get('content-type')?.startsWith('multipart/')) { const parts = [...(await new Response(deployedBytes, { headers: content.headers }).formData()).values()]; check(parts.length === 1 && typeof parts[0] !== 'string', 'writer-fence-modules'); deployedBytes = new Uint8Array(await parts[0].arrayBuffer()); }
      await verifier.verifyArtifact(current, api(current).name, deployedBytes); }
      const settings = await json('/settings'); check(Array.isArray(settings.bindings), 'writer-fence-configuration');
      const nonsecret = settings.bindings.filter(item => !['secret_text','secret_key'].includes(item.type));
      const secretInventory = settings.bindings.filter(item => ['secret_text','secret_key'].includes(item.type)).map(({ name,type }) => ({ name,type }));
      const desired = pins.nonsecretBindings.map(item => item.name === 'RELEASE_VERSION' ? { ...item,text:current.manifest.version } : item);
      check(same(order(nonsecret),order(desired)) && same(order(secretInventory),order(pins.secretBindings)), 'writer-fence-configuration');
      for (const key of settingKeys) check(Object.hasOwn(settings,key) === Object.hasOwn(pins.workerSettings,key) && (!Object.hasOwn(settings,key) || same(settings[key],pins.workerSettings[key])), 'writer-fence-configuration');
      const final = (await json('/deployments')).deployments?.[0]; check(same(final,deployment), 'writer-fence-deployment');
      return { identity, evidence: { ...identity, configurationSha256:await hash({ settings:pins.workerSettings, bindings:order(nonsecret), secrets:order(secretInventory) }), versionId, deploymentId:deployment.id } };
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function authorized(expected, callback) {
    exact(expected, ['installationId','applicationDatabaseId','epoch','jobId','operationId','holdId']);
    check(expected.installationId === pins.installationId && expected.applicationDatabaseId === pins.applicationDatabaseId && Number.isSafeInteger(expected.epoch) && expected.epoch > 0 && ['jobId','operationId','holdId'].every(key => uuid(expected[key])));
    const request = freeze(structuredClone(expected));
    return withAuthority(request, async authority => { for (const [key,value] of Object.entries(request)) check(authority[key] === value, 'writer-fence-authority'); return callback(request,authority); });
  }
  return Object.freeze({
    async prepare(expected) {
      return authorized(expected,async(request,authority)=>{
        const key=`writer-fence:${request.operationId}`, row=await store.operation(key);
        if(!row){const identity=await inspect(request,authority,'prior');await store.claim(key,{phase:'prior',identity});const saved=await store.operation(key);check(saved&&same(saved.value.identity,identity),'writer-fence-drift');return {outcome:'pending'};}
        const result=await inspect(request,authority,row.value.phase==='complete'?'live':'proof');check(same(row.value.identity,result.identity),'writer-fence-drift');
        if(row.value.phase==='complete'){check(same(row.value.evidence,result.evidence),'writer-fence-drift');return {outcome:'ready'};}
        check(row.value.phase==='prior','writer-fence-phase');
        if(!await store.replace(key,row.revision,{phase:'complete',...result}))return {outcome:'pending'};
        return {outcome:'ready'};
      });
    },
    async withWriterFence(expected, callback) {
      check(typeof callback==='function');
      return authorized(expected,async(request,authority)=>{
        const row=await store.operation(`writer-fence:${request.operationId}`);check(row?.value.phase==='complete','writer-fence-preparation');
        const result=await inspect(request,authority,'live');check(same(row.value.identity,result.identity)&&same(row.value.evidence,result.evidence),'writer-fence-drift');
        return callback(freeze({...result.evidence,holdId:request.holdId}));
      });
    },
  });
}
