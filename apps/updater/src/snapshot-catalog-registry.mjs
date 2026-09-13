import { snapshotCatalog as catalog47, catalogSha256 as digest47 } from './snapshot-catalog-47.mjs';
import { snapshotReplayPlan as plan47 } from './snapshot-replay-plan-47.mjs';
import { snapshotCatalog as catalog48, catalogSha256 as digest48 } from './snapshot-catalog-48.mjs';
import { snapshotReplayPlan as plan48 } from './snapshot-replay-plan-48.mjs';
import { snapshotCatalog as catalog49, catalogSha256 as digest49 } from './snapshot-catalog.mjs';
import { snapshotReplayPlan as plan49 } from './snapshot-replay-plan.mjs';
import { snapshotCatalog as catalog46, catalogSha256 as digest46 } from './snapshot-catalog-46.mjs';
import { snapshotReplayPlan as plan46 } from './snapshot-replay-plan-46.mjs';

// Constructor selection only. No snapshot-supplied catalog, SQL or import path.
export function selectSnapshotCatalog(key = 'schema-49-v1') {
  const selected = key === 'schema-49-v1' ? [catalog49, digest49, plan49] : key === 'schema-46-v1' ? [catalog46, digest46, plan46] : key === 'schema-47-v1' ? [catalog47, digest47, plan47] : key === 'schema-48-v1' ? [catalog48, digest48, plan48] : null;
  if (!selected) throw Error('snapshot-catalog-key');
  const [catalog, catalogSha256, plan] = selected;
  if (plan.catalogSha256 !== catalogSha256) throw Error('snapshot-catalog-plan');
  return structuredClone({ catalog, catalogSha256, plan });
}
