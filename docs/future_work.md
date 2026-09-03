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
7. After the coordinator has recorded a final outcome and captured the implementation task's handoff evidence, archive that implementation task. Archive merged tasks after integration; archive blocked or failed tasks only after their blocker or failure evidence is recorded and no follow-up is requested. Keep the coordinator, inbox, and any task that still needs a decision or integration work active. Archived tasks remain available for restoration and audit.

If work units cannot be cleanly isolated, run them serially instead. Planning, diagnosis, and review tasks may run in parallel without reserving a worktree as long as they do not write shared state.

### Authorized coordinator orchestration

When the user explicitly authorizes a named set of work units for an orchestration run, the coordination task may:

1. assess whether the units are safe to run in parallel, reserve the safe units, and commit the reservations to `main`;
2. create one Worktree implementation task per reserved unit, with its branch, scope, sources, verification, and safety boundaries in the task prompt;
3. wait for task completion, inspect each result, and collect commit SHA, changed-file, verification, and integration-risk evidence;
4. integrate safe completed branches serially, updating and re-verifying against current `main` before every merge; and
5. mark merged, blocked, or failed units in this file, report the outcome, and archive the corresponding implementation task once its final evidence is recorded and it has no remaining follow-up.

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
Release: v0.13.0 roster, scheduling, and kiosk operations.

### WU-006 — Member detail workspace and deep links

Status: merged (`6b62e61`)

Goal: give each roster member a durable, reusable operational workspace.
Scope: stable member route, links from Reports and other roster-oriented surfaces, permitted member actions, and per-meeting attendance history including timestamps or absence/excuse outcomes.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Roster); pending task commit `c983f27`.
Acceptance: a member can be opened from relevant product surfaces at a stable URL and the page accurately presents their complete attendance history.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and `npm run verify:migrations` if required.
Release: v0.13.0 roster, scheduling, and kiosk operations.

### WU-007 — Settings configuration information architecture

Status: merged (`53c2859`)

Goal: organize operational settings where administrators expect to find them.
Scope: move Discord contest settings and late-scan allowance into Settings > Configuration; reshape the kiosk update area to the installed-versus-latest comparison pattern; move dashboard access/role-grant controls into Settings.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Settings and updates).
Acceptance: each setting appears only in its intended Settings location, preserves its policy and permissions, and uses the requested update presentation.
Verification: `npm run verify:api` and `npm run verify:dashboard`.
Release: v0.13.0 roster, scheduling, and kiosk operations.

### WU-008 — Meeting duplication and templates

Status: merged (`cd9d6ce`)

Goal: reduce repeated meeting setup work.
Scope: duplicate an existing meeting or start from a reusable meeting template while preserving typical timing and recurrence choices.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Additional approved refinements).
Acceptance: an operator can create a correctly editable meeting from a chosen source without violating existing scheduling rules.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and `npm run verify:migrations` if storage changes.
Release: v0.13.0 roster, scheduling, and kiosk operations.

### WU-009 — Privacy-safe kiosk diagnostics snapshot

Status: merged (`d37c021`)

Goal: expose useful operational diagnostics without exposing sensitive device or member data.
Scope: software version, uptime, reader state, network type/signal, last Wi-Fi scan, pending queue count, and actionable recovery guidance; explicitly exclude credentials, raw scan data, and unrestricted logs.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Additional approved refinements); `docs/KIOSK.md` and `docs/SECURITY.md`.
Acceptance: authorized operators can diagnose the listed kiosk state with no secret, biometric, or raw-scanning data exposed.
Verification: `npm run verify:kiosk`, `npm run verify:api`, and focused security/sanitization tests.
Release: v0.13.0 roster, scheduling, and kiosk operations.

### WU-010 — Browser kiosk emulator foundation

Status: merged (`001af34`)

Goal: replace the limited setup simulator with a visibly simulated browser kiosk that reuses physical kiosk presentation and behavior.
Scope: establish the shared kiosk rendering/state contract, browser input adapter, simulator-origin audit labeling, and isolation from physical active-kiosk status. Later units will add all normal scanning, protected maintenance, enrollment/mapping, networking, and recovery/update flows.
Sources: `docs/feedback/2026-09-02-dashboard-follow-up.md` (Kiosk simulator); `docs/KIOSK.md`; `docs/ARCHITECTURE.md`.
Acceptance: the foundation renders the shared kiosk experience in the browser, records simulator-origin activity distinctly, and cannot act as or count as a physical kiosk.
Verification: `npm run verify:kiosk`, `npm run verify:dashboard`, and 800x480 browser smoke coverage.
Release: v0.13.0 roster, scheduling, and kiosk operations; requires follow-on work units before the full emulator is complete.

### WU-011 — Reports meeting-type correctness

Status: ready

Goal: make Reports meeting filters accurately represent every supported meeting type and consistently return matching data.
Scope: fix the empty result for “All meetings”; treat an unchecked existing “attendance required” setting as the first-class Optional meeting type in meeting creation/editing and Reports; exclude test meetings from Reports; correct the crowded member-name/ID presentation and sort-control overflow. No new meeting-type storage field or checkbox is introduced.
Sources: Codex task **WU Idea Inbox** (Reports and meeting-type items); `docs/DASHBOARD.md`; `docs/DECISIONS.md`.
Acceptance: operators can create or edit an Optional meeting using the existing setting, filter Reports by All, Regular, or Optional meetings, never see test meetings in Reports, and use the affected controls without overflow or cramped identity text.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and focused browser coverage for reports filters and responsive controls.
Release: likely next dashboard patch bundle (candidate 0.13.1).

### WU-012 — Member participation start dates

Status: in progress

Owner: Codex coordinator
Branch: codex/wu-012-member-start-dates
Base: 7d8f07685cc4242e40cd27a9a76e0446539664a8

Goal: ensure attendance reporting begins when each member joins the team rather than retroactively counting earlier meetings.
Scope: add an editable member start date, defaulted to the roster-added date; exclude meetings before that date from the member’s absence state, attendance calculations, and reports. Extend the merged member detail workspace; preserve historical meeting and attendance records.
Sources: Codex task **WU Idea Inbox** (member start date); `docs/DASHBOARD.md`; WU-006.
Acceptance: an authorized operator can view and change a member’s start date, and every relevant member/detail/report surface omits pre-start meetings from that member’s attendance obligations without deleting data.
Verification: `npm run verify:api`, `npm run verify:dashboard`, `npm run verify:migrations`, and focused tests for defaulting and reporting boundaries.
Release: likely next feature bundle (candidate 0.14.0).

### WU-013 — Future-meeting attendance semantics

Status: ready

Goal: prevent future meetings from presenting members as absent or generating premature absence notifications.
Scope: replace pre-start “Absent” states with a neutral muted state; suppress Discord absence notices until a meeting has started. Align dashboard status and notification eligibility without changing outcomes for current or past meetings.
Sources: Codex task **WU Idea Inbox** (future absence state and Discord notice); `docs/DECISIONS.md`; `docs/DASHBOARD.md`.
Acceptance: members are not labeled absent before a meeting starts, no Discord absence notice is sent for an unstarted meeting, and current/past meeting attendance behavior remains unchanged.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and focused notification/status tests.
Release: likely next dashboard patch bundle (candidate 0.13.1).

### WU-014 — Calendar-led attendance navigation

Status: ready

Goal: let operators reach the appropriate meeting workspace directly from calendar context.
Scope: show a Home-style calendar view above the Attendance meeting selector; route future calendar selections to the selected meeting’s Meetings view and in-progress or past selections to its Attendance view. Reuse existing meeting routing and calendar data where possible.
Sources: Codex task **WU Idea Inbox** (calendar selection and Attendance calendar); `docs/DASHBOARD.md`.
Acceptance: the Attendance page exposes a usable calendar above its selector, and selecting a meeting follows the approved future versus in-progress/past destination rule at desktop and mobile widths.
Verification: `npm run verify:dashboard` and focused browser route/responsive coverage.
Release: likely next dashboard patch bundle (candidate 0.13.1).

### WU-015 — Dashboard visual stability

Status: ready

Goal: eliminate visual jumps during navigation and keep the themed background visually calm across pages.
Scope: replace layout-shifting loading cards with animated overlays that do not displace page content; keep the primary-theme gradient stable while switching pages. Apply the loading treatment consistently to comparable dashboard loading states.
Sources: Codex task **WU Idea Inbox** (loading and gradient items); `docs/DASHBOARD.md`.
Acceptance: loading an affected page does not move its rendered layout, the overlay is visibly animated and accessible, and primary-theme gradients do not shift between dashboard routes.
Verification: `npm run verify:dashboard` and desktop/mobile browser visual smoke checks.
Release: likely next dashboard patch bundle (candidate 0.13.1).

### WU-016 — Dashboard card alignment refinement

Status: ready

Goal: make dashboard cards and controls consistently aligned and legible without changing product behavior.
Scope: perform a focused Data-page alignment/sizing pass; align shared card headers and status text vertically, including the Roster Members header/count; make Setup’s “Finish and return” a themed button; remove the displayed Active status from roster entries. Exclude functional workflow changes.
Sources: Codex task **WU Idea Inbox** (Data, card alignment, setup button, and roster Active items); `docs/DASHBOARD.md`.
Acceptance: affected cards use consistent vertical alignment at desktop and responsive widths, the Setup action is styled as a themed button, and roster entries no longer display the requested Active status.
Verification: `npm run verify:dashboard` and focused desktop/mobile visual checks.
Release: likely next dashboard patch bundle (candidate 0.13.1).

### WU-017 — Kiosk status-card presentation

Status: ready

Goal: make kiosk health state compact, readable, and centered in the Kiosks dashboard card.
Scope: replace the healthy status line with a vertically centered status pill/bubble and remove the Kiosks-page recovery-guidance text entirely. Preserve underlying kiosk diagnostics, status data, and authorized recovery actions.
Sources: Codex task **WU Idea Inbox** (Kiosks status and recovery text); WU-009; `docs/KIOSK.md`.
Acceptance: healthy state appears as a vertically centered bubble, recovery-guidance copy is absent from Kiosks, and kiosk state/actions remain available and accurate.
Verification: `npm run verify:dashboard` and focused browser visual coverage.
Release: likely next dashboard patch bundle (candidate 0.13.1).

### WU-018 — Kiosk Wi-Fi scan authorization repair

Status: merged (`d3ed914`)

Goal: allow an authorized local operator to rescan Wi-Fi networks after entering the kiosk settings PIN.
Scope: diagnose and repair the NetworkManager authorization path behind the local network-settings page; preserve PIN, rate-limit, credential, and least-privilege boundaries. Do not expose saved Wi-Fi credentials or broaden arbitrary system-command access.
Sources: Codex task **WU Idea Inbox** (NetworkManager rescan authorization failure); `docs/KIOSK.md`; `docs/SECURITY.md`.
Acceptance: after successful local PIN entry, a supported Pi can rescan Wi-Fi without the reported NetworkManager authorization error; unauthorized and locked-out requests remain denied; network secrets are never surfaced or logged.
Verification: `npm run verify:kiosk`, focused local-service authorization tests, and manual validation on the supported Pi.
Release: pending user-selected kiosk patch or feature bundle (candidate 0.13.1 or 0.14.0); supported-Pi validation remains required.

## Release bundling

- Release planning happens after units are merged. Create a release bundle from completed units that form a clear user-facing story and have compatible risk and deployment requirements.
- A production-blocking repair may justify a narrowly scoped `0.n.X` patch release. Otherwise, let completed units accumulate until the user chooses a release bundle.
- Before tagging, identify the included work units, update the matching `docs/releases/v0.n.n.md` notes, run the complete release gate, and follow the release procedure in `AGENTS.md`.
- A release or private-adopter deployment still requires explicit user authorization. Do not update the Pi unless the user specifically requests it.
