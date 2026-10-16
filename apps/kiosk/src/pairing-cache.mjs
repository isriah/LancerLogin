// Share reads and serialize updates. Invalidation prevents stale reads from
// restoring credentials after a pairing transition.
export function createPairingCache({ read, write, onValue = () => undefined }) {
  let loaded = false, value, loading, generation = 0, updates = Promise.resolve();
  async function load() {
    if (loaded) return value;
    if (!loading) {
      const epoch = generation;
      const pending = Promise.resolve().then(read).then(result => {
        if (epoch !== generation) return value;
        value = result; loaded = true; onValue(value); return value;
      }).finally(() => { if (loading === pending) loading = undefined; });
      loading = pending;
    }
    return loading;
  }
  function update(operation) {
    const result = updates.catch(() => undefined).then(async () => {
      const current = await load(); const epoch = generation;
      const next = operation(current);
      if (!next || next === current) return current;
      await write(next);
      if (epoch !== generation) return value;
      value = next; loaded = true; onValue(value); return value;
    });
    updates = result; return result;
  }
  return { load, update, save: next => update(() => next), invalidate() { generation++; loaded = false; value = undefined; loading = undefined; }, generation: () => generation };
}
