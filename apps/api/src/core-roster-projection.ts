import type { D1Database } from "./d1-usage.ts";

/** Stable, installation-scoped Core projection for optional modules. */
export function listActiveRosterIdentities(db: D1Database, installationId: string) {
  return db.prepare("SELECT id,external_id AS externalId,first_name AS firstName,last_name AS lastName,email FROM members WHERE installation_id=? AND active=1 ORDER BY last_name,first_name,id LIMIT 500").bind(installationId).all<{ id: string; externalId: string; firstName: string; lastName: string; email: string | null }>();
}

export async function activeRosterIdentity(db: D1Database, installationId: string, memberId: string) {
  return db.prepare("SELECT id,external_id AS externalId,first_name AS firstName,last_name AS lastName,email FROM members WHERE installation_id=? AND id=? AND active=1").bind(installationId, memberId).first<{ id: string; externalId: string; firstName: string; lastName: string; email: string | null }>();
}
