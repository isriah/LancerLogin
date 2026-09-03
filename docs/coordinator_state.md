# Coordinator Run State

This file is the durable state for a single active coordinator run. It is updated only by `$lancerlogin-coordinator`; do not implement product work from it.

## Active run

Status: active
Run: 2026-09-03-wu-019-031
Coordinator task: `01a065cb-bd5b-7992-b770-56d5191f4e59`
Mode: complete-all
Execution set: WU-019, WU-020, WU-021, WU-022, WU-023, WU-024, WU-025, WU-026, WU-027, WU-028, WU-029, WU-030, WU-031
Heartbeat: `lancerlogin-coordinator-checkpoints` (active, every five minutes)
Last checkpoint: WU-028 provisioning check 1/3 found branch-owned Worktree `C:\\Users\\Izz\\.codex\\worktrees\\3b7e\\LancerLogin Workspace` and branch commit `b830b45`, but the task platform still exposed no addressable task ID for client `client-new-thread:fd6ba36b-044c-4ebc-aee9-eb7fb259bce6`.
Next checkpoint: make bounded WU-028 provisioning check 2/3; do not integrate before the provisioning deadline unless a task ID resolves.
User decision: none

## Checkpoint format

```md
Status: active | needs-user-decision | complete
Run: <stable run ID>
Coordinator task: <task ID>
Mode: orchestrate | complete-all
Execution set: <fixed WU IDs>
Heartbeat: <automation ID or pending>
Last checkpoint: <committed evidence>
Next checkpoint: <one material next action>
User decision: none | <one required decision>
```
