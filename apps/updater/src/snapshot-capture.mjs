import { selectSnapshotCatalog } from './snapshot-catalog-registry.mjs';
import { sha256 } from '../../../packages/shared/src/updater/application-release.mjs';
import { ARTIFACT_CHUNK_BYTES } from './artifact-store.mjs';
import { SNAPSHOT_LIMITS, typedPageQuery, encodeTypedPage, rowId } from './snapshot-codec.mjs';
const check = (value, code) => { if (!value) throw Error(code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const encoder = new TextEncoder();
const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE (name NOT GLOB 'sqlite_*' OR type='index' OR name='sqlite_sequence') AND name NOT IN ('_cf_KV','_cf_METADATA') AND tbl_name NOT IN ('_cf_KV','_cf_METADATA') ORDER BY type,name LIMIT 512";

export function createSnapshotCapture({ pins: supplied, database, store, withClosedEpoch, catalogKey }) {
  const pins = structuredClone(supplied), { catalog, catalogSha256 } = selectSnapshotCatalog(catalogKey);
  check(Object.keys(pins).sort().join(',') === 'applicationDatabaseId,installationId,updaterDatabaseId' && /^[A-Za-z0-9_-]{1,80}$/.test(pins.installationId) && uuid(pins.applicationDatabaseId) && uuid(pins.updaterDatabaseId) && pins.applicationDatabaseId !== pins.updaterDatabaseId && typeof withClosedEpoch === 'function', 'snapshot-pins');
  const primary = () => database.withSession ? database.withSession('first-primary') : database;
  const key = id => { check(uuid(id), 'snapshot-id'); return `snapshot:${id}`; };
  async function schema(db) {
    check(await sha256(encoder.encode(JSON.stringify(catalog))) === catalogSha256 && await sha256(encoder.encode(JSON.stringify(catalog.ledger))) === catalog.chainSha256, 'snapshot-catalog');
    const objects = (await db.prepare(schemaSql).all()).results;
    check(same(objects, catalog.objects), 'snapshot-schema');
    const ledger = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id LIMIT 255').all()).results;
    check(same(ledger.map(row => row.name), catalog.ledger.map(row => row.id)), 'snapshot-ledger');
  }
  const completed = (id, value) => ({ outcome: 'snapshot-candidate', candidate: { operationId: id, schema: catalog.schema, catalogSha256, chainSha256: catalog.chainSha256, pages: value.pages.length, bytes: value.total, manifestSha256: value.manifestSha256, verified: false } });
  async function advance(id) {
    try {
      key(id);
      return await withClosedEpoch(Object.freeze({ installationId: pins.installationId, operationId: id, catalogSha256 }), async authority => {
        check(authority?.installationId === pins.installationId && authority.operationId === id && uuid(authority.jobId) && authority.state === 'closed' && Number.isSafeInteger(authority.epoch) && authority.epoch > 0 && authority.schema === catalog.schema && same(authority.ledger, catalog.ledger), 'snapshot-authority');
        const identity = { ...pins, jobId: authority.jobId, epoch: authority.epoch, catalogSha256 };
        let row = await store.operation(key(id)); const db = primary();
        if (!row) {
          await schema(db);
          check(await store.claim(key(id), { identity, table: 0, after: null, total: 0, pages: [], pending: null, phase: 'capturing' }), 'snapshot-conflict');
          return { outcome: 'pending' };
        }
        let value = row.value; check(same(value.identity, identity), 'snapshot-conflict');
        if (value.phase === 'complete') return completed(id, value);
        const save = next => store.replace(key(id), row.revision, next);
        if (value.table === catalog.tables.length) {
          await schema(db);
          const manifestSha256 = await sha256(encoder.encode(JSON.stringify({ identity, pages: value.pages, bytes: value.total })));
          check(await save({ ...value, phase: 'complete', manifestSha256 }), 'snapshot-conflict'); return completed(id, { ...value, manifestSha256 });
        }
        const table = catalog.tables[value.table], artifactId = `snapshot:${id}:page:${value.pages.length}`;
        if (value.pending) {
          const file = await store.info(artifactId);
          if (file && await store.nextChunk(artifactId) === file.chunk_count) {
            check(file.sha256 === value.pending.sha256 && file.byte_length === value.pending.bytes, 'snapshot-integrity');
            await store.seal(artifactId);
            const page = { artifactId, table: table.name, ...value.pending };
            check(await save({ ...value, total: value.total + page.bytes, pages: [...value.pages, page], after: page.lastRowId, pending: null }), 'snapshot-conflict');
            return { outcome: 'pending' };
          }
        }
        const query = typedPageQuery(table, value.after), rows = (await db.prepare(query.sql).bind(...query.params).all()).results;
        if (!rows.length) { check(!value.pending, 'snapshot-drift'); check(await save({ ...value, table: value.table + 1, after: null }), 'snapshot-conflict'); return { outcome: 'pending' }; }
        const bytes = encodeTypedPage(table, rows, value.after), digest = await sha256(bytes);
        const descriptor = { sha256: digest, bytes: bytes.length, rows: rows.length, lastRowId: rows.at(-1).rowId };
        check(value.total + bytes.length <= SNAPSHOT_LIMITS.totalBytes && value.pages.length < SNAPSHOT_LIMITS.pages, 'snapshot-size');
        if (!value.pending) { check(await save({ ...value, pending: descriptor }), 'snapshot-conflict'); row = await store.operation(key(id)); value = row.value; }
        check(same(value.pending, descriptor), 'snapshot-drift');
        await store.begin({ artifactId, bytes: bytes.length, digest });
        const start = await store.nextChunk(artifactId), count = Math.ceil(bytes.length / ARTIFACT_CHUNK_BYTES);
        for (let index = start; index < Math.min(count, start + 8); index++) await store.writeChunk(artifactId, index, bytes.subarray(index * ARTIFACT_CHUNK_BYTES, (index + 1) * ARTIFACT_CHUNK_BYTES));
        return { outcome: 'pending' };
      });
    } catch { return { outcome: 'unknown' }; }
  }
  const readers = new WeakMap();
  async function describe(id, reader) {
    if (reader !== undefined) {
      const retained = readers.get(reader);
      check(retained?.id === id, 'snapshot-reader');
      return structuredClone(retained.manifest);
    }
    const row = await store.operation(key(id)), value = row?.value;
    check(value?.phase === 'complete' && value.table === catalog.tables.length && value.pending === null, 'snapshot-incomplete');
    check(Object.entries(pins).every(([name, pin]) => value.identity[name] === pin) && value.identity.catalogSha256 === catalogSha256 && uuid(value.identity.jobId) && Number.isSafeInteger(value.identity.epoch) && value.identity.epoch > 0, 'snapshot-conflict');
    check(Array.isArray(value.pages) && value.pages.length <= SNAPSHOT_LIMITS.pages, 'snapshot-pages');
    let total = 0, previousTable = -1, previousRow = null;
    for (const [index, page] of value.pages.entries()) {
      const table = catalog.tables.findIndex(table => table.name === page.table);
      check(table >= 0 && table >= previousTable && page.artifactId === `snapshot:${id}:page:${index}` && /^[a-f0-9]{64}$/.test(page.sha256) && Number.isSafeInteger(page.bytes) && page.bytes > 0 && page.bytes <= SNAPSHOT_LIMITS.pageBytes && Number.isSafeInteger(page.rows) && page.rows > 0 && page.rows <= SNAPSHOT_LIMITS.pageRows, 'snapshot-descriptor');
      const last = rowId(page.lastRowId); check(table !== previousTable || last > previousRow, 'snapshot-order');
      previousTable = table; previousRow = last; total += page.bytes;
    }
    check(total === value.total && total <= SNAPSHOT_LIMITS.totalBytes && await sha256(encoder.encode(JSON.stringify({ identity: value.identity, pages: value.pages, bytes: value.total }))) === value.manifestSha256, 'snapshot-integrity');
    return structuredClone({ operationId: id, identity: value.identity, pages: value.pages, bytes: total, manifestSha256: value.manifestSha256, catalogSha256, chainSha256: catalog.chainSha256, schema: catalog.schema, verified: false });
  }
  return Object.freeze({ advance, describe,
    async withReader(id, callback) {
      const manifest = await describe(id), reader = Object.freeze({});
      readers.set(reader, { id, manifest });
      try { return await callback(reader); } finally { readers.delete(reader); }
    },
    async readPage(id, index, reader) {
    const manifest = await describe(id, reader); check(Number.isSafeInteger(index) && index >= 0 && index < manifest.pages.length, 'snapshot-page');
    const descriptor = manifest.pages[index], bytes = await store.read(descriptor.artifactId);
    check(bytes.length === descriptor.bytes && await sha256(bytes) === descriptor.sha256, 'snapshot-integrity');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), table = catalog.tables.find(table => table.name === descriptor.table);
    check(value.table === table.name && same(value.columns, table.columns) && Array.isArray(value.rows) && value.rows.length === descriptor.rows && value.rows.at(-1)?.[0] === descriptor.lastRowId, 'snapshot-page');
    const after = index > 0 && manifest.pages[index - 1].table === table.name ? manifest.pages[index - 1].lastRowId : null;
    const canonical = encodeTypedPage(table, value.rows.map(row => ({ rowId: row[0], cells: JSON.stringify(row[1]) })), after);
    check(await sha256(canonical) === descriptor.sha256, 'snapshot-page'); return bytes;
  } });
}
