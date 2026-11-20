/** Every Discord role picker lists roles by name, ignoring case and accents. The API sorts too; this keeps pickers sorted for any source. */
export function sortDiscordRoles<T extends { name: string }>(roles: readonly T[]): T[] {
  return [...roles].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name));
}

/** A label's link to a Discord role, as far as its sync goes. A two-way link paused after a restore syncs nothing until reviewed. */
export type LabelRoleSync = { labelName: string; syncDirection?: "to_discord" | "two_way"; twoWayPaused?: boolean };
export const autoSyncText = "Two-way labels sync automatically every 5 minutes";
const syncsAutomatically = (mapping: Omit<LabelRoleSync, "labelName">) => mapping.syncDirection === "two_way" && !mapping.twoWayPaused;

/** Which of the named, linked labels sync on their own (two-way) and which wait for Sync to Discord. */
export function splitBySync(labels: readonly string[], mappings: readonly LabelRoleSync[]) {
  const twoWay = new Set(mappings.filter(syncsAutomatically).map((mapping) => mapping.labelName.toLocaleLowerCase()));
  return { automatic: labels.filter((name) => twoWay.has(name.toLocaleLowerCase())), manual: labels.filter((name) => !twoWay.has(name.toLocaleLowerCase())) };
}

/** How changes reach Discord for the linked labels: only by Sync to Discord, automatically (two-way), or some of each. */
export function linkedSyncText(mappings: readonly Omit<LabelRoleSync, "labelName">[]) {
  const automatic = mappings.filter(syncsAutomatically).length;
  if (!automatic) return "Label and pairing changes reach Discord only when you sync.";
  return automatic === mappings.length ? `${autoSyncText}, so their changes reach Discord without a manual sync.` : `${autoSyncText}. For the others, label and pairing changes reach Discord only when you sync.`;
}

/**
 * Whether "Discord users not on the roster" can list anyone: only a label that syncs both ways has its unmatched Discord
 * users recorded, at each 5-minute check. A Dashboard to Discord label, or a two-way one paused after a restore, has none.
 */
export const hasUnmatchedRoleList = (mappings: readonly Omit<LabelRoleSync, "labelName">[]) => mappings.some((mapping) => mapping.syncDirection === "two_way");
/** The count beside "Discord users not on the roster": every listed user, across the two-way labels. */
export const unmatchedRoleUserCount = (labels: readonly { users: readonly unknown[] }[]) => labels.reduce((sum, label) => sum + label.users.length, 0);

/** How often a running role sync is checked, and after how many failed checks in a row the page stops asking. */
export const roleJobPollMs = 4_000;
export const roleJobMaxFailures = 5;
/** Checks that found nothing new before the page slows down, for a sync that is waiting (a rate limit, paused delivery). */
export const roleJobIdleChecks = 10;
/**
 * The wait before the next check of a running role sync, or undefined to stop checking. Each failed check in a row
 * doubles the wait (4, 8, 16, 32 seconds); the fifth stops it. A sync that keeps answering without progress is checked
 * every 30 seconds instead of every 4.
 */
export function roleJobPollDelay(failures: number, idleChecks = 0): number | undefined {
  if (failures >= roleJobMaxFailures) return undefined;
  if (failures > 0) return Math.min(60_000, roleJobPollMs * 2 ** failures);
  return idleChecks >= roleJobIdleChecks ? 30_000 : roleJobPollMs;
}

/** A label's latest role sync as the role links list it, with its progress. */
export type RoleJobProgress = { status: string; createdAt?: string; updatedAt: string; total?: number; completed?: number; failed?: number };
/**
 * How long a pending or running role sync may go before the page calls it stuck: three of the scheduler's 5-minute
 * runs. A healthy sync changes several members a second, and a Discord rate limit pauses it for seconds, not minutes.
 */
export const roleJobStuckMs = 15 * 60_000;
/**
 * Whether a pending or running role sync looks stuck: started over 15 minutes ago and either no member has been
 * changed (or failed) at all, or the job itself has not been touched for 15 minutes.
 */
export function roleJobStuck(job: RoleJobProgress, now = Date.now()): boolean {
  if (!["pending", "running"].includes(job.status) || !job.createdAt) return false;
  const created = Date.parse(job.createdAt), updated = Date.parse(job.updatedAt);
  if (!(now - created > roleJobStuckMs)) return false;
  // Without counts (an API from before they were listed) only the job's last update can tell.
  const progress = job.total === undefined ? undefined : (job.completed ?? 0) + (job.failed ?? 0);
  return progress === 0 || now - updated > roleJobStuckMs;
}
