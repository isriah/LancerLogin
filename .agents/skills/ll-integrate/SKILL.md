---
name: ll-integrate
description: "Review and serially merge completed LancerLogin work-unit branches or recorded detached candidates, then update the shared ledger. Use after implementation handoffs."
---

# LancerLogin Work-Unit Integration

Read `AGENTS.md`, `docs/WORKFLOW.md`, and `docs/future_work.md` before acting. Inspect the implementation handoff, its branch or recorded candidate commit, changed files, and verification. Read the relevant product documentation when the WU changes a high-risk surface.

## Batch modes

- **all**: Read-only. Inspect every `in progress` WU. A candidate is eligible for proposal when either its recorded branch has a commit beyond its base, or its ledger entry explicitly records a detached candidate commit and Worktree. For current/future detached Worktrees, only associate a commit automatically when its subject starts with that WU ID. Propose the safe serial merge order, focused verification, and excluded units; do not change files.
- **suggested**: Treat this as approval of the batch proposed by the immediately preceding `all` response in the same task. Re-read the ledger and revalidate every candidate. Integrate one proposed WU at a time using the procedure below. Stop at the first missing evidence, conflict, or failed verification; preserve remaining candidates and report the exact next action. Never start implementation tasks, release, deploy, or update the Pi.

For a named WU, confirm that its scope, branch or recorded detached candidate, and commit match the ledger and that no other active WU owns the same branch or candidate.

1. Inspect the branch or candidate-commit diff against its recorded base and current `main`.
2. Run the WU's focused verification. If updating/rebasing against current `main` is safe and needed, do so, then repeat affected verification.
3. Review against the WU's acceptance criteria and repository safety rules.
4. Merge one branch only. Do not combine unrelated units in one integration.
5. Update the WU to `merged` with the merge commit and release impact, commit the ledger update, and archive the implementation task after its final evidence is recorded.

If the branch/candidate is missing, unverified, materially conflicting, or outside scope, do not merge. Preserve it and record the precise evidence as `blocked` or return the WU to `ready` when no implementation is present. Do not create replacement tasks automatically.

Never release, deploy, mutate cloud resources, or update the Pi as part of integration unless the user separately authorizes it.
