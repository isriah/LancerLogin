import { createApplicationVerifier, sha256, LIMITS } from '../../packages/shared/src/updater/application-release.mjs';
import { readDashboard } from '../../packages/shared/src/updater/dashboard-archive.mjs';

const API = 'https://api.github.com';
const CDN = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const PAGE_SIZE = 30;
const PROVIDER_JSON_BYTES = 8 * 1024 * 1024;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
class SourceError extends Error { constructor(code) { super(code); this.name = 'ReleaseSourceError'; } }
const check = (ok, code) => { if (!ok) throw new SourceError(code); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

// Trusted server construction only. No request-supplied URLs or credential getters.
export function createGitHubReleaseSource({ pins, token, fetch: fetchImpl = globalThis.fetch, deadlineMs = 30000 }) {
  check(typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[^\x21-\x7e]/.test(token), 'source-config');
  check(typeof fetchImpl === 'function' && Number.isInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 30000, 'source-config');
  let verifier;
  try { verifier = createApplicationVerifier(pins); } catch { throw new SourceError('source-config'); }
  const repository = freeze({ ...pins.repository }), channel = pins.channel;
  const trustBytes = new TextEncoder().encode(canonical({ repository, channel, keyId: pins.keyId, publicKey: [...pins.publicKey] }));
  const base = `/repos/${repository.owner}/${repository.name}`;
  const handles = new WeakMap();
  const authHeaders = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'LancerLogin-independent-updater' };

  async function operation(run) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SourceError('source-deadline')); }, deadlineMs); });
    try { return await Promise.race([run(controller.signal), timeout]); }
    catch (error) { throw error instanceof SourceError ? error : new SourceError('source-unavailable'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async function request(url, headers, signal) {
    check(!signal.aborted, 'source-deadline');
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
    check(!response.redirected && response.type !== 'opaqueredirect', 'source-redirect');
    return response;
  }
  async function read(response, limit, signal) {
    check(response.status === 200 && response.body, 'source-unavailable');
    const length = response.headers.get('content-length');
    check(length === null || (/^[0-9]+$/.test(length) && Number(length) <= limit), 'source-size');
    const reader = response.body.getReader(), chunks = []; let total = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        check(!signal.aborted, 'source-deadline');
        const item = await reader.read(); if (item.done) break;
        check(item.value instanceof Uint8Array && total + item.value.byteLength <= limit, 'source-size');
        total += item.value.byteLength; chunks.push(Uint8Array.from(item.value));
      }
      const bytes = new Uint8Array(total); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      return bytes;
    } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
  }
  async function json(path, signal) {
    const response = await request(API + path, authHeaders, signal);
    check(response.status === 200, 'source-unavailable');
    // Provider metadata embeds full asset records and is not a signed manifest.
    // Its separate bound must accommodate 30 releases with complete SQL chains.
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(response, PROVIDER_JSON_BYTES, signal))); }
    catch (error) { if (error instanceof SourceError) throw error; throw new SourceError('source-metadata'); }
  }
  async function checkRepository(signal) {
    const actual = await json(base, signal);
    check(actual.id === repository.id && actual.owner?.login === repository.owner && actual.name === repository.name && actual.private === true, 'source-repository');
  }
  async function assetsFor(releaseId, signal) {
    const assets = [], ids = new Set(), names = new Set();
    for (let page = 1; page <= 9; page++) {
      const batch = await json(`${base}/releases/${releaseId}/assets?per_page=${PAGE_SIZE}&page=${page}`, signal);
      check(Array.isArray(batch) && batch.length <= PAGE_SIZE, 'source-assets');
      for (const asset of batch) {
        check(positive(asset.id) && !ids.has(asset.id) && typeof asset.name === 'string' && !names.has(asset.name) && /^[a-z0-9][a-z0-9_.-]{0,80}$/.test(asset.name) && !/[^a-z0-9_.-]/.test(asset.name), 'source-assets');
        check(asset.state === 'uploaded' && positive(asset.size) && asset.size <= LIMITS.artifactBytes, 'source-assets');
        ids.add(asset.id); names.add(asset.name); assets.push({ id: asset.id, name: asset.name, bytes: asset.size });
        check(assets.length <= LIMITS.artifacts + 2, 'source-assets');
      }
      if (batch.length < PAGE_SIZE) return assets;
    }
    throw new SourceError('source-assets');
  }
  async function assetBytes(asset, limit, signal) {
    check(asset.bytes <= limit, 'source-size');
    let response = await request(`${API}${base}/releases/assets/${asset.id}`, { ...authHeaders, Accept: 'application/octet-stream' }, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      let target;
      try { target = new URL(response.headers.get('location')); } catch { throw new SourceError('source-redirect'); }
      check(target.protocol === 'https:' && CDN.has(target.hostname) && !target.port && !target.username && !target.password && !target.hash, 'source-redirect');
      void response.body?.cancel().catch(() => {});
      // Fresh headers: never forward GitHub authentication, cookies or a Referer.
      response = await request(target.href, { Accept: 'application/octet-stream' }, signal);
      check(response.status === 200, 'source-redirect');
    }
    const bytes = await read(response, limit, signal);
    check(bytes.length === asset.bytes, 'source-size');
    return bytes;
  }
  async function resolveRelease(releaseId, expected, signal) {
    check(positive(releaseId), 'source-release');
    await checkRepository(signal);
    const release = await json(`${base}/releases/${releaseId}`, signal);
    check(release.id === releaseId && release.immutable === true && release.draft === false && release.prerelease === false && typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)), 'source-release');
    const assets = await assetsFor(releaseId, signal);
    const manifestAsset = assets.find(asset => asset.name === 'manifest.json'), signatureAsset = assets.find(asset => asset.name === 'manifest.sig');
    check(manifestAsset && signatureAsset && signatureAsset.bytes === 64, 'source-assets');
    const manifestBytes = await assetBytes(manifestAsset, LIMITS.manifestBytes, signal), signatureBytes = await assetBytes(signatureAsset, 64, signal);
    let verified;
    try { verified = await verifier.verify(manifestBytes, signatureBytes); } catch { throw new SourceError('source-signature'); }
    check(release.tag_name === `v${verified.manifest.version}`, 'source-release');
    check(assets.length === verified.manifest.artifacts.length + 2, 'source-assets');
    const descriptors = [];
    for (const artifact of verified.manifest.artifacts) {
      const asset = assets.find(item => item.name === artifact.name);
      check(asset && asset.bytes === artifact.bytes, 'source-assets');
      descriptors.push({ ...asset, sha256: artifact.sha256 });
    }
    descriptors.push({ ...manifestAsset, sha256: verified.manifestSha256 }, { ...signatureAsset, sha256: await sha256(signatureBytes) });
    descriptors.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const identity = freeze({ format: 1, repository, channel, releaseId, tag: release.tag_name, manifestSha256: verified.manifestSha256, signatureSha256: await sha256(signatureBytes), assets: descriptors });
    if (expected) check(canonical(identity) === canonical(expected), 'source-checkpoint');
    // Signed bytes/verified handle are transient server data, never status fields.
    const handle = Object.freeze({ identity, manifestBytes: Uint8Array.from(manifestBytes), signatureBytes: Uint8Array.from(signatureBytes) });
    handles.set(handle, { verified, assets: descriptors }); return handle;
  }
  return Object.freeze({
    // Discovery is a bounded hint only. Each chosen ID must pass resolve().
    candidates() { return operation(async signal => {
      await checkRepository(signal);
      const releases = await json(`${base}/releases?per_page=${PAGE_SIZE}&page=1`, signal);
      check(Array.isArray(releases) && releases.length <= PAGE_SIZE, 'source-metadata');
      return freeze([...new Set(releases.filter(item => positive(item.id) && item.immutable === true && item.draft === false && item.prerelease === false).map(item => item.id))]);
    }); },
    available(installedState, progress = null) {
      let state, checkpoint;
      try { state = JSON.parse(JSON.stringify(installedState)); checkpoint = progress === null ? null : JSON.parse(JSON.stringify(progress)); }
      catch { return Promise.reject(new SourceError('source-checkpoint')); }
      return operation(async signal => {
        const stateSha256 = await sha256(new TextEncoder().encode(canonical(state))), trustSha256 = await sha256(trustBytes);
        if (checkpoint === null) {
          await checkRepository(signal);
          const releases = await json(`${base}/releases?per_page=${PAGE_SIZE}&page=1`, signal);
          check(Array.isArray(releases) && releases.length <= PAGE_SIZE, 'source-metadata');
          const ids = [...new Set(releases.filter(item => positive(item.id) && item.immutable === true && item.draft === false && item.prerelease === false).map(item => item.id))];
          checkpoint = { format: 1, stateSha256, trustSha256, candidateIds: ids, nextIndex: 0, best: null };
        } else {
          check(checkpoint && Object.keys(checkpoint).sort().join(',') === 'best,candidateIds,format,nextIndex,stateSha256,trustSha256' && checkpoint.format === 1 && checkpoint.stateSha256 === stateSha256 && checkpoint.trustSha256 === trustSha256, 'source-checkpoint');
          check(Array.isArray(checkpoint.candidateIds) && checkpoint.candidateIds.length <= PAGE_SIZE && checkpoint.candidateIds.every(positive) && new Set(checkpoint.candidateIds).size === checkpoint.candidateIds.length && Number.isInteger(checkpoint.nextIndex) && checkpoint.nextIndex >= 0 && checkpoint.nextIndex < checkpoint.candidateIds.length, 'source-checkpoint');
          check(checkpoint.best === null || (positive(checkpoint.best.sequence) && typeof checkpoint.best.version === 'string' && checkpoint.candidateIds.slice(0, checkpoint.nextIndex).includes(checkpoint.best.identity?.releaseId)), 'source-checkpoint');
        }
        // One candidate per call keeps provider subrequests bounded on Free Workers.
        // Candidate IDs are captured once; a resumed search never switches its list.
        if (checkpoint.nextIndex < checkpoint.candidateIds.length) {
          const id = checkpoint.candidateIds[checkpoint.nextIndex];
          let handle;
          try { handle = await resolveRelease(id, null, signal); }
          catch (error) { if (!(error instanceof SourceError && error.message === 'source-signature')) throw error; }
          if (handle) {
            const verified = handles.get(handle).verified;
            let compatible = true; try { verifier.evaluateUpdate(verified, state); } catch { compatible = false; }
            if (compatible && (!checkpoint.best || verified.manifest.sequence > checkpoint.best.sequence)) checkpoint.best = { identity: handle.identity, version: verified.manifest.version, sequence: verified.manifest.sequence };
          }
          checkpoint.nextIndex++;
        }
        if (checkpoint.nextIndex < checkpoint.candidateIds.length) return freeze({ status: 'checking', checked: checkpoint.nextIndex, total: checkpoint.candidateIds.length, progress: checkpoint });
        if (!checkpoint.best) return freeze({ status: 'no-compatible-release' });
        // Recheck the persisted winning identity, rather than trusting display data.
        const best = await resolveRelease(checkpoint.best.identity.releaseId, checkpoint.best.identity, signal);
        const verified = handles.get(best).verified;
        check(verified.manifest.version === checkpoint.best.version && verified.manifest.sequence === checkpoint.best.sequence, 'source-checkpoint');
        try { verifier.evaluateUpdate(verified, state); } catch { throw new SourceError('source-checkpoint'); }
        return freeze({ status: 'available', identity: best.identity, version: verified.manifest.version, sequence: verified.manifest.sequence });
      });
    },
    resolve(releaseId) { return operation(signal => resolveRelease(releaseId, null, signal)); },
    resume(identity) {
      // Snapshot updater-owned persisted state before asynchronous provider reads.
      let expected; try { expected = JSON.parse(JSON.stringify(identity)); } catch { return Promise.reject(new SourceError('source-checkpoint')); }
      return operation(signal => resolveRelease(expected?.releaseId, expected, signal));
    },
    download(handle, artifactName) { return operation(async signal => {
      const owned = handles.get(handle); check(owned, 'source-handle');
      check(owned.verified.manifest.artifacts.some(item => item.name === artifactName), 'source-artifact');
      await checkRepository(signal);
      const descriptor = owned.assets.find(item => item.name === artifactName);
      const bytes = await assetBytes(descriptor, descriptor.bytes, signal);
      let verified;
      try { verified = await verifier.verifyArtifact(owned.verified, artifactName, bytes); } catch { throw new SourceError('source-artifact'); }
      if (artifactName.endsWith('.tar')) {
        try { readDashboard(verified); } catch { throw new SourceError('source-archive'); }
      }
      return verified;
    }); },
  });
}
