import { selectSnapshotCatalog } from './snapshot-catalog-registry.mjs';
import { SNAPSHOT_LIMITS, typedPageQuery, encodeTypedPage, rowId } from './snapshot-codec.mjs';
import { sha256 } from '../../../packages/shared/src/updater/application-release.mjs';

import { createValidationLifecycle, OWNER, STEPS, GENERATIONS, ownerSql, stepsSql, generationsSql, schemaSql, metadata, checkMetadata } from './validation-lifecycle.mjs';
const check = (ok, reason) => { if (!ok) throw Error(reason); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const encoder = new TextEncoder();
const hash = value => sha256(encoder.encode(JSON.stringify(value)));
const quote = name => { check(/^[A-Za-z_][A-Za-z_0-9]*$/.test(name), 'validation-catalog'); return `"${name}"`; };

function insert(table, row) {
  const params = [row[0]], expressions = ['CAST(? AS INTEGER)']; rowId(row[0]);
  let bytes = 32;
  check(row[1].length === table.columns.length && table.columns.length < 100, 'validation-data');
  for (const [type, value] of row[1]) {
    if (type === 'null') { expressions.push('NULL'); bytes += 32; continue; }
    if (type === 'integer') { rowId(value); expressions.push('CAST(? AS INTEGER)'); params.push(value); bytes += 32; }
    else if (type === 'real') { check(typeof value === 'string' && /^-?\d+\.\d+(e[+-]?\d+)?$/i.test(value), 'validation-data'); expressions.push('CAST(? AS REAL)'); params.push(value); bytes += 32; }
    else {
      check(['text', 'blob'].includes(type) && typeof value === 'string' && /^(?:[0-9A-F]{2})*$/.test(value), 'validation-data');
      const data = Uint8Array.from(value.match(/../g) ?? [], byte => parseInt(byte, 16));
      expressions.push(type === 'text' ? 'CAST(? AS TEXT)' : 'CAST(? AS BLOB)'); params.push(data.buffer); bytes += data.length + 32;
    }
  }
  check(bytes <= SNAPSHOT_LIMITS.rowBytes + 32 && params.length <= 100, 'validation-data');
  return { sql: `INSERT INTO ${quote(table.name)}(_rowid_,${table.columns.map(quote).join(',')}) VALUES(${expressions.join(',')})`, params, bytes };
}

export function createSnapshotReplay({ pins: supplied, database, store, capture, capability, catalogKey, withClosedEpoch }) {
  const pins = structuredClone(supplied), { catalog, catalogSha256, plan } = selectSnapshotCatalog(catalogKey);
  check(Object.keys(pins).sort().join(',') === 'applicationDatabaseId,installationId,updaterDatabaseId,validationDatabaseId' && /^[A-Za-z0-9_-]{1,80}$/.test(pins.installationId) && ['applicationDatabaseId','updaterDatabaseId','validationDatabaseId'].every(name => uuid(pins[name])) && new Set([pins.applicationDatabaseId,pins.updaterDatabaseId,pins.validationDatabaseId]).size === 3 && capability && typeof capability === 'object', 'validation-pins');
  check(plan.catalogSha256 === catalogSha256 && plan.order.length === catalog.tables.length - 1 && new Set(plan.order).size === plan.order.length && plan.order.every(name => catalog.tables.some(table => table.name === name) && name !== 'sqlite_sequence'), 'validation-catalog');
  const lifecycle = createValidationLifecycle({ database, store, pins, withClosedEpoch });
  const primary = () => database.withSession ? database.withSession('first-primary') : database;
  const key = id => { check(uuid(id), 'validation-request'); return `snapshot-replay:${id}`; };
  const tables = catalog.objects.filter(object => object.type === 'table' && object.name !== 'sqlite_sequence');
  const early = plan.earlyIndexes.map(name => catalog.objects.find(object => object.type === 'index' && object.name === name));
  const finalObjects = catalog.objects.filter(object => object.type !== 'table' && object.sql && !plan.earlyIndexes.includes(object.name));
  const pending = state => ({ outcome: 'pending', phase: state.cursor.phase, step: state.step });
  const validated = state => ({ outcome: 'validated', receipt: { format: 'typed-replay-v1', ...state.identity, schema: catalog.schema, chainSha256: catalog.chainSha256 } });

  async function advance(actual, input, readOnly = false, reader) {
    check(actual === capability, 'validation-authorization');
    check(input && Object.keys(input).sort().join(',') === 'operationId,snapshotId' && uuid(input.operationId) && uuid(input.snapshotId), 'validation-request');
    const { operationId, snapshotId } = input, operationKey = key(operationId);
    let row;
    try {
      const manifest = await capture.describe(snapshotId, reader);
      check(manifest.schema === catalog.schema && manifest.catalogSha256 === catalogSha256 && manifest.chainSha256 === catalog.chainSha256 && manifest.operationId === snapshotId && Object.entries(pins).filter(([name]) => name !== 'validationDatabaseId').every(([name, value]) => manifest.identity[name] === value) && await hash(catalog) === catalogSha256, 'validation-manifest');
      const identity = { ...pins, operationId, snapshotId, manifestSha256: manifest.manifestSha256, catalogSha256 };
      const db = primary(), statement = work => db.prepare(work.sql).bind(...(work.params ?? []));
      row = await store.operation(operationKey);
      if (!row) {
        const target = await lifecycle.prepare(identity, manifest, readOnly);
        if (!target.ready) return { outcome: target.unknown ? 'unknown' : 'pending' };
        if (readOnly) return { outcome: 'pending' };
        const state = { identity, step: target.step, cursor: { phase: 'tables', index: 0 }, pending: target.initial ? { number: 0, kind: 'claim' } : null };
        if (!await store.claim(operationKey, state)) return { outcome: 'unknown' };
        if (target.initial) await db.batch([db.prepare(ownerSql), db.prepare(stepsSql), db.prepare(generationsSql), db.prepare(`INSERT INTO ${OWNER}(id,owner,snapshot,next_step) VALUES(1,?,?,1)`).bind(operationId, identity.manifestSha256), db.prepare(`INSERT INTO ${GENERATIONS}(owner,identity_json,status) VALUES(?,?,'active')`).bind(operationId,JSON.stringify(identity))]);
        return { outcome: 'pending', phase: 'claim', step: target.step };
      }
      let state = row.value;
      check(same(state.identity, identity), 'validation-owner');
      if (state.cursor.phase === 'rejected') return { outcome: 'rejected', reason: state.reason };
      if (state.cursor.phase === 'complete') return validated(state);
      const owner = await db.prepare(`SELECT owner,snapshot,next_step FROM ${OWNER} WHERE id=1`).first();
      check(owner?.owner === operationId && owner.snapshot === identity.manifestSha256, 'validation-owner');
      const save = next => store.replace(operationKey, row.revision, next);
      if (state.pending) {
        const step = state.pending;
        if (step.number !== 0) {
          const receipt = await db.prepare(`SELECT owner,commitment FROM ${STEPS} WHERE step=?`).bind(step.number).first();
          if (!receipt) return { outcome: 'unknown' }; // Absence never authorizes redispatch.
          check(receipt.owner === operationId && receipt.commitment === step.commitment && owner.next_step === step.number + 1, 'validation-owner');
        } else check(owner.next_step === 1, 'validation-owner');
        if (readOnly) return pending(state);
        const next = { ...state, step: step.number + 1, cursor: step.next ?? state.cursor, pending: null };
        return await save(next) ? pending(next) : { outcome: 'unknown' };
      }
      check(owner.next_step === state.step, 'validation-owner');
      if (readOnly) return pending(state);

      async function dispatch(works, next, description) {
        check(works.length > 0 && works.length <= 8, 'validation-batch');
        const commitment = await hash({ identity, step: state.step, description });
        const claimed = { ...state, pending: { number: state.step, commitment, next } };
        if (!await save(claimed)) return { outcome: 'unknown' };
        // NOT NULL + unique step guard abort the WHOLE batch for wrong owner or
        // stale step. Receipt, changes and next_step commit together under D1 batch.
        const guard = db.prepare(`INSERT INTO ${STEPS}(step,owner,commitment) VALUES(?,(SELECT owner FROM ${OWNER} WHERE id=1 AND owner=? AND snapshot=? AND next_step=?),?)`).bind(state.step, operationId, identity.manifestSha256, state.step, commitment);
        await db.batch([guard, ...works.map(statement), db.prepare(`UPDATE ${OWNER} SET next_step=next_step+1 WHERE id=1`).bind()]);
        return pending(claimed); // Next invocation reads the exact durable receipt.
      }
      const cursor = state.cursor;
      if (['tables','early','objects'].includes(cursor.phase)) {
        const list = cursor.phase === 'tables' ? tables : cursor.phase === 'early' ? early : finalObjects;
        if (cursor.index === list.length) {
          const next = { phase: cursor.phase === 'tables' ? 'early' : cursor.phase === 'early' ? 'data' : 'compare', index: 0, row: 0, after: null };
          return await save({ ...state, cursor: next }) ? pending({ ...state, cursor: next }) : { outcome: 'unknown' };
        }
        const end = Math.min(list.length, cursor.index + 8);
        return await dispatch(list.slice(cursor.index, end).map(object => ({ sql: object.sql })), { phase: cursor.phase, index: end }, { phase: cursor.phase, start: cursor.index, end });
      }
      if (cursor.phase === 'sequence-clear') return await dispatch([{ sql: 'DELETE FROM sqlite_sequence' }], { phase: 'sequence', index: 0, row: 0 }, { phase: 'sequence-clear' });
      if (cursor.phase === 'data' || cursor.phase === 'sequence') {
        const ordered = (cursor.phase === 'data' ? plan.order : ['sqlite_sequence']).flatMap(name => manifest.pages.map((page, index) => ({ ...page, index })).filter(page => page.table === name));
        if (cursor.index === ordered.length) {
          const next = { phase: cursor.phase === 'data' ? 'sequence-clear' : 'objects', index: 0 };
          return await save({ ...state, cursor: next }) ? pending({ ...state, cursor: next }) : { outcome: 'unknown' };
        }
        const descriptor = ordered[cursor.index], bytes = await capture.readPage(snapshotId, descriptor.index, reader), page = JSON.parse(new TextDecoder().decode(bytes));
        const table = catalog.tables.find(table => table.name === descriptor.table);
        check(page.table === table.name && same(page.columns, table.columns) && await sha256(bytes) === descriptor.sha256, 'validation-data');
        const works = []; let size = 0, end = cursor.row;
        while (end < page.rows.length && works.length < 8) {
          const work = insert(table, page.rows[end]);
          if (works.length && size + work.bytes > SNAPSHOT_LIMITS.rowBytes + 32) break;
          works.push(work); size += work.bytes; end++;
        }
        const next = end === page.rows.length ? { phase: cursor.phase, index: cursor.index + 1, row: 0 } : { ...cursor, row: end };
        return await dispatch(works, next, { page: descriptor.index, digest: descriptor.sha256, start: cursor.row, end });
      }
      if (cursor.phase === 'compare') {
        let index = cursor.index, pageIndex = cursor.row, after = cursor.after;
        for (let count = 0; count < 8 && index < catalog.tables.length; count++) {
          const table = catalog.tables[index], descriptor = manifest.pages[pageIndex], query = typedPageQuery(table, after);
          const rows = (await db.prepare(query.sql).bind(...query.params).all()).results;
          if (descriptor?.table === table.name) {
            const original = await capture.readPage(snapshotId, pageIndex, reader), actual = encodeTypedPage(table, rows, after);
            check(rows.length === descriptor.rows && actual.length === original.length && await sha256(actual) === descriptor.sha256, 'validation-data');
            after = descriptor.lastRowId; pageIndex++; break;
          }
          check(rows.length === 0, 'validation-data'); index++; after = null;
        }
        const next = index === catalog.tables.length ? { phase: 'checks' } : { phase: 'compare', index, row: pageIndex, after };
        check(index !== catalog.tables.length || pageIndex === manifest.pages.length, 'validation-data');
        return await save({ ...state, cursor: next }) ? pending({ ...state, cursor: next }) : { outcome: 'unknown' };
      }
      check(cursor.phase === 'checks', 'validation-state');
      const objects = (await db.prepare(schemaSql).all()).results;
      checkMetadata(objects);
      check(same(objects.filter(object => !metadata(object)), catalog.objects), 'validation-schema');
      check((await db.prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1').all()).results.length === 0, 'validation-foreign-key');
      const integrity = (await db.prepare('PRAGMA quick_check(1)').all()).results;
      check(integrity.length === 1 && integrity[0].quick_check === 'ok', 'validation-integrity');
      check(same((await db.prepare('SELECT name FROM d1_migrations ORDER BY id LIMIT 255').all()).results.map(row => row.name), catalog.ledger.map(entry => entry.id)), 'validation-schema');
      const finalOwner = await db.prepare(`SELECT owner,snapshot,next_step FROM ${OWNER} WHERE id=1`).first();
      check(same(finalOwner, owner), 'validation-owner');
      const sealed = await db.prepare(`UPDATE ${GENERATIONS} SET status='complete',final_step=? WHERE owner=? AND identity_json=? AND status IN ('active','complete') AND EXISTS(SELECT 1 FROM ${OWNER} WHERE owner=? AND snapshot=? AND next_step=?) RETURNING owner`).bind(state.step,operationId,JSON.stringify(identity),operationId,identity.manifestSha256,state.step).first();
      check(sealed, 'validation-owner');
      const complete = { ...state, cursor: { phase: 'complete' } };
      return await save(complete) ? validated(complete) : { outcome: 'unknown' };
    } catch (error) {
      const reason = error?.message?.startsWith('snapshot-') ? 'snapshot-invalid' : error?.message;
      if (['snapshot-invalid','validation-owner','validation-data','validation-schema','validation-foreign-key','validation-integrity','validation-target-not-empty','validation-manifest'].includes(reason)) {
        if (row && !readOnly) await store.replace(operationKey, row.revision, { ...row.value, cursor: { phase: 'rejected' }, reason }).catch(() => {});
        return { outcome: 'rejected', reason };
      }
      return { outcome: 'unknown' };
    }
  }
  return Object.freeze({ advance: (actual, input, reader) => advance(actual, input, false, reader), reconcile: (actual, input, reader) => advance(actual, input, true, reader) });
}
