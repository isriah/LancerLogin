---
name: ll-integrate
description: "Review and serially merge completed LancerLogin work-unit branches or recorded detached candidates, then update the shared ledger. Use after implementation handoffs."
---

# LancerLogin Work-Unit Integration

Read `AGENTS.md`, `docs/WORKFLOW.md`, and `docs/future_work.md` before acting. For a multi-WU goal, run integration in the goal-owning coordinator so its direct user authorization remains available; do not create a separate integration task or ask the user to repeat approval there. Inspect each implementation handoff, branch or recorded candidate commit, changed files, and verification. Read the relevant product documentation when a WU changes a high-risk surface.

## Invocation modes

- **preview all**: Read-only. Inspect every `in progress` WU. A candidate is eligible when either its recorded branch has a commit beyond its base, or its ledger entry explicitly records a detached candidate commit and Worktree. For current/future detached Worktrees, only associate a commit automatically when its subject starts with that WU ID. Report the safe serial merge order, focused verification, and excluded units; do not change files.
- **all**: Treat the invocation as explicit authorization to integrate every currently eligible candidate. Re-read the ledger, inspect every `in progress` WU using the `preview all` eligibility rules, and report the safe serial order, focused verification, and exclusions before starting. Then revalidate and integrate one eligible WU at a time using the procedure below. Stop at the first stale record, missing evidence, conflict, or failed verification; preserve the remaining candidates and report the exact next action. If no candidate is eligible, make no changes.
- **one or more named WU IDs**: Treat the invocation as authorization to integrate exactly those eligible candidates, serially in the stated order after checking dependencies and overlap. Exclude every unnamed candidate. Stop at the first invalid ID, stale record, missing evidence, conflict, or failed verification and preserve the remainder.
- **suggested**: Unsupported. Explain that `preview all` is the read-only assessment and `all` authorizes immediate batch integration; do not integrate anything for this invocation.

For each named WU, confirm that its scope, branch or recorded detached candidate, and commit match the ledger and that no other active WU owns the same branch or candidate.

1. Inspect the branch or candidate-commit diff against its recorded base and current `main`.
2. Confirm the branch's focused verification. If updating/rebasing against the integration branch is safe and needed, do so, then repeat affected verification.
3. Review against the WU's acceptance criteria and repository safety rules.
4. Merge one branch only. Do not combine unrelated units in one integration.
5. On the merged tree, rerun every affected area check and the combined browser suite when browser behavior or fixtures changed. Branch-local success is not sufficient evidence for the integrated tree.
6. Only after the merged-tree checks pass, update the WU to `merged` with the merge commit and release impact, commit the ledger update, and archive the implementation task after its final evidence is recorded.

If the branch/candidate is missing, unverified, materially conflicting, or outside scope, do not merge. If a post-merge check fails, keep the candidate and integration history recoverable, do not mark the WU merged, and diagnose whether the cause is product behavior, merge interaction, or test isolation. Record the precise evidence as `blocked` or return the WU to `ready` when no implementation is present. Do not create replacement tasks automatically.

Never release, deploy, mutate cloud resources, or update the Pi as part of integration unless the user separately authorizes it.
