// Maintainer-only plan generation from the release-owned allowlisted catalog.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--schema' || !['46', '47', '48', '49'].includes(args[1]))) throw Error('catalog-schema-argument');
const suffix = args[1] && args[1] !== '49' ? `-${args[1]}` : '';
const { snapshotCatalog, catalogSha256 } = await import(`../apps/updater/src/snapshot-catalog${suffix}.mjs`);
const db = new DatabaseSync(':memory:');
try {
  for (const object of snapshotCatalog.objects.filter(object => object.type === 'table' && object.name !== 'sqlite_sequence')) db.exec(object.sql);
  const dependencies = new Map(snapshotCatalog.tables.filter(table => table.name !== 'sqlite_sequence').map(table => [table.name, [...new Set(db.prepare(`PRAGMA foreign_key_list("${table.name}")`).all().map(row => row.table))].sort()]));
  const visiting = new Set(), visited = new Set(), order = [];
  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name) || !dependencies.has(name)) throw Error('unsupported-catalog-cycle');
    visiting.add(name); for (const dependency of dependencies.get(name)) visit(dependency);
    visiting.delete(name); visited.add(name); order.push(name);
  }
  for (const name of dependencies.keys()) visit(name);
  const earlyIndexes = ['members_installation_identity', 'users_installation_identity'];
  for (const name of earlyIndexes) if (!snapshotCatalog.objects.some(object => object.name === name && /^CREATE UNIQUE INDEX /.test(object.sql))) throw Error('catalog-parent-index');
  const plan = { catalogSha256, order, earlyIndexes };
  writeFileSync(new URL(`../apps/updater/src/snapshot-replay-plan${suffix}.mjs`, import.meta.url), '// Generated from the trusted catalog; rejects cycles and self references.\nexport const snapshotReplayPlan = ' + JSON.stringify(plan) + ';\n');
} finally { db.close(); }
