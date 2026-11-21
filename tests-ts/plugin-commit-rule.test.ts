// The Update dialog's Commit change rule for incompatible modules matches the Worker's refuseIncompatible and its
// exemptions (apps/api/src/plugin-selection.ts): only a change that newly pins an incompatible commit is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { incompatibleCommitRefused, type CommitRuleReview, type CommitRuleState } from "../apps/dashboard/src/plugin-commit-rule.ts";

const source = "https://github.com/example/lancerlogin-carpool.git", fork = "https://github.com/example-fork/lancerlogin-carpool.git";
const running = "c".repeat(40), selected = "d".repeat(40), other = "e".repeat(40), sha = "1".repeat(40);
const state: CommitRuleState = { selection: { sha, modules: [{ id: "carpool", source, commit: selected }] }, installed: [{ id: "carpool", source, commit: running }, { id: "hour-tracking", source, commit: other }] };
const review = (overrides: Partial<CommitRuleReview>): CommitRuleReview => ({ action: "upgrade", id: "carpool", source, commit: other, selectionSha: sha, metadata: { state: "incompatible" }, ...overrides });

test("a compatible, undetermined or removal change is never refused for compatibility", () => {
  assert.equal(incompatibleCommitRefused(review({ metadata: { state: "compatible" } }), state), false);
  assert.equal(incompatibleCommitRefused(review({ metadata: { state: "unknown" } }), state), false, "the Worker checks unknown metadata at composition, not here");
  assert.equal(incompatibleCommitRefused(review({ action: "remove", source: null, commit: null, metadata: null }), state), false);
});

test("newly pinning an incompatible commit is refused", () => {
  assert.equal(incompatibleCommitRefused(review({}), state), true);
  assert.equal(incompatibleCommitRefused(review({ action: "add", id: "rideshare" }), state), true);
  // Another module's pins exempt nothing.
  assert.equal(incompatibleCommitRefused(review({ id: "rideshare", commit: running }), state), true);
  // The same commit from another source is a new pin.
  assert.equal(incompatibleCommitRefused(review({ source: fork, commit: selected }), state), true);
  assert.equal(incompatibleCommitRefused(review({ source: fork, commit: running }), state), true);
});

test("keeping the selected commit (a release track change) or the commit this build runs is accepted", () => {
  assert.equal(incompatibleCommitRefused(review({ commit: selected }), state), false, "track change on the selected pin");
  assert.equal(incompatibleCommitRefused(review({ commit: running }), state), false, "back to the running commit");
  // An included module with no selection entry: only the running pin exempts.
  const unpinned: CommitRuleState = { selection: { sha, modules: [] }, installed: state.installed };
  assert.equal(incompatibleCommitRefused(review({ commit: running }), unpinned), false);
  assert.equal(incompatibleCommitRefused(review({ commit: selected }), unpinned), true);
});

test("the selection exempts only when it is the selection the review read", () => {
  const stale = review({ commit: selected, selectionSha: "2".repeat(40) });
  assert.equal(incompatibleCommitRefused(stale, state), true, "a different selection may not pin that commit any more");
  assert.equal(incompatibleCommitRefused({ ...stale, commit: running }, state), false, "the running pin does not depend on the selection");
  assert.equal(incompatibleCommitRefused(review({ commit: selected }), { ...state, selection: null }), true);
});
