import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { validDate } from "./attendance-policy.ts";

/** Stable, installation-scoped Core projection for optional modules. */
export function listActiveRosterIdentities(db: D1Database, installationId: string) {
  return db.prepare("SELECT id,external_id AS externalId,first_name AS firstName,last_name AS lastName,email FROM members WHERE installation_id=? AND active=1 ORDER BY last_name,first_name,id LIMIT 500").bind(installationId).all<{ id: string; externalId: string; firstName: string; lastName: string; email: string | null }>();
}

export async function activeRosterIdentity(db: D1Database, installationId: string, memberId: string) {
  return db.prepare("SELECT id,external_id AS externalId,first_name AS firstName,last_name AS lastName,email FROM members WHERE installation_id=? AND id=? AND active=1").bind(installationId, memberId).first<{ id: string; externalId: string; firstName: string; lastName: string; email: string | null }>();
}

/** One dated label change with the label's name, in the order changes take effect (effective date, then creation, then id). */
export type NamedLabelChange = { memberId: string; labelId: string; labelName: string; action: "add" | "remove" };

/**
 * Core's label fold: replay each member's dated label changes in effective order and keep the labels still added.
 * Pass only changes effective on or before the date in question, ordered by effective_date, created_at, id.
 * Returns member ID to (label ID to label name).
 */
export function foldMemberLabels(changes: readonly NamedLabelChange[]): Map<string, Map<string, string>> {
  const labels = new Map<string, Map<string, string>>();
  for (const change of changes) {
    const current = labels.get(change.memberId) ?? new Map<string, string>();
    if (change.action === "add") current.set(change.labelId, change.labelName); else current.delete(change.labelId);
    labels.set(change.memberId, current);
  }
  return labels;
}

/** Label changes of the installation's active members effective on or before `localDate`, in Core's fold order. */
export function activeMemberLabelChangesStatement(db: D1Database, installationId: string, localDate: string) {
  return db.prepare(`SELECT c.member_id AS memberId,c.label_id AS labelId,l.name AS labelName,c.action FROM member_label_changes c
    JOIN member_labels l ON l.installation_id=c.installation_id AND l.id=c.label_id
    JOIN members m ON m.installation_id=c.installation_id AND m.id=c.member_id AND m.active=1
    WHERE c.installation_id=? AND c.effective_date<=? ORDER BY c.effective_date,c.created_at,c.id`).bind(installationId, localDate);
}

export type ActiveRosterMemberWithLabels = { id: string; externalId: string; firstName: string; lastName: string; email: string | null; discordUserId: string | null; labels: { id: string; name: string }[] };

/**
 * Active members (at most 500, like `listActiveRosterIdentities`) with the labels in effect on the organization-local
 * date `localDate` (YYYY-MM-DD), folded as member-level reports fold them. Labels are sorted by name. One D1 query.
 */
export async function listActiveRosterWithLabels(db: D1Database, installationId: string, localDate: string): Promise<ActiveRosterMemberWithLabels[]> {
  if (!validDate(localDate)) throw new HttpError(400, "localDate must be a YYYY-MM-DD date");
  const [members, changes] = await Promise.all([
    db.prepare("SELECT id,external_id AS externalId,first_name AS firstName,last_name AS lastName,email,discord_user_id AS discordUserId FROM members WHERE installation_id=? AND active=1 ORDER BY last_name,first_name,id LIMIT 500").bind(installationId).all<Omit<ActiveRosterMemberWithLabels, "labels">>(),
    activeMemberLabelChangesStatement(db, installationId, localDate).all<NamedLabelChange>(),
  ]);
  const folded = foldMemberLabels(changes.results ?? []);
  return (members.results ?? []).map((member) => ({
    ...member,
    labels: [...(folded.get(member.id) ?? new Map<string, string>())].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  }));
}
