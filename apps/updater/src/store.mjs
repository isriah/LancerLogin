// D1's single-statement compare-and-swap is the only writer arbitration point.
// A separate updater-only binding must be supplied by trusted bootstrap code.
export function createUpdaterStore(database, installationId) {
  if (typeof installationId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(installationId)) throw Error('installation');
  return Object.freeze({
    async read() {
      const row = await database.prepare('SELECT installation_id, revision, state_json FROM updater_state WHERE id = 1').first();
      if (!row) return null;
      if (row.installation_id !== installationId) throw Error('installation');
      return { revision: row.revision, state: JSON.parse(row.state_json) };
    },
    async initialize(state) {
      return Boolean(await database.prepare('INSERT INTO updater_state (id, installation_id, revision, state_json) VALUES (1, ?, 0, ?) ON CONFLICT(id) DO NOTHING RETURNING revision').bind(installationId, JSON.stringify(state)).first());
    },
    async replace(revision, state) {
      const serialized = JSON.stringify(state);
      if (new TextEncoder().encode(serialized).length > 1_500_000) throw Error('state-size');
      return Boolean(await database.prepare('UPDATE updater_state SET state_json = ?, revision = revision + 1 WHERE id = 1 AND installation_id = ? AND revision = ? RETURNING revision').bind(serialized, installationId, revision).first());
    },
  });
}
