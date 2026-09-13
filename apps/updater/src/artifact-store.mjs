import { sha256 } from '../../../packages/shared/src/updater/application-release.mjs';
import { toBase64, fromBase64 } from './checkpoint.mjs';

export const ARTIFACT_CHUNK_BYTES = 98304;
export const ARTIFACT_READ_PAGE_CHUNKS = 16;
const check = (value, code) => { if (!value) throw Error(code); };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value);

/** Separate updater D1; the application never receives this binding or cipher. */
export function createArtifactStore({ database, installationId, cipher }) {
  check(validId(installationId), 'installation');
  const first = (sql, ...args) => database.prepare(sql).bind(...args).first();
  const info = async artifactId => {
    check(validId(artifactId), 'artifact-id');
    return first('SELECT * FROM updater_artifacts WHERE installation_id=? AND artifact_id=?', installationId, artifactId);
  };
  async function readBytes(artifactId, allowUnsealed = false) {
    const file = await info(artifactId);
    check(file && (file.sealed === 1 || allowUnsealed), 'artifact-unsealed');
    const result = new Uint8Array(file.byte_length);
    let count = 0;
    for (let start = 0; start < file.chunk_count; start += ARTIFACT_READ_PAGE_CHUNKS) {
      const page = await database.prepare('SELECT chunk_index,sha256,envelope FROM updater_artifact_chunks WHERE installation_id=? AND artifact_id=? AND chunk_index>=? AND chunk_index<? ORDER BY chunk_index').bind(installationId, artifactId, start, start + ARTIFACT_READ_PAGE_CHUNKS).all();
      for (const row of page.results) {
        check(row.chunk_index === count, 'artifact-chunk-missing');
        const value = await cipher.open(`artifact:${artifactId}:${count}:${row.sha256}`, JSON.parse(row.envelope));
        const bytes = fromBase64(value.bytes);
        check(bytes.length === Math.min(ARTIFACT_CHUNK_BYTES, result.length - count * ARTIFACT_CHUNK_BYTES) && await sha256(bytes) === row.sha256, 'artifact-chunk-integrity');
        result.set(bytes, count++ * ARTIFACT_CHUNK_BYTES);
      }
    }
    check(count === file.chunk_count && await sha256(result) === file.sha256, 'artifact-integrity');
    return result;
  }
  return Object.freeze({
    info,
    read: readBytes,
    async begin({ artifactId, bytes, digest }) {
      check(validId(artifactId) && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 16777216 && /^[a-f0-9]{64}$/.test(digest), 'artifact-descriptor');
      await first('INSERT INTO updater_artifacts(installation_id,artifact_id,sha256,byte_length,chunk_count) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING artifact_id', installationId, artifactId, digest, bytes, Math.ceil(bytes / ARTIFACT_CHUNK_BYTES));
      const file = await info(artifactId);
      check(file.sha256 === digest && file.byte_length === bytes, 'artifact-conflict');
      return file;
    },
    async writeChunk(artifactId, index, input) {
      const bytes = Uint8Array.from(input), file = await info(artifactId);
      check(file && Number.isSafeInteger(index) && index >= 0 && index < file.chunk_count && bytes.length === Math.min(ARTIFACT_CHUNK_BYTES, file.byte_length - index * ARTIFACT_CHUNK_BYTES), 'artifact-chunk');
      const digest = await sha256(bytes);
      const envelope = await cipher.seal(`artifact:${artifactId}:${index}:${digest}`, { bytes: toBase64(bytes) });
      // Immutable chunks: even concurrent writers cannot replace a prior digest.
      await first('INSERT INTO updater_artifact_chunks(installation_id,artifact_id,chunk_index,sha256,envelope) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM updater_artifacts WHERE installation_id=? AND artifact_id=? AND sealed=0) ON CONFLICT DO NOTHING RETURNING chunk_index', installationId, artifactId, index, digest, JSON.stringify(envelope), installationId, artifactId);
      const row = await first('SELECT sha256 FROM updater_artifact_chunks WHERE installation_id=? AND artifact_id=? AND chunk_index=?', installationId, artifactId, index);
      check(row?.sha256 === digest, 'artifact-chunk-conflict');
    },
    async nextChunk(artifactId) {
      const row = await first('SELECT COUNT(*) AS count FROM updater_artifact_chunks WHERE installation_id=? AND artifact_id=?', installationId, artifactId);
      return row.count;
    },
    async seal(artifactId) {
      await readBytes(artifactId, true);
      await first('UPDATE updater_artifacts SET sealed=1 WHERE installation_id=? AND artifact_id=? RETURNING artifact_id', installationId, artifactId);
    },
    async operation(operationId) {
      check(validId(operationId), 'operation-id');
      const row = await first('SELECT revision,envelope FROM updater_provider_operations WHERE installation_id=? AND operation_id=?', installationId, operationId);
      return row ? { revision: row.revision, value: await cipher.open(`operation:${operationId}`, JSON.parse(row.envelope)) } : null;
    },
    async claim(operationId, value) {
      check(validId(operationId), 'operation-id');
      const envelope = await cipher.seal(`operation:${operationId}`, value);
      return Boolean(await first('INSERT INTO updater_provider_operations(installation_id,operation_id,envelope) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING operation_id', installationId, operationId, JSON.stringify(envelope)));
    },
    async replace(operationId, revision, value) {
      const envelope = await cipher.seal(`operation:${operationId}`, value);
      return Boolean(await first('UPDATE updater_provider_operations SET envelope=?,revision=revision+1 WHERE installation_id=? AND operation_id=? AND revision=? RETURNING operation_id', JSON.stringify(envelope), installationId, operationId, revision));
    },
  });
}
