// Composition primitive only: all actual application execution/egress sites must
// use the scoped capabilities before maintenance can claim application quiescence.
export async function admitExecutionScope({ core, capability, permitId = crypto.randomUUID() }) {
  const admission = await core.admit(capability, { permitId });
  if (admission.status !== 'admitted') return null;
  const permit = admission.permit;
  const pending = new Set();
  const ambiguous = new Map();
  let started = false, rootDone = false, revoked = false, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const check = () => { if (revoked) throw Error('execution-revoked'); };
  const release = async () => {
    if (!revoked || pending.size) throw Error('execution-not-drained');
    if (ambiguous.size) return { status: 'blocked' };
    try { return await core.release(capability, permit); }
    catch { return { status: 'release-unknown' }; }
  };
  const retryRelease = async () => {
    if (!revoked || pending.size) throw Error('execution-not-drained');
    // Bounded to one operation readback (and at most one missing-record write).
    const next = ambiguous.entries().next().value;
    if (next) {
      const [operationId, kind] = next;
      try {
        const row = await core.operationStatus(capability, permit, operationId);
        if (row?.state === 'complete') ambiguous.delete(operationId);
        else if (!row) await core.recordAmbiguity(capability, permit, operationId, kind);
      } catch { return { status: 'blocked' }; }
    }
    return release();
  };
  const drain = () => {
    if (!rootDone || pending.size || revoked) return;
    revoked = true; // No await between observing zero and revoking local dispatch.
    void release().then(resolveDone);
  };
  const track = promise => {
    check();
    const tracked = Promise.resolve(promise);
    pending.add(tracked);
    const settled = () => { pending.delete(tracked); drain(); };
    tracked.then(settled, settled); // Observe rejection even if a caller uses waitUntil.
    return tracked;
  };
  const guard = fn => (...args) => {
    check();
    return track(Promise.resolve().then(() => { check(); return fn(...args); }));
  };
  const mutation = (kind, dispatch, isDefinitive = () => false, terminalError = () => false) => (...args) => {
    check();
    const operationId = crypto.randomUUID();
    return track((async () => {
      const retain = async () => {
        ambiguous.set(operationId, kind); // Blocks release even if persistence fails.
        try { await core.recordAmbiguity(capability, permit, operationId, kind); } catch { /* ACTIVE permit remains durable. */ }
      };
      try {
        check();
        const result = await dispatch(Object.freeze({ operationId, permitId: permit.id, epoch: permit.epoch }), ...args);
        // The whole-execution permit, not per-statement writes, protects crashes.
        // A fulfilled response alone need not mean a remote mutation has finished.
        if (!await isDefinitive(result)) await retain();
        return result;
      } catch (error) {
        if (!terminalError(error)) await retain();
        throw error;
      }
    })());
  };
  const scope = Object.freeze({
    permitId: permit.id,
    done,
    run(handler) {
      check();
      if (started) throw Error('execution-already-started');
      started = true;
      const result = track(Promise.resolve().then(() => handler(scope)));
      const settled = () => { rootDone = true; drain(); };
      result.then(settled, settled);
      return result;
    },
    waitUntil(promise) { track(promise); },
    track,
    guard,
    mutation,
    retryRelease,
    wrapService(service, isDefinitive) {
      check();
      return Object.freeze({ fetch: mutation('service', (_operation, ...args) => service.fetch(...args), isDefinitive) });
    },
    wrapD1(database) {
      check();
      const originals = new WeakMap();
      const complete = result => result?.success !== false;
      // A positive SQLite constraint result proves the call finished, not that
      // all earlier writes rolled back. Network/cancellation errors do not match.
      const constraint = error => error instanceof Error && /^D1_ERROR: [^\r\n]{1,1024}: SQLITE_CONSTRAINT(?:_[A-Z]+)?$/.test(error.message);
      const statement = original => {
        const wrapped = Object.freeze({
          bind(...args) { check(); return statement(original.bind(...args)); },
          first: mutation('d1', (_operation, ...args) => original.first(...args), complete, constraint),
          all: mutation('d1', (_operation, ...args) => original.all(...args), complete, constraint),
          run: mutation('d1', (_operation, ...args) => original.run(...args), complete, constraint),
          raw: mutation('d1', (_operation, ...args) => original.raw(...args), complete, constraint),
        });
        originals.set(wrapped, original);
        return wrapped;
      };
      return Object.freeze({
        prepare(sql) { check(); return statement(database.prepare(sql)); },
        batch: mutation('d1', (_operation, statements) => {
          const raw = statements.map(item => {
            if (!originals.has(item)) throw Error('execution-foreign-statement');
            return originals.get(item);
          });
          return database.batch(raw);
        }, results => Array.isArray(results) && results.every(complete), constraint),
        exec: mutation('d1', (_operation, sql) => database.exec(sql), complete, constraint),
      });
    },
  });
  return scope;
}
