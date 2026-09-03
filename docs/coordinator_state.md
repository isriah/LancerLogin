# Coordinator Run State

This file is the durable state for a single active coordinator run. It is updated only by `$lancerlogin-coordinator`; do not implement product work from it.

## Active run

Status: active
Run: 2026-09-03-wu-019-031
Coordinator task: `01a065cb-bd5b-7992-b770-56d5191f4e59`
Mode: complete-all
Execution set: WU-019, WU-020, WU-021, WU-022, WU-023, WU-024, WU-025, WU-026, WU-027, WU-028, WU-029, WU-030, WU-031
Heartbeat: `lancerlogin-coordinator-checkpoints` (active, every five minutes)
Last checkpoint: WU-028 provisioning check 3/3 found no addressable task ID for client `client-new-thread:fd6ba36b-044c-4ebc-aee9-eb7fb259bce6`; its branch-owned Worktree remains at reviewable commit `b830b45` beyond base `fa72a71c7ca2850f4b89311d8626b917e5a95ba1`.
Next checkpoint: inspect, verify, and integrate recovered WU-028 commit `b830b45` if its focused checks pass.
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
