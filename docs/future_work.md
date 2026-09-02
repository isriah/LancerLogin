# Future Work

This file is LancerLogin's authoritative, organized list of planned work. It replaces a batch-oriented feedback queue.

## How to use this file

- Assemble observations, defects, feature requests, and documentation needs into logical, independently deliverable **work units**. The work unit—not a date or collection round—is the normal unit of development.
- A new Codex task should either name one work unit or ask for the outstanding units, then wait for the user to select one. Read the documentation named by that unit before making changes.
- Do not begin a unit merely because it appears here. Start it only when the user selects or explicitly authorizes it.
- Complete a selected unit through the relevant focused checks, documentation updates, commit, and merge to `main`. A merged unit does not imply a release, private deployment, or Pi update.
- Keep finished units as a short record with their merged commit or release reference. Remove obsolete detail only after it is preserved in issue history, release notes, or another durable record.

`docs/feedback/` remains a historical intake record for screenshots and raw observations. Move or synthesize actionable items into a work unit here; do not treat dated feedback files as the execution backlog.

## Work-unit format

Use one heading per unit. Keep it small enough to understand, implement, test, and merge with a coherent user-visible outcome. Large initiatives may have a parent heading and several independently selectable child units.

```md
## <ID> — <short outcome>

Status: ready | in progress | merged | blocked

Goal: <the user-visible outcome>
Scope: <included behavior and important exclusions>
Sources: <relevant docs, feedback files, screenshots, decisions, or code areas>
Acceptance: <observable completion criteria>
Verification: <focused commands and/or manual checks>
Release: <release candidate, later bundle, or no release impact yet>

For a parallel unit, also add:

Owner: <coordination task or assignee>
Branch: <branch name>
Base: <starting main commit>
```

## Selecting and completing work

- Prefer one work unit per development task. Combine units only when they share the same surface, dependencies, acceptance criteria, and focused verification; otherwise complete and merge them independently.
- Before implementation, inspect the work unit and its listed sources. Ask only when scope, security, or an irreversible product decision is materially unclear.
- During implementation, use the smallest relevant verification commands from `docs/DEVELOPMENT.md`. Run broader verification when the change crosses areas or when preparing a release.
- Update the unit's status and release field when it is merged. Preserve any unresolved follow-up as a new ready unit.

## Parallel work

Parallel development is permitted only for work units with no material overlap. Before reserving a unit, compare its scope and sources against every active unit. Do not run units in parallel when they touch the same feature surface, shared contract, migration/schema, authorization policy, deployment configuration, or shared documentation file.

1. A single coordination task owns `docs/future_work.md` and integration to `main`.
2. The coordination task records the selected unit as `in progress` with its owner, branch, and base commit, then commits that reservation to `main` before implementation tasks begin.
3. Start each implementation task in its own Codex **Worktree**, from that committed `main` state, on a branch named `codex/wu-<id>-<short-name>`.
4. An implementation task may edit only its selected unit's code, tests, and directly relevant documentation. It must not edit `docs/future_work.md`, merge, push directly to `main`, release, deploy, or update the Pi.
5. The implementation task commits its branch, runs focused verification, and reports its commit SHA, changed files, verification, and integration risks.
6. The coordination task integrates completed branches one at a time: update/rebase against current `main`, resolve any conflict, rerun affected verification, merge, and then update the work unit to `merged` with its merge and release-bundle reference.

If work units cannot be cleanly isolated, run them serially instead. Planning, diagnosis, and review tasks may run in parallel without reserving a worktree as long as they do not write shared state.

### Authorized coordinator orchestration

When the user explicitly authorizes a named set of work units for an orchestration run, the coordination task may:

1. assess whether the units are safe to run in parallel, reserve the safe units, and commit the reservations to `main`;
2. create one Worktree implementation task per reserved unit, with its branch, scope, sources, verification, and safety boundaries in the task prompt;
3. wait for task completion, inspect each result, and collect commit SHA, changed-file, verification, and integration-risk evidence;
4. integrate safe completed branches serially, updating and re-verifying against current `main` before every merge; and
5. mark merged, blocked, or failed units in this file and report the outcome.

The coordinator must leave a blocked, failed, or materially conflicting branch unmerged and preserve its evidence for follow-up. This authority never includes a release, push to a private adopter deployment, cloud-resource mutation, or Pi change; those remain subject to the explicit boundaries in `AGENTS.md`.

## Seeded work units

These units are synthesized from the pending work recorded by the **LancerLogin 0.9 Pickup** task and `docs/feedback/2026-09-02-dashboard-follow-up.md`. They exclude items already delivered in v0.12.6 or v0.12.7.

### WU-001 — Attendance action and status polish

Status: merged

Goal: make attendance actions concise, contextual, and free of misleading passive status.
Scope: optional manual-present notes; member-local success/failure feedback; remove the resolved contest audit card, kiosk meeting ID, and always-positive meeting-current card from Attendance.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Attendance).
Acceptance: the requested Attendance actions work without a note, report their result beside the member, and no longer show the listed obsolete or misleading UI.
Verification: `npm run verify:dashboard`; add focused dashboard coverage for changed behavior.
Release: v0.12.8 attendance reporting and dashboard operations refinement.

### WU-002 — Attendance metrics and reporting baseline

Status: merged (`07cfeaf`)

Goal: make attendance percentages understandable and prevent imported historical meetings from silently distorting current operational reporting.
Scope: define and display primary attendance rate and excuse-adjusted class rate; establish an explicit reporting baseline/period that preserves historical records without silently including them in current-roster reporting.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Attendance and Reports); pending task commit `4fdfbf6`.
Acceptance: every surface using both rates has clear labels and definitions; report percentages use an explicit, verified meeting scope.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and `npm run verify:migrations` if data selection/storage changes.
Release: v0.12.8 attendance reporting and dashboard operations refinement.

### WU-003 — Operational Reports workspace

Status: merged (`48da2b7`)

Goal: make Reports an operational workspace rather than primarily a CSV-export page.
Scope: sortable attendance leaderboard; team attendance trend; contests awaiting review with direct action; useful date, meeting-type, active-roster filters, and saved views.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Reports and Additional approved refinements).
Acceptance: operators can answer the requested attendance and contest questions in the dashboard, while CSV remains available as a secondary utility.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and browser coverage for charts/filters where appropriate.
Release: v0.12.8 attendance reporting and dashboard operations refinement.

### WU-004 — Dashboard layout consistency

Status: merged (`df03406`)

Goal: correct visible card and action layout defects without changing product behavior.
Scope: standardize dashboard card vertical padding; place the Reports contest card directly beneath the trend card independent of leaderboard height; restore styled side-by-side desktop roster actions.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Attendance, Reports, and Roster); pending task commits `ac33513` and `8621c2d`.
Acceptance: affected cards align with the standard gap and roster actions remain readable and consistently styled at desktop and responsive widths.
Verification: `npm run verify:dashboard` and relevant browser visual smoke checks.
Release: v0.12.8 attendance reporting and dashboard operations refinement.

### WU-005 — Roster discovery controls

Status: merged (`88310ad`)

Goal: make the roster quick to search and narrow during operations.
Scope: one search field that matches member name, email, and ID; Active-only and All-members filtering.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Roster).
Acceptance: both filter modes and every requested search field return the expected roster members without disrupting existing actions.
Verification: `npm run verify:dashboard`; add focused search/filter tests.
Release: later roster and reports bundle.

### WU-006 — Member detail workspace and deep links

Status: ready

Goal: give each roster member a durable, reusable operational workspace.
Scope: stable member route, links from Reports and other roster-oriented surfaces, permitted member actions, and per-meeting attendance history including timestamps or absence/excuse outcomes.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Roster); pending task commit `c983f27`.
Acceptance: a member can be opened from relevant product surfaces at a stable URL and the page accurately presents their complete attendance history.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and `npm run verify:migrations` if required.
Release: later roster and reports bundle.

### WU-007 — Settings configuration information architecture

Status: in progress

Owner: LancerLogin coordinator
Branch: `codex/wu-007-settings-ia`
Base: `f73d6df132297821acff51631e42d64e15bc40ba`

Goal: organize operational settings where administrators expect to find them.
Scope: move Discord contest settings and late-scan allowance into Settings > Configuration; reshape the kiosk update area to the installed-versus-latest comparison pattern; move dashboard access/role-grant controls into Settings.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Settings and updates).
Acceptance: each setting appears only in its intended Settings location, preserves its policy and permissions, and uses the requested update presentation.
Verification: `npm run verify:api` and `npm run verify:dashboard`.
Release: later settings and operations bundle.

### WU-008 — Meeting duplication and templates

Status: in progress

Owner: LancerLogin coordinator
Branch: `codex/wu-008-meeting-templates`
Base: `f73d6df132297821acff51631e42d64e15bc40ba`

Goal: reduce repeated meeting setup work.
Scope: duplicate an existing meeting or start from a reusable meeting template while preserving typical timing and recurrence choices.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Additional approved refinements).
Acceptance: an operator can create a correctly editable meeting from a chosen source without violating existing scheduling rules.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and `npm run verify:migrations` if storage changes.
Release: later scheduling bundle.

### WU-009 — Privacy-safe kiosk diagnostics snapshot

Status: in progress

Owner: LancerLogin coordinator
Branch: `codex/wu-009-kiosk-diagnostics`
Base: `f73d6df132297821acff51631e42d64e15bc40ba`

Goal: expose useful operational diagnostics without exposing sensitive device or member data.
Scope: software version, uptime, reader state, network type/signal, last Wi-Fi scan, pending queue count, and actionable recovery guidance; explicitly exclude credentials, raw scan data, and unrestricted logs.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Additional approved refinements); `docs/KIOSK.md` and `docs/SECURITY.md`.
Acceptance: authorized operators can diagnose the listed kiosk state with no secret, biometric, or raw-scanning data exposed.
Verification: `npm run verify:kiosk`, `npm run verify:api`, and focused security/sanitization tests.
Release: later kiosk operations bundle.

### WU-010 — Browser kiosk emulator foundation

Status: ready

Goal: replace the limited setup simulator with a visibly simulated browser kiosk that reuses physical kiosk presentation and behavior.
Scope: establish the shared kiosk rendering/state contract, browser input adapter, simulator-origin audit labeling, and isolation from physical active-kiosk status. Later units will add all normal scanning, protected maintenance, enrollment/mapping, networking, and recovery/update flows.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Kiosk simulator); `docs/KIOSK.md`; `docs/ARCHITECTURE.md`.
Acceptance: the foundation renders the shared kiosk experience in the browser, records simulator-origin activity distinctly, and cannot act as or count as a physical kiosk.
Verification: `npm run verify:kiosk`, `npm run verify:dashboard`, and 800x480 browser smoke coverage.
Release: later kiosk operations bundle; requires follow-on work units before the full emulator is complete.

## Release bundling

- Release planning happens after units are merged. Create a release bundle from completed units that form a clear user-facing story and have compatible risk and deployment requirements.
- A production-blocking repair may justify a narrowly scoped `0.n.X` patch release. Otherwise, let completed units accumulate until the user chooses a release bundle.
- Before tagging, identify the included work units, update the matching `docs/releases/v0.n.n.md` notes, run the complete release gate, and follow the release procedure in `AGENTS.md`.
- A release or private-adopter deployment still requires explicit user authorization. Do not update the Pi unless the user specifically requests it.
