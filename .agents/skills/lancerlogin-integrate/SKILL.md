---
name: lancerlogin-integrate
description: "Review and serially merge one completed LancerLogin work-unit branch, then update the shared ledger. Use after an implementation task provides a commit handoff."
---

# LancerLogin Work-Unit Integration

Read `AGENTS.md`, `docs/WORKFLOW.md`, `docs/future_work.md`, and the selected WU before acting. Inspect the implementation handoff, its branch, commit, changed files, and verification. Read the relevant product documentation when the WU changes a high-risk surface.

Use this skill only for a named completed WU branch. Confirm that its scope, branch, and commit match the ledger and that no other active WU owns the same branch.

1. Inspect the branch diff against its recorded base and current `main`.
2. Run the WU's focused verification. If updating/rebasing against current `main` is safe and needed, do so, then repeat affected verification.
3. Review against the WU's acceptance criteria and repository safety rules.
4. Merge one branch only. Do not combine unrelated units in one integration.
5. Update the WU to `merged` with the merge commit and release impact, commit the ledger update, and archive the implementation task after its final evidence is recorded.

If the branch is missing, unverified, materially conflicting, or outside scope, do not merge. Preserve the branch and record the precise evidence as `blocked` or return the WU to `ready` when no implementation is present. Do not create replacement tasks automatically.

Never release, deploy, mutate cloud resources, or update the Pi as part of integration unless the user separately authorizes it.
