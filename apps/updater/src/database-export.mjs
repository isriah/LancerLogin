import { sha256 } from '../../../packages/shared/src/updater/application-release.mjs';
import { ARTIFACT_CHUNK_BYTES } from './artifact-store.mjs';

export const EXPORT_MAX_BYTES = 16777216;
export const EXPORT_CHUNKS_PER_ADVANCE = 8;
const check = (value, code) => { if (!value) throw Error(code); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const pending = () => ({ outcome: 'pending' });
const unknown = () => ({ outcome: 'unknown' });

/** Unverified export candidates only. Never an engine.backup adapter. */
export function createDatabaseExportTransport({ pins: supplied, token, store, fetch: fetcher = globalThis.fetch }) {
  const pins = structuredClone(supplied);
  check(Object.keys(pins).sort().join(',') === 'accountId,applicationDatabaseId,exportStorageHost,installationId,updaterDatabaseId', 'export-pins');
  check(/^[a-f0-9]{32}$/.test(pins.accountId) && /^[A-Za-z0-9_-]{1,80}$/.test(pins.installationId), 'export-pins');
  check(uuid(pins.applicationDatabaseId) && uuid(pins.updaterDatabaseId) && pins.applicationDatabaseId !== pins.updaterDatabaseId, 'export-database');
  check(typeof pins.exportStorageHost === 'string' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.r2\.cloudflarestorage\.com$/.test(pins.exportStorageHost), 'export-host');
  check(typeof token === 'string' && token.length >= 16, 'export-token');
  const binding = JSON.stringify(pins);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${pins.accountId}/d1/database/${pins.applicationDatabaseId}/export`;
  const key = id => { check(uuid(id), 'export-operation'); return `database-export:${id}`; };
  const artifact = id => `database-export:${id}:sql`;
  function storageUrl(value) {
    check(typeof value === 'string' && value.length <= 8192, 'export-download-url');
    const url = new URL(value);
    check(url.protocol === 'https:' && url.hostname === pins.exportStorageHost && !url.port && !url.username && !url.password && !url.hash, 'export-download-url');
    return url.href;
  }
  async function load(id) {
    const row = await store.operation(key(id));
    check(row && row.value.binding === binding, 'export-operation-binding'); return row;
  }
  const save = (id, row, value) => store.replace(key(id), row.revision, { ...value, binding });
  async function request(url, body, max) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('export-deadline')); }, 20000); });
    const operation = (async () => {
      const response = await fetcher(url, { method: body ? 'POST' : 'GET', headers: body ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: controller.signal });
      check(response.ok && !(response.status >= 300 && response.status < 400), 'export-response');
      const size = response.headers.get('content-length');
      if (size !== null) check(/^\d+$/.test(size) && Number(size) <= max, 'export-size');
      const reader = response.body?.getReader(); check(reader, 'export-response');
      const chunks = []; let length = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; check(length <= max, 'export-size'); chunks.push(part.value); }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      check(length > 0 && (size === null || Number(size) === length), 'export-size'); return bytes;
    })();
    try { return await Promise.race([operation, deadline]); } finally { clearTimeout(timer); }
  }
  async function poll(id, row) {
    const body = { output_format: 'polling', ...(row.value.bookmark ? { current_bookmark: row.value.bookmark } : {}) };
    const bytes = await request(endpoint, body, 65536);
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    check(envelope.success === true && envelope.result && envelope.result.success !== false, 'export-provider');
    const result = envelope.result;
    if (result.status === 'error') { await save(id, row, { ...row.value, phase: 'failed' }); return { outcome: 'failed' }; }
    check(typeof result.at_bookmark === 'string' && result.at_bookmark.length > 0 && result.at_bookmark.length <= 512, 'export-bookmark');
    check(!row.value.bookmark || row.value.bookmark === result.at_bookmark, 'export-bookmark');
    const next = { ...row.value, phase: 'polling', bookmark: result.at_bookmark };
    if (result.status === 'complete') { next.phase = 'staging'; next.url = storageUrl(result.result?.signed_url); }
    else check(result.status === undefined, 'export-status');
    await save(id, row, next); return pending();
  }
  const receipt = (id, value) => ({ outcome: 'backup-candidate', candidate: { operationId: id, bytes: value.bytes, sha256: value.digest, verified: false } });
  async function advance(id) {
    try {
      let row = await load(id), value = row.value;
      if (value.phase === 'requested') return unknown(); // No bookmark: never blindly start again.
      if (value.phase === 'failed') return { outcome: 'failed' };
      if (value.phase === 'complete') return receipt(id, value);
      if (value.phase === 'polling') return await poll(id, row);
      check(value.phase === 'staging', 'export-state');
      const info = await store.info(artifact(id));
      if (info) {
        check(info.sha256 === value.digest && info.byte_length === value.bytes, 'export-integrity');
        if (info.sealed !== 1 && await store.nextChunk(artifact(id)) === info.chunk_count) {
          await store.seal(artifact(id));
          await save(id, row, { ...value, phase: 'complete', url: undefined }); return receipt(id, value);
        }
      }
      if (info?.sealed === 1) {
        check(info.sha256 === value.digest && info.byte_length === value.bytes, 'export-integrity');
        await save(id, row, { ...value, phase: 'complete', url: undefined }); return receipt(id, value);
      }
      const bytes = await request(storageUrl(value.url), null, EXPORT_MAX_BYTES), digest = await sha256(bytes);
      if (!value.digest) {
        check(await save(id, row, { ...value, digest, bytes: bytes.length }), 'export-conflict');
        row = await load(id); value = row.value;
      }
      check(value.digest === digest && value.bytes === bytes.length, 'export-integrity');
      await store.begin({ artifactId: artifact(id), bytes: bytes.length, digest });
      const start = await store.nextChunk(artifact(id)), count = Math.ceil(bytes.length / ARTIFACT_CHUNK_BYTES);
      for (let index = start; index < Math.min(count, start + EXPORT_CHUNKS_PER_ADVANCE); index++) await store.writeChunk(artifact(id), index, bytes.subarray(index * ARTIFACT_CHUNK_BYTES, (index + 1) * ARTIFACT_CHUNK_BYTES));
      // Seal on a separate advance, also recovering a lost final chunk acknowledgment.
      return pending();
    } catch { return unknown(); }
  }
  return Object.freeze({
    async begin(id) {
      try {
        if (!await store.claim(key(id), { binding, phase: 'requested' })) return unknown();
        return await poll(id, await load(id));
      } catch { return unknown(); }
    },
    advance,
    async read(id) {
      const { value } = await load(id); check(value.phase === 'complete', 'export-incomplete');
      const bytes = await store.read(artifact(id));
      check(bytes.length === value.bytes && await sha256(bytes) === value.digest, 'export-integrity');
      return { ...receipt(id, value).candidate, bytes };
    },
  });
}
