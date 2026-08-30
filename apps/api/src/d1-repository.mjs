export function createD1Repository(db, installationId) {
  if (!db?.prepare || !installationId) throw new Error("D1 binding and installation ID are required");
  return {
    async listMembers() {
      const result = await db.prepare("SELECT id, external_id AS externalId, first_name AS firstName, last_name AS lastName, email, active FROM members WHERE installation_id = ? ORDER BY last_name, first_name").bind(installationId).all();
      return result.results;
    },
    async insertMember(member) {
      await db.prepare("INSERT INTO members (id, installation_id, external_id, first_name, last_name, email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(member.id, installationId, member.externalId, member.firstName, member.lastName, member.email ?? null, member.createdAt).run();
    },
    async recordAudit(entry) {
      await db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(entry.id, installationId, entry.actorUserId ?? null, entry.action, entry.targetType, entry.targetId ?? null, JSON.stringify(entry.metadata ?? {}), entry.createdAt).run();
    },
  };
}
