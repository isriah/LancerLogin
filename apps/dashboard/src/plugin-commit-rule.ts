type Pin = { id: string; source: string; commit: string };
export type CommitRuleReview = { action: string; id: string; source: string | null; commit: string | null; selectionSha: string; metadata: { state: string } | null };
export type CommitRuleState = { selection: { sha: string; modules: Pin[] } | null; installed: Pin[] };

/**
 * Whether the Worker would refuse to commit a reviewed change because the module is incompatible, so the Update dialog
 * can disable Commit change exactly when the Worker would refuse it (refuseIncompatible and its exemptions in
 * apps/api/src/plugin-selection.ts). Only a change that newly pins an incompatible commit is refused: one whose source and
 * commit are those the selection already pins (a release track change), or those this build already runs, is accepted.
 * Removal is never refused for compatibility.
 *
 * The review's source and commit are the Worker's normalized values, and Settings > Modules carries both pins it compares
 * them with: `installed` is what this build runs, and `selection` the committed selection. The Worker compares with the
 * selection the review read (its selectionSha); the loaded one is that selection only when the two agree. When they do
 * not, the dashboard cannot tell, and leaves the refusal in place unless the running pin alone exempts the change.
 */
export function incompatibleCommitRefused(review: CommitRuleReview, state: CommitRuleState): boolean {
  if (review.action === "remove" || review.metadata?.state !== "incompatible") return false;
  const pinned = (entry: Pin | undefined) => Boolean(entry) && entry!.source === review.source && entry!.commit === review.commit;
  if (pinned(state.installed.find((entry) => entry.id === review.id))) return false;
  const selection = state.selection?.sha === review.selectionSha ? state.selection : null;
  return !pinned(selection?.modules.find((entry) => entry.id === review.id));
}
