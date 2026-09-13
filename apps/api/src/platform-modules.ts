import { documentationAvailable, moduleAvailable } from '../../../packages/shared/src/release-capabilities.ts';
/** Complete schema-owned registry; release availability is separate from stored configuration. */
export const moduleRegistry = Object.freeze([
  { id: 'hour-tracking', dependencies: [], capabilities: ['hours.manage'], routes: ['/admin/hours', '/public/hours'], navigation: { label: 'Hour Tracking', path: '/hours' }, settings: ['hours'], jobs: ['hours.google-calendar', 'hours.discord-calendar'], backup: { scope: 'installation', includesExternalBinaries: false } },
  { id: 'activity-documentation', dependencies: ['hour-tracking'], capabilities: ['documentation.manage'], routes: ['/admin/documentation', '/public/documentation'], navigation: { label: 'Activity Documentation', path: '/documentation' }, settings: ['documentation'], jobs: ['documentation.intake', 'documentation.packet'], backup: { scope: 'installation', includesExternalBinaries: false } },
] as const);
type Result<T = unknown> = { results?: T[]; meta?: { changes?: number } };
interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<Result<T>>; run(): Promise<Result>; }
export interface ModuleDatabase { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<Result[]>; }
export class ModuleError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export type ModuleCapability = 'hours.manage' | 'documentation.manage';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validateModuleConfiguration(value: unknown): { enabled: string[]; revision: number } {
  if (!object(value) || Object.keys(value).some(k => !['enabled', 'revision'].includes(k)) || !Array.isArray(value.enabled) || value.enabled.length > 2 || value.enabled.some(id => !moduleRegistry.some(m => m.id === id)) || new Set(value.enabled).size !== value.enabled.length || !Number.isSafeInteger(value.revision) || (Number(value.revision) < 0 || Number(value.revision) >= Number.MAX_SAFE_INTEGER)) throw new ModuleError(400, 'Provide known enabled modules and the current revision');
  if (value.enabled.includes('activity-documentation') && !value.enabled.includes('hour-tracking')) throw new ModuleError(400, 'Activity Documentation requires Hour Tracking; disable both explicitly');
  return { enabled: value.enabled as string[], revision: Number(value.revision) };
}
export function validateModuleGrants(value: unknown): ModuleCapability[] {
  if (!object(value) || Object.keys(value).some(k => k !== 'capabilities') || !Array.isArray(value.capabilities) || value.capabilities.length > 2 || value.capabilities.some(c => !['hours.manage', 'documentation.manage'].includes(c)) || new Set(value.capabilities).size !== value.capabilities.length) throw new ModuleError(400, 'Provide known module capabilities');
  return value.capabilities as ModuleCapability[];
}
export async function moduleSnapshot(db: ModuleDatabase, installationId: string, userId: string) {
  // One statement gives a consistent view and reloads identity, grants and enablement.
  const row = await db.prepare(`SELECT u.role, COALESCE(c.hours_enabled,0) AS hours, COALESCE(c.documentation_enabled,0) AS documentation, COALESCE(c.revision,0) AS revision, COALESCE(g.hours_manage,0) AS hoursGrant, COALESCE(g.documentation_manage,0) AS documentationGrant FROM users u LEFT JOIN platform_module_configuration c ON c.installation_id=u.installation_id LEFT JOIN platform_module_grants g ON g.installation_id=u.installation_id AND g.user_id=u.id WHERE u.installation_id=? AND u.id=? AND u.active=1`).bind(installationId,userId).first<{role:string;hours:number;documentation:number;revision:number;hoursGrant:number;documentationGrant:number}>();
  if (!row) throw new ModuleError(401,'Session user is unavailable');
  const capabilities: ModuleCapability[] = [];
  if (row.hours && (row.role === 'admin' || row.hoursGrant)) capabilities.push('hours.manage');
  if (documentationAvailable && row.hours && row.documentation && (row.role === 'admin' || row.documentationGrant)) capabilities.push('documentation.manage');
  return { revision: row.revision, modules: moduleRegistry.filter(m=>moduleAvailable(m.id)).map(m => ({...m, enabled: m.id === 'hour-tracking' ? !!row.hours : !!row.hours && !!row.documentation})), capabilities };
}
export async function requireModuleCapability(db: ModuleDatabase, installationId: string, userId: string, capability: ModuleCapability) {
  const snapshot = await moduleSnapshot(db, installationId,userId);
  if (!snapshot.capabilities.includes(capability)) throw new ModuleError(403,'Module capability is unavailable');
  return snapshot;
}
/** Jobs have no staff principal; call again when executing each leased operation. */
export async function requireModuleEnabled(db: ModuleDatabase, installationId: string, moduleId: string) {
  if (!moduleAvailable(moduleId)) throw new ModuleError(409,'Module is unavailable in this release');
  if (!moduleRegistry.some(m => m.id === moduleId)) throw new ModuleError(400,'Unknown module');
  const row = await db.prepare('SELECT hours_enabled, documentation_enabled FROM platform_module_configuration WHERE installation_id=?').bind(installationId).first<{hours_enabled:number;documentation_enabled:number}>();
  if (!row?.hours_enabled || (moduleId === 'activity-documentation' && !row.documentation_enabled)) throw new ModuleError(409,'Module is disabled');
}
const adminPredicate = `EXISTS(SELECT 1 FROM users WHERE installation_id=? AND id=? AND active=1 AND role='admin')`;
function audit(db: ModuleDatabase, installationId: string, actor: string, action: string, target: string, metadata: unknown) {
  return db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,?,'platform_module',?,?,? WHERE changes()=1`).bind(crypto.randomUUID(),installationId,actor,action,target,JSON.stringify(metadata),new Date().toISOString());
}
export async function configureModules(db: ModuleDatabase, installationId: string, actor: string, input: unknown) {
  const config = validateModuleConfiguration(input);
  if(config.enabled.some(id=>!moduleAvailable(id)))throw new ModuleError(400,'Module is unavailable in this release');
  const results = await db.batch([
    db.prepare(`INSERT INTO platform_module_configuration(installation_id,hours_enabled,documentation_enabled,revision) SELECT ?,?,?,1 WHERE (?=0 OR EXISTS(SELECT 1 FROM platform_module_configuration WHERE installation_id=?)) AND ${adminPredicate} ON CONFLICT(installation_id) DO UPDATE SET hours_enabled=excluded.hours_enabled, documentation_enabled=excluded.documentation_enabled, revision=platform_module_configuration.revision+1 WHERE platform_module_configuration.revision=? AND ${adminPredicate}`).bind(installationId,Number(config.enabled.includes('hour-tracking')),Number(config.enabled.includes('activity-documentation')),config.revision,installationId,installationId,actor,config.revision,installationId,actor),
    audit(db,installationId,actor,'modules.configured',installationId,config),
  ]);
  // Audit admission uses SQL changes(), excluding publication-pause trigger rows.
  if (results[1]?.meta?.changes !== 1) throw new ModuleError(409,'Configuration changed or Admin access is unavailable; reload before retrying');
  return moduleSnapshot(db,installationId,actor);
}
export async function setModuleGrants(db: ModuleDatabase, installationId: string, actor: string, target: string, input: unknown) {
  if (!target || target.length > 128) throw new ModuleError(400,'Invalid staff identity');
  const capabilities = validateModuleGrants(input);
  if(!documentationAvailable&&capabilities.includes('documentation.manage'))throw new ModuleError(400,'Module is unavailable in this release');
  const results = await db.batch([
    db.prepare(`INSERT INTO platform_module_grants(installation_id,user_id,hours_manage,documentation_manage) SELECT ?,?,?,? WHERE ${adminPredicate} AND EXISTS(SELECT 1 FROM users WHERE installation_id=? AND id=? AND active=1) ON CONFLICT(installation_id,user_id) DO UPDATE SET hours_manage=excluded.hours_manage,documentation_manage=CASE WHEN ?=1 THEN excluded.documentation_manage ELSE platform_module_grants.documentation_manage END`).bind(installationId,target,Number(capabilities.includes('hours.manage')),Number(capabilities.includes('documentation.manage')),installationId,actor,installationId,target,Number(documentationAvailable)),
    audit(db,installationId,actor,'modules.grants_updated',target,{capabilities}),
  ]);
  if (results[0]?.meta?.changes !== 1) throw new ModuleError(409,'Active staff identity or Admin access is unavailable');
  return { userId: target, capabilities };
}
export function validateModuleBackup(tables: Record<string, Record<string,unknown>[]>) {
  const configs = tables.platform_module_configuration ?? [];
  if (configs.length > 1) throw new ModuleError(400,'Invalid module configuration backup');
  for (const row of configs) {
    if (row.installation_id !== 'primary' || ![0,1].includes(row.hours_enabled as number) || ![0,1].includes(row.documentation_enabled as number)) throw new ModuleError(400,'Invalid module configuration backup');
    validateModuleConfiguration({ enabled: [...(row.hours_enabled === 1 ? ['hour-tracking'] : []), ...(row.documentation_enabled === 1 ? ['activity-documentation'] : [])], revision: row.revision });
  }
  const seen = new Set();
  for (const row of tables.platform_module_grants ?? []) {
    if (row.installation_id !== 'primary' || typeof row.user_id !== 'string' || seen.has(row.user_id) || !tables.users.some(u => u.id === row.user_id && u.installation_id === 'primary') || ![0,1].includes(row.hours_manage as number) || ![0,1].includes(row.documentation_manage as number)) throw new ModuleError(400,'Invalid module grant backup');
    seen.add(row.user_id);
  }
}

export async function getModuleGrants(db: ModuleDatabase, installationId: string, actor: string, target: string) {
  if (!target || target.length > 128) throw new ModuleError(400,'Invalid staff identity');
  const row = await db.prepare(`SELECT COALESCE(g.hours_manage,0) AS hours,COALESCE(g.documentation_manage,0) AS documentation FROM users u LEFT JOIN platform_module_grants g ON g.installation_id=u.installation_id AND g.user_id=u.id WHERE u.installation_id=? AND u.id=? AND u.active=1 AND ${adminPredicate}`).bind(installationId,target,installationId,actor).first<{hours:number;documentation:number}>();
  if (!row) throw new ModuleError(404,'Active staff identity is unavailable');
  return { userId: target, capabilities: [...(row.hours ? ['hours.manage'] : []), ...(documentationAvailable&&row.documentation ? ['documentation.manage'] : [])] };
}
