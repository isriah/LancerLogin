# Future Work

This file is LancerLogin's authoritative, organized list of planned work. It replaces a batch-oriented feedback queue.

## How to use this file

- Assemble observations, defects, feature requests, and documentation needs into logical, independently deliverable **work units**. The work unit—not a date or collection round—is the normal unit of development.
- A new Codex task should either name one work unit or ask for the outstanding units, then wait for the user to select one. Read the documentation named by that unit before making changes.
- Do not begin a unit merely because it appears here. Start it only when the user selects or explicitly authorizes it.
- Complete a selected unit through the relevant focused checks, documentation updates, commit, and merge to `main`. A merged unit does not imply a release, private deployment, or Pi update.
- Keep finished units as a short record with their merged commit or release reference. Remove obsolete detail only after it is preserved in issue history, release notes, or another durable record.

`docs/idea_inbox.md` is the live, durable raw-intake record. Process its `untriaged` entries into work units here through `$ll-inbox-process`; do not treat it as an execution backlog. `docs/feedback/` remains a historical record for screenshots and prior observations.

For a compact active-state scan, use `rg -n "^### WU-|^Status:|^Dependencies:" docs/future_work.md` and inspect full entries only for active candidates. A request to list raw ideas reads only `docs/idea_inbox.md` and makes no changes.

## Work-unit format

Use one heading per unit. Keep it small enough to understand, implement, test, and merge with a coherent user-visible outcome. Large initiatives may have a parent heading and several independently selectable child units.

```md
## <ID> — <short outcome>

Status: ready | in progress | merged | blocked

Goal: <the user-visible outcome>
Dependencies: none | <WU IDs or exact decision>
Scope: <included behavior and important exclusions>
Sources: <relevant docs, feedback files, screenshots, decisions, or code areas>
Acceptance: <observable completion criteria>
Verification: <focused commands and/or manual checks>
Release: <release candidate, later bundle, or no release impact yet>

For a parallel unit, also add:

Owner: <coordination task or assignee>
Branch: <branch name>
Base: <starting main commit>
Worktree: <path>

For a detached recovery candidate, also add:

Candidate: <commit SHA>, <Worktree path>, and evidence tying it to this WU>
```

## Selecting and completing work

- Prefer one work unit per development task. Combine units only when they share the same surface, dependencies, acceptance criteria, and focused verification; otherwise complete and merge them independently.
- Before implementation, inspect the work unit and its listed sources. Ask only when scope, security, or an irreversible product decision is materially unclear.
- During implementation, use the smallest relevant verification commands from `docs/DEVELOPMENT.md`. Run broader verification when the change crosses areas or when preparing a release.
- Update the unit's status and release field when it is merged. Preserve any unresolved follow-up as a new ready unit.

## Parallel work

Parallel development is permitted only for work units with no material overlap. Compare scope and sources before starting: units that touch the same feature surface, shared component, API/data contract, migration/schema, authorization policy, deployment configuration, or shared documentation run serially.

For approved independent units, create one Codex Worktree and one `codex/wu-<id>-<short-name>` branch per implementation task from a committed base. Implementation tasks change only their selected unit's code, tests, and directly relevant documentation; they do not edit this ledger, merge, release, deploy, or update the Pi. Integrate completed branches one at a time and then update this ledger with merge and release-bundle evidence.

Implementation commits use the `WU-###:` prefix. If Codex produces a detached Worktree, retain it and record an explicit candidate commit/path; `$ll-integrate preview all` can propose it for review, and `$ll-integrate all` can include it in an authorized batch. Do not start a duplicate task for a WU with recorded branch, task, or candidate evidence.

Use `docs/WORKFLOW.md` for the operating procedure and recovery guidance. Do not use a persistent coordinator or scheduled heartbeat to provision, poll, or recover a backlog. Planning, diagnosis, and review may run in parallel when they do not write shared state.

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

Status: merged (`b7d8bb0`)

Goal: make Reports meeting filters accurately represent every supported meeting type and consistently return matching data.
Scope: fix the empty result for “All meetings”; treat an unchecked existing “attendance required” setting as the first-class Optional meeting type in meeting creation/editing and Reports; exclude test meetings from Reports; correct the crowded member-name/ID presentation and sort-control overflow. No new meeting-type storage field or checkbox is introduced.
Sources: Codex task **WU Idea Inbox** (Reports and meeting-type items); `docs/DASHBOARD.md`; `docs/DECISIONS.md`.
Acceptance: operators can create or edit an Optional meeting using the existing setting, filter Reports by All, Regular, or Optional meetings, never see test meetings in Reports, and use the affected controls without overflow or cramped identity text.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and focused browser coverage for reports filters and responsive controls.
Release: v0.13.1 dashboard and kiosk reliability refinement.

### WU-012 — Member participation start dates

Status: merged (`eb0a6a1`)

Goal: ensure attendance reporting begins when each member joins the team rather than retroactively counting earlier meetings.
Scope: add an editable member start date, defaulted to the roster-added date; exclude meetings before that date from the member’s absence state, attendance calculations, and reports. Extend the merged member detail workspace; preserve historical meeting and attendance records.
Sources: Codex task **WU Idea Inbox** (member start date); `docs/DASHBOARD.md`; WU-006.
Acceptance: an authorized operator can view and change a member’s start date, and every relevant member/detail/report surface omits pre-start meetings from that member’s attendance obligations without deleting data.
Verification: `npm run verify:api`, `npm run verify:dashboard`, `npm run verify:migrations`, and focused tests for defaulting and reporting boundaries.
Release: v0.13.1 dashboard and kiosk reliability refinement.

### WU-013 — Future-meeting attendance semantics

Status: merged (`20ac58d`)

Goal: prevent future meetings from presenting members as absent or generating premature absence notifications.
Scope: replace pre-start “Absent” states with a neutral muted state; suppress Discord absence notices until a meeting has started. Align dashboard status and notification eligibility without changing outcomes for current or past meetings.
Sources: Codex task **WU Idea Inbox** (future absence state and Discord notice); `docs/DECISIONS.md`; `docs/DASHBOARD.md`.
Acceptance: members are not labeled absent before a meeting starts, no Discord absence notice is sent for an unstarted meeting, and current/past meeting attendance behavior remains unchanged.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and focused notification/status tests.
Release: v0.13.1 dashboard and kiosk reliability refinement.

### WU-014 — Calendar-led attendance navigation

Status: merged (`0873345`)

Goal: let operators reach the appropriate meeting workspace directly from calendar context.
Scope: show a Home-style calendar view above the Attendance meeting selector; route future calendar selections to the selected meeting’s Meetings view and in-progress or past selections to its Attendance view. Reuse existing meeting routing and calendar data where possible.
Sources: Codex task **WU Idea Inbox** (calendar selection and Attendance calendar); `docs/DASHBOARD.md`.
Acceptance: the Attendance page exposes a usable calendar above its selector, and selecting a meeting follows the approved future versus in-progress/past destination rule at desktop and mobile widths.
Verification: `npm run verify:dashboard` and focused browser route/responsive coverage.
Release: v0.13.1 dashboard and kiosk reliability refinement.

### WU-015 — Dashboard visual stability

Status: merged (`53255da`)

Goal: eliminate visual jumps during navigation and keep the themed background visually calm across pages.
Scope: replace layout-shifting loading cards with animated overlays that do not displace page content; keep the primary-theme gradient stable while switching pages. Apply the loading treatment consistently to comparable dashboard loading states.
Sources: Codex task **WU Idea Inbox** (loading and gradient items); `docs/DASHBOARD.md`.
Acceptance: loading an affected page does not move its rendered layout, the overlay is visibly animated and accessible, and primary-theme gradients do not shift between dashboard routes.
Verification: `npm run verify:dashboard` and desktop/mobile browser visual smoke checks.
Release: v0.13.1 dashboard and kiosk reliability refinement.

### WU-016 — Dashboard card alignment refinement

Status: merged (`361c8c9`)

Owner: Codex coordinator
Branch: codex/wu-016-dashboard-card-alignment
Base: 2cf4e8443747ffd3fa01b88e2aa5df92b110f480
Task: provisioning client `client-new-thread:272fcb24-a2c4-42e5-8982-5ea7250fe253` (the task platform did not expose an addressable task ID for archival)

Goal: make dashboard cards and controls consistently aligned and legible without changing product behavior.
Scope: perform a focused Data-page alignment/sizing pass; align shared card headers and status text vertically, including the Roster Members header/count; make Setup’s “Finish and return” a themed button; remove the displayed Active status from roster entries. Exclude functional workflow changes.
Sources: Codex task **WU Idea Inbox** (Data, card alignment, setup button, and roster Active items); `docs/DASHBOARD.md`.
Acceptance: affected cards use consistent vertical alignment at desktop and responsive widths, the Setup action is styled as a themed button, and roster entries no longer display the requested Active status.
Verification: `npm run verify:dashboard` and focused desktop/mobile visual checks.
Release: v0.13.1 dashboard and kiosk reliability refinement.

### WU-017 — Kiosk status-card presentation

Status: merged (`653c78c`)

Owner: Codex coordinator
Branch: codex/wu-017-kiosk-status-card
Base: ef5376be0adaaac7e1e0e6af48c1362e35122efd
Task: provisioning client `client-new-thread:72feb7ed-b4b1-480a-90cc-f4cee9b7ebd0` (the task platform did not expose an addressable task ID for archival)

Goal: make kiosk health state compact, readable, and centered in the Kiosks dashboard card.
Scope: replace the healthy status line with a vertically centered status pill/bubble and remove the Kiosks-page recovery-guidance text entirely. Preserve underlying kiosk diagnostics, status data, and authorized recovery actions.
Sources: Codex task **WU Idea Inbox** (Kiosks status and recovery text); WU-009; `docs/KIOSK.md`.
Acceptance: healthy state appears as a vertically centered bubble, recovery-guidance copy is absent from Kiosks, and kiosk state/actions remain available and accurate.
Verification: `npm run verify:dashboard` and focused browser visual coverage.
Release: v0.13.1 dashboard and kiosk reliability refinement.

### WU-018 — Kiosk Wi-Fi scan authorization repair

Status: merged (`d3ed914`)

Goal: allow an authorized local operator to rescan Wi-Fi networks after entering the kiosk settings PIN.
Scope: diagnose and repair the NetworkManager authorization path behind the local network-settings page; preserve PIN, rate-limit, credential, and least-privilege boundaries. Do not expose saved Wi-Fi credentials or broaden arbitrary system-command access.
Sources: Codex task **WU Idea Inbox** (NetworkManager rescan authorization failure); `docs/KIOSK.md`; `docs/SECURITY.md`.
Acceptance: after successful local PIN entry, a supported Pi can rescan Wi-Fi without the reported NetworkManager authorization error; unauthorized and locked-out requests remain denied; network secrets are never surfaced or logged.
Verification: `npm run verify:kiosk`, focused local-service authorization tests, and manual validation on the supported Pi.
Release: v0.13.1 dashboard and kiosk reliability refinement; supported-Pi validation remains required.

### WU-019 — Contest-resolution feedback

Status: merged (`116b692`)

Owner: Codex coordinator
Branch: codex/wu-019-contest-resolution-feedback
Base: 5b0ee40a334cd2b03faf0f4c445248dfab14298a
Task: provisioning client `client-new-thread:48491ddf-d24d-4ae0-a561-8f0e5519bcb3`
Candidate: `14eb778817badd14236d971a8ddcfd1dff62b7ed` in detached Worktree `C:\\Users\\Izz\\.codex\\worktrees\\30d7\\LancerLogin Workspace`; commit subject and changed Reports/API/test files match this WU.

Goal: make contest review failures visible and actionable to an operator.
Scope: validate a required review reason before a contest resolution is submitted and present clear feedback if it is missing or a resolution fails. Preserve contest policy, audit history, and existing approval outcomes.
Sources: `docs/idea_inbox.md` (IN-019); `apps/dashboard/src/reports-page.tsx`; `apps/api/src/worker.mjs`.
Acceptance: an operator cannot accidentally leave a contest open without seeing why; valid resolutions retain their current behavior.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused contest-resolution coverage.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-020 — Meetings form presentation polish

Status: merged (`66937b1`)

Owner: Codex coordinator
Branch: codex/wu-020-meetings-form-polish
Base: 57018bddf9f9a7ded65746c5a886abe841172435
Task: provisioning client `client-new-thread:dbeac071-af1f-43a8-ab15-ce70b1a43861` (recovered from a branch-owned Worktree; the task platform did not expose an addressable task ID for archival)

Goal: make meeting creation and discovery controls clearer and visually consistent with the active theme.
Scope: remove the requested Optional-meeting tooltip; theme Meetings-page checkboxes; rename the search heading to “Search Meetings.” Exclude scheduling, recurrence, and attendance-policy changes.
Sources: `docs/idea_inbox.md` (IN-020, IN-026); `apps/dashboard/src/meetings-page.tsx`; `docs/DASHBOARD.md`.
Acceptance: the listed controls use the active theme and requested labels/copy, without changing meeting behavior.
Verification: `npm run verify:dashboard`; focused Meetings form and theme coverage.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-021 — Disable meeting templates

Status: merged (`e394ad7`)

Owner: Codex coordinator
Branch: codex/wu-021-disable-meeting-templates
Base: 93c7d5d204f6e7dafd5522bad59798c3683b2535
Task: provisioning client `client-new-thread:93e2161c-1ed9-4c0c-b7a0-17610f572ca3`
Candidate: `7ab804fc0304113695fc87eeeff0bf3468f6cefd` in detached Worktree `C:\\Users\\Izz\\.codex\\worktrees\\5331\\LancerLogin Workspace`; commit subject and changed meeting-template files match this WU.

Goal: remove meeting templates from the normal scheduling workflow.
Scope: disable template selection, creation, and use in product workflows while preserving existing stored template records. Exclude deletion or migration of stored templates and changes to meeting/recurrence behavior.
Sources: `docs/idea_inbox.md` (IN-021); WU-008; `apps/dashboard/src/meetings-page.tsx`; `apps/api/migrations/0017_meeting_templates.sql`.
Acceptance: operators cannot create or apply templates through the dashboard, and existing meetings remain unchanged.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and focused template-flow coverage.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-022 — Discord calendar-sync resilience

Status: merged (`527ad6a`)

Owner: Codex coordinator
Branch: codex/wu-022-discord-calendar-sync
Base: 7f7ad9c521dac435a10b3b47a669dbdbcdf13e05
Task: provisioning client `client-new-thread:0c7d865d-89d7-422e-b14a-c8286bad7a44` (the task platform did not expose an addressable task ID for archival)

Goal: make Discord bulk-event synchronization recover predictably from missing permissions and rate limits.
Scope: diagnose the reported 403 and 429 paths; provide actionable missing-permission feedback and compliant rate-limit/backoff handling. Exclude permission escalation, policy bypass, and unrelated Discord feature changes.
Sources: `docs/idea_inbox.md` (IN-022); `apps/api/src/integration-workflows.mjs`; `apps/api/src/worker.mjs`; `docs/DECISIONS.md`.
Acceptance: supported sync attempts distinguish configuration/permission failures from retryable rate limits, respect provider retry guidance, and expose no secrets.
Verification: `npm run verify:api`; mocked Discord 403/429 coverage; supported-server manual validation.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-023 — Dashboard update-flow polish

Status: merged (`c6b57d6`)

Owner: Codex coordinator
Branch: codex/wu-023-dashboard-update-flow
Base: 7f7ad9c521dac435a10b3b47a669dbdbcdf13e05
Task: provisioning client `client-new-thread:2fd59928-a555-41bf-8f30-bf647521693b` (the task platform did not expose an addressable task ID for archival)

Goal: make dashboard update actions easier to follow without weakening deployment safeguards.
Scope: align the dashboard update card with kiosk-update presentation; move its action into the first card; download backups without opening a blank tab; open GitHub in a new tab. Preserve backup-before-update and manual private-workflow authorization.
Sources: `docs/idea_inbox.md` (IN-023); `apps/dashboard/src/updates-page.tsx`; `docs/DASHBOARD.md`; `docs/BOOTSTRAPPING.md`.
Acceptance: the updated layout follows the requested navigation behavior and cannot dispatch deployment or bypass the backup requirement.
Verification: `npm run verify:dashboard`; focused browser checks for backup/download and external-link behavior.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-024 — Data-management action UX

Status: merged (`aabccf3`)

Owner: Codex coordinator
Branch: codex/wu-024-data-management-ux
Base: 7f7ad9c521dac435a10b3b47a669dbdbcdf13e05
Task: provisioning client `client-new-thread:8892b26c-bc72-48f9-a14a-e044a6d7993f` (the task platform did not expose an addressable task ID for archival)

Goal: make Data management compact and make restore/delete actions deliberate and understandable.
Scope: reduce the requested card height; style file selection; replace exposed file selectors and destructive controls with Restore/Delete buttons and validated confirmation modals; remove the requested guidance and reset-onboarding cards. Preserve category scope, warnings, and typed confirmations.
Sources: `docs/idea_inbox.md` (IN-024, IN-033); `apps/dashboard/src/data-settings.tsx`; `docs/BACKUP-RESTORE.md`; `docs/DECISIONS.md`.
Acceptance: restore and destructive actions remain explicitly confirmed and correctly scoped, while the listed UI clutter is absent.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused restore/delete confirmation coverage.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-025 — Guided-setup refinement

Status: merged (`8a94893`)

Owner: Codex coordinator
Branch: codex/wu-025-guided-setup-refinement
Base: 7f7ad9c521dac435a10b3b47a669dbdbcdf13e05
Task: provisioning client `client-new-thread:d44ecd97-dc5c-4862-9a5d-17a6fb5d378a` (the task platform did not expose an addressable task ID for archival)

Goal: make guided setup more compact and clearer about progress.
Scope: refine the listed logo/file, color, copy, spacing, and progress presentation; add a top percentage progress bar. Preserve persisted cross-admin setup state, accessibility, and setup-step behavior.
Sources: `docs/idea_inbox.md` (IN-025); `apps/dashboard/src/setup-workspace.tsx`; `docs/DASHBOARD.md`; `docs/DECISIONS.md`.
Acceptance: the requested redundant copy/status elements are absent, controls are styled consistently, and progress is clearly visible without changing setup completion semantics.
Verification: `npm run verify:dashboard`; focused guided-setup and responsive browser coverage.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-026 — Reports filter and selector reliability

Status: merged (`aa985b5`)

Goal: restore correct All-meetings reporting and keep leaderboard controls usable.
Scope: diagnose and repair the All-meetings regression; add regression coverage explaining the earlier verification gap; fix Attendance-leaderboard sort-selector overflow. Preserve reporting baseline and optional/regular semantics.
Sources: `docs/idea_inbox.md` (IN-027, IN-028); WU-011; `apps/dashboard/src/reports-page.tsx`; `docs/DASHBOARD.md`.
Acceptance: All, Regular, and Optional filters return their intended completed meetings, selector controls do not overflow at supported widths, and automated coverage catches the reported regression.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused report filter and responsive browser coverage.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-027 — Attendance calendar spacing

Status: merged (`ac5c478`)

Owner: Codex coordinator
Branch: codex/wu-027-attendance-calendar-spacing
Base: 57018bddf9f9a7ded65746c5a886abe841172435
Task: provisioning client `client-new-thread:2a03eff5-784f-41d9-afce-f52d3f3cee3c` (recovered from a branch-owned Worktree; the task platform did not expose an addressable task ID for archival)

Goal: restore comfortable separation between the Attendance calendar and its cards.
Scope: add the missing vertical spacing only. Exclude calendar routing, meeting selection, and attendance behavior changes.
Sources: `docs/idea_inbox.md` (IN-029); `apps/dashboard/src/attendance-workspace.tsx`; `apps/dashboard/src/styles.css`.
Acceptance: calendar and card surfaces have a consistent visible gap at desktop and mobile widths.
Verification: `npm run verify:dashboard`; focused responsive visual checks.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-028 — Roster control layout

Status: merged (`fc5fb04`)

Owner: Codex coordinator
Branch: codex/wu-028-roster-control-layout
Base: fa72a71c7ca2850f4b89311d8626b917e5a95ba1
Task: provisioning client `client-new-thread:fd6ba36b-044c-4ebc-aee9-eb7fb259bce6` (recovered from a branch-owned Worktree; the task platform did not expose an addressable task ID for archival)

Goal: keep roster rows compact and align the roster header controls.
Scope: arrange member action buttons horizontally where space allows with responsive fallback; vertically align the shown count and Add member action. Exclude roster permissions and member-action behavior changes.
Sources: `docs/idea_inbox.md` (IN-030, IN-031); `apps/dashboard/src/roster-page.tsx`; `apps/dashboard/src/styles.css`.
Acceptance: supported desktop rows are not unnecessarily tall, header controls align, and narrow layouts remain usable.
Verification: `npm run verify:dashboard`; focused desktop/mobile roster visual checks.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-029 — Compact dashboard-access controls

Status: merged (`4be60c0`)

Owner: Codex coordinator
Branch: codex/wu-029-compact-dashboard-access
Base: 93c7d5d204f6e7dafd5522bad59798c3683b2535
Task: provisioning client `client-new-thread:2c6de0aa-110e-49df-a0c1-c55a6d9d4740`
Candidate: `d46815146c46cd2ae6f0e9abbcf2a22139084857` in detached Worktree `C:\\Users\\Izz\\.codex\\worktrees\\00b3\\LancerLogin Workspace`; commit subject and changed dashboard-access files match this WU.

Goal: make Dashboard Access selection compact without losing its accessible role semantics.
Scope: replace oversized visual radio selectors with compact toggle-style controls while retaining keyboard operation, labels, selected-state communication, and authorization behavior.
Sources: `docs/idea_inbox.md` (IN-032); `apps/dashboard/src/roster-page.tsx`; `docs/DASHBOARD.md`; `docs/DECISIONS.md`.
Acceptance: access role selection is compact, keyboard-accessible, and produces the same saved role/access outcomes.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused access-control accessibility coverage.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-030 — Contest-review navigation and notification

Status: merged (`1925346`)

Goal: surface pending contests without making Reports their primary workspace.
Scope: remove the Reports pending-contests card; retain contest review on the relevant meeting page; add a dashboard-shell notifier modeled on update notifications. Preserve existing contest data and review outcomes.
Sources: `docs/idea_inbox.md` (IN-034); WU-003; WU-019; `apps/dashboard/src/reports-page.tsx`; `apps/dashboard/src/update-indicator.tsx`.
Acceptance: pending contests are discoverable from the shell and reviewable from their meeting, while Reports no longer contains the card.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused contest navigation/notification coverage.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-031 — Settings hierarchy and copy cleanup

Status: merged (`8255214`)

Owner: Codex coordinator
Branch: codex/wu-031-settings-hierarchy-cleanup
Base: fb46dae27718659a49eac8d390de5c91a1ae5ac8
Task: provisioning client `client-new-thread:0f533e7b-cb6e-42ec-8a1f-539cdfed645e` (recovered from a branch-owned Worktree; the task platform did not expose an addressable task ID for archival)

Goal: make Settings navigation clearer while removing the requested redundant helper copy.
Scope: remove the listed Configuration, Integrations, and Organization cards; show the parent Settings item with an active bubble while a subpage is selected. Exclude setting behavior, authorization, and secret-storage changes.
Sources: `docs/idea_inbox.md` (IN-035, IN-036, IN-037, IN-038); `apps/dashboard/src/app-shell.tsx`; `apps/dashboard/src/configuration-settings.tsx`; `apps/dashboard/src/integration-settings.tsx`; `apps/dashboard/src/organization-settings.tsx`.
Acceptance: the specified cards are absent and Settings/subpage navigation communicates hierarchy at desktop and responsive widths.
Verification: `npm run verify:dashboard`; focused settings-navigation accessibility and visual coverage.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-032 — Discord self-pairing and roster visibility

Status: merged (`d4a4143`)

Goal: let members safely pair their Discord account to the correct roster entry and let operators see that pairing in Roster.
Scope: add a signed Discord `/pair <member-id>` command that links the invoking Discord account to an active roster member; show paired Discord IDs as a conditional Roster column when Discord is configured. Reject requests that would replace an existing member or Discord-account pairing and direct the requester to an operator. Preserve existing operator/admin linking, attendance notices, contests, audit history, and all Discord verification boundaries. Exclude automatic roster matching, bulk relinking, and exposure of Discord credentials.
Sources: `docs/idea_inbox.md` (IN-039, IN-040); `docs/INTEGRATIONS.md`; `docs/DASHBOARD.md`; `docs/SECURITY.md`; `apps/api/src/index.ts`; `apps/dashboard/src/roster-page.tsx`.
Acceptance: after verified Discord setup, an unlinked active member can pair their own Discord account using their member ID; invalid, unknown, inactive, and already-linked IDs receive clear non-disclosing feedback; no `/pair` request can reassign an existing member or Discord account; Roster shows the paired Discord-ID column only while Discord is configured.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused signed Discord-command, pairing-collision, authorization, audit, and conditional-Roster-column coverage.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-033 — v0.14.0 release-gate repair

Status: merged

Goal: restore deterministic release verification for v0.14.0 without reducing browser or dependency-security coverage.
Scope: update browser smoke assertions to cover the intended contest-notification and Data-management confirmation flows; bound the registry-dependent high-severity dependency audit and make its failure output actionable. Preserve the high-severity audit as a required release gate. Exclude release tagging, publication, deployment, and Pi updates.
Sources: v0.14.0 release-blocker request; `tests-browser/dashboard-smoke.spec.ts`; `tests-browser/dashboard-mobile.spec.ts`; `.github/workflows/ci.yml`; `package.json`; `docs/DEVELOPMENT.md`.
Acceptance: browser smoke exercises the current contest and destructive-action workflows without stale expectations; a registry outage or stalled audit terminates predictably with diagnostic output; high-severity findings still fail Verify.
Verification: `npm run test:browser`; `npm run verify:release`; exact main-branch GitHub Verify workflow.
Release: v0.14.0 operations, scheduling, and Discord workflow refinement.

### WU-034 — Contest-review popup and context

Status: merged (`39de86f`)

Owner: Codex coordinator
Branch: `codex/wu-034-contest-review-popup`
Base: `d8fb5c809c22236724c52a9a6f7fac0cf40b0571`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\4ebd\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:b9e9c26b-183d-4c85-a3c1-2aad2443261a`

Goal: let operators review pending attendance contests from the top-right notifier with enough meeting and member context to act confidently.
Dependencies: none
Scope: make the contest notifier open an accessible popup containing the actionable contest list; show the meeting occurrence date with its name and place the member ID beside the member name in both the popup and Home contest view; refresh the shared notifier immediately after a contest is resolved from any supported view. Preserve review-reason validation, contest policy, audit history, and existing resolution outcomes. Exclude notification delivery and unrelated Reports changes.
Sources: `docs/idea_inbox.md` (IN-041, IN-048); WU-019; WU-030; `apps/dashboard/src/contest-indicator.tsx`; `apps/dashboard/src/home-page.tsx`; `apps/api/src/index.ts`; `docs/DASHBOARD.md`.
Acceptance: the notifier opens a keyboard-accessible contest popup; each item shows member name and ID together plus meeting name and occurrence date; valid contest actions complete from the popup and Home with clear success or failure feedback; the notifier count refreshes after every successful resolution and disappears when no open contests remain.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused browser coverage for popup accessibility, contest context, and resolution actions.
Release: v0.15.0 meeting detail, integration controls, and dashboard refinement.

### WU-035 — Shared dashboard route-state repair

Status: merged (`9bcf335`)

Owner: Codex coordinator
Branch: `codex/wu-035-shared-route-state` (requested; provisioning Worktree is currently detached)
Base: `4428c8c8fd73d68d43cb23764b7aa248ef830e6f`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\454a\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:cac6f042-9d0c-4707-8b0e-ec662ffc8b2a`
Candidate: `4ae815f614ad7333b90ec7f7632812390543ce96` in detached Worktree `C:\\Users\\Izz\\.codex\\worktrees\\454a\\LancerLogin Workspace`; commit subject and routing/test files match this WU.

Goal: make in-app member links render the member-detail page immediately instead of changing only the browser URL.
Dependencies: none
Scope: repair the shared dashboard routing state used by Roster and Reports member links, including browser-history behavior. Preserve direct deep links, authorization, unknown-route handling, and other dashboard navigation. Exclude member-detail content changes.
Sources: `docs/idea_inbox.md` (IN-042); WU-006; `apps/dashboard/src/router.tsx`; `apps/dashboard/src/app-shell.tsx`; `apps/dashboard/src/roster-page.tsx`; `apps/dashboard/src/reports-page.tsx`; `docs/DASHBOARD.md`.
Acceptance: clicking a member in Roster or Reports updates the URL and visible page in one action; Back/Forward and direct `/roster/[ID]` loads remain correct.
Verification: `npm run verify:dashboard`; focused browser coverage for Roster/Reports navigation, direct loads, and browser history.
Release: v0.15.0 meeting detail, integration controls, and dashboard refinement.

### WU-036 — Member-detail Discord identity

Status: merged (`e5cd88688bf1a4030cd6993711d51420ac8433d9`)

Owner: Codex coordinator
Branch: `codex/wu-036-member-discord-identity`
Base: `171c559d1e78c4ae64d32a989591c37e332784f4`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\ad73\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:7010c0b8-d022-4070-aa3f-d6bf26cf9be5`

Goal: show Discord linkage clearly on a member's detail page only while Discord integration is enabled.
Dependencies: WU-039
Scope: add the member's paired Discord ID to `/roster/[ID]` when Discord is enabled; show a muted unlinked-state bubble when enabled without a pairing; hide the field when Discord is disabled. Preserve pairing, access control, and credential secrecy. Exclude pairing or integration-configuration changes.
Sources: `docs/idea_inbox.md` (IN-043, IN-044); WU-032; WU-039; `apps/dashboard/src/member-detail-page.tsx`; `apps/api/src/index.ts`; `docs/DASHBOARD.md`; `docs/INTEGRATIONS.md`.
Acceptance: enabled Discord shows either the paired ID or an accessible muted unlinked state on member detail; disabled Discord shows neither; no secret integration values are returned.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused conditional member-detail and authorization coverage.
Release: v0.15.0 meeting detail, integration controls, and dashboard refinement.

### WU-037 — Attendance calendar selection repair

Status: blocked

Goal: make an Attendance calendar click select and display the intended current or past meeting.
Dependencies: WU-044 and WU-045 (the approved canonical meeting-detail and Dashboard-browser redesign supersedes this standalone Attendance-page repair; reassess only if that redesign is abandoned)
Scope: synchronize Attendance calendar selection, route query state, and the meeting selector for current and past meetings. Preserve future-meeting routing to Meetings, attendance actions, and meeting eligibility semantics. Exclude calendar layout and meeting-edit behavior.
Sources: `docs/idea_inbox.md` (IN-045); WU-014; `apps/dashboard/src/attendance-workspace.tsx`; `apps/dashboard/src/app-shell.tsx`; `apps/dashboard/src/router.tsx`; `docs/DASHBOARD.md`.
Acceptance: clicking a current or past calendar meeting updates the selected meeting, URL, and displayed attendance together; future meetings still route to Meetings; direct query links and selector changes remain usable.
Verification: `npm run verify:dashboard`; focused browser coverage for calendar selection, direct query loads, selector changes, and future-meeting routing.
Release: v0.14.1 dashboard navigation and integration refinement.

### WU-038 — Kiosks status-message cleanup

Status: merged (`18443fa`)

Owner: Codex coordinator
Branch: `codex/wu-038-kiosks-status-message-cleanup`
Base: `4428c8c8fd73d68d43cb23764b7aa248ef830e6f`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\c3df\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:15e7f1a8-a9c8-443e-9f23-1a524c45bf3f`

Goal: remove the redundant “Kiosk status is current.” message without hiding useful kiosk state or errors.
Dependencies: none
Scope: stop rendering the success message produced by a normal Kiosks status refresh while retaining loading, failure, action-result, device-health, and recovery feedback. Exclude kiosk API, hardware, pairing, and recovery behavior changes.
Sources: `docs/idea_inbox.md` (IN-046); WU-017; `apps/dashboard/src/kiosks-page.tsx`; `docs/KIOSK.md`.
Acceptance: a successful normal refresh does not render the named card; actionable kiosk status and operation feedback remain visible and accessible.
Verification: `npm run verify:dashboard`; focused Kiosks-page coverage for successful loading, failures, and action results.
Release: v0.15.0 meeting detail, integration controls, and dashboard refinement.

### WU-039 — Explicit integration enablement

Status: merged (`6278dde`)

Owner: Codex coordinator
Branch: `codex/wu-039-integration-enablement` (requested; provisioning Worktree is currently detached)
Base: `4428c8c8fd73d68d43cb23764b7aa248ef830e6f`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\7195\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:5a408630-54fc-40a4-88e3-8af0ff12824c`
Candidate: `f4c6cb4d5f2227d035a3a9c73c5b8466e94be27b` in detached Worktree `C:\\Users\\Izz\\.codex\\worktrees\\7195\\LancerLogin Workspace`; commit subject and migration/API/dashboard/test files match this WU.

Goal: let Admins deliberately enable optional integrations and keep disabled integrations compact and out of operational workflows.
Dependencies: none
Scope: add a persisted enable toggle for Google, Resend, and Discord; default new or unconfigured integrations off while preserving existing configured integrations as enabled during migration; gate configuration controls and provider-powered workflows on enabled state; list enabled integrations above disabled ones and render disabled integrations as condensed rows. Preserve encrypted credentials, verification requirements, Google sign-in safety, authorization, and audit history. Exclude new providers and credential-format changes.
Sources: `docs/idea_inbox.md` (IN-047); `apps/dashboard/src/integration-settings.tsx`; `apps/api/src/index.ts`; `apps/api/migrations/`; `docs/INTEGRATIONS.md`; `docs/SECURITY.md`; `docs/DASHBOARD.md`; `docs/DECISIONS.md`.
Acceptance: each provider has an accessible persisted enable toggle; disabled providers expose no configuration form or operational delivery; enabled entries sort first; existing configured providers remain enabled after migration; Google cannot be disabled when that would remove the installation's only usable sign-in method.
Verification: `npm run verify:migrations`, `npm run verify:api`, and `npm run verify:dashboard`; focused enable/disable, migration, provider-gating, Google lockout-prevention, sorting, and responsive accessibility coverage.
Release: v0.15.0 meeting detail, integration controls, and dashboard refinement.

### WU-040 — Theme toggle control

Status: merged (`c45e35a`)

Owner: Codex coordinator
Branch: `codex/wu-040-theme-toggle`
Base: `d8fb5c809c22236724c52a9a6f7fac0cf40b0571`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\768e\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:7d88a656-3bad-407d-b2e3-88843156ae76`

Goal: make light and dark appearance selection compact and immediately understandable.
Dependencies: none
Scope: replace the existing Light mode/Dark mode text button with an accessible toggle while preserving the saved theme choice, keyboard operation, and readable state communication. Exclude branding-color changes and new appearance modes.
Sources: `docs/idea_inbox.md` (IN-049); `apps/dashboard/src/main.tsx`; `apps/dashboard/src/styles.css`; `docs/DASHBOARD.md`.
Acceptance: the theme control presents and announces its current state as a toggle, works by keyboard and pointer, and preserves the existing saved light/dark outcome across reloads.
Verification: `npm run verify:dashboard`; focused keyboard and browser coverage for both theme states and persistence.
Release: v0.15.0 meeting detail, integration controls, and dashboard refinement.

### WU-041 — Reports selector clarity and spacing

Status: merged (`5165b3d1bad36dbb6d29b598c6ab7ccbac24690e`)

Owner: Codex coordinator
Branch: `codex/wu-041-reports-selector-clarity`
Base: `171c559d1e78c4ae64d32a989591c37e332784f4`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\de8b\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:84f36e78-e477-4df7-bc6b-7cbc294092f7`

Goal: keep Reports selectors legible and explain the operational reporting-period choice.
Dependencies: none
Scope: fix the clipped Attendance-leaderboard sort value; add sufficient right-side space around select arrows on the affected Reports controls; retain the operational-baseline versus preserved-history behavior and clearly explain when no baseline is configured. Exclude reporting calculations, baseline storage, and unrelated global form restyling.
Sources: `docs/idea_inbox.md` (IN-050, IN-051, IN-057); WU-002; WU-026; `apps/dashboard/src/reports-page.tsx`; `apps/dashboard/src/styles.css`; `tests-browser/dashboard-smoke.spec.ts`; `docs/DASHBOARD.md`.
Acceptance: every affected selector shows its selected value and arrow without clipping at supported widths; Reports explains that the operational-baseline option is available only when configured and otherwise clearly identifies preserved history as the active scope; existing report results remain unchanged.
Verification: `npm run verify:dashboard`; focused responsive browser geometry and reporting-period state coverage.
Release: v0.15.0 meeting detail, integration controls, and dashboard refinement.

### WU-042 — Roster table alignment and action placement

Status: merged (`d437605`)

Owner: Codex coordinator
Branch: `codex/wu-042-roster-table-alignment`
Base: `d8fb5c809c22236724c52a9a6f7fac0cf40b0571`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\6ab2\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:1b6c1737-c4c5-4a2a-b908-be245086164f`
Integration: branch merge `53f67cb`; verification-race correction `d437605`; `npm run verify:dashboard`, 20 repeated focused browser checks, and the 27-test full browser suite passed on `main`.

Goal: make roster rows scan cleanly and keep member actions in their intended column.
Dependencies: none
Scope: vertically center roster table headers and row values; place member actions in the right-side Actions column at supported desktop widths with a usable responsive fallback. Preserve member links, permissions, and action behavior.
Sources: `docs/idea_inbox.md` (IN-052, IN-053, IN-054); WU-028; `apps/dashboard/src/roster-page.tsx`; `apps/dashboard/src/styles.css`; `docs/DASHBOARD.md`.
Acceptance: roster headings and values align vertically, desktop actions appear on the right rather than beneath the identity block, and narrow layouts remain readable and operable.
Verification: `npm run verify:dashboard`; focused desktop and mobile roster browser coverage.
Release: v0.15.0 meeting detail, integration controls, and dashboard refinement.

### WU-043 — Kiosk information-card action consolidation

Status: merged (`4aad3ce`)

Owner: Codex coordinator
Branch: `codex/wu-043-kiosk-card-action`
Base: `d8fb5c809c22236724c52a9a6f7fac0cf40b0571`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\558b\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:ead5d842-47a0-4839-8eea-4a1013a40aa0`

Goal: place kiosk replacement where operators inspect the device being replaced.
Dependencies: none
Scope: move the Admin-only Add kiosk/Replace kiosk action from the page heading into the Physical kiosk information card. Preserve replacement confirmation, pairing, role restrictions, device state, and responsive behavior.
Sources: `docs/idea_inbox.md` (IN-056); WU-009; WU-038; `apps/dashboard/src/kiosks-page.tsx`; `apps/dashboard/src/styles.css`; `docs/KIOSK.md`.
Acceptance: authorized Admins find Add or Replace beside the physical kiosk information, Operators cannot access it, and the existing pairing/replacement workflow and warnings remain intact.
Verification: `npm run verify:dashboard`; focused Kiosks-page role, pairing-dialog, and responsive browser coverage.
Release: v0.15.0 meeting detail, integration controls, and dashboard refinement.

### WU-044 — Canonical meeting-detail workspace

Status: merged (`d47e9e2fde3b5421ced3170e7d473152daa2dd47`)

Owner: Codex coordinator
Branch: `codex/wu-044-meeting-detail-workspace`
Base: `171c559d1e78c4ae64d32a989591c37e332784f4`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\67e0\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:35c12d2f-7d14-4f7a-836f-7b34644d7da5`

Goal: give every meeting one durable detail route containing its operational context and attendance workflow.
Dependencies: none
Scope: add `/meetings/[ID]` with Back to Dashboard and meeting-switcher controls; show meeting timing, lifecycle state, Required/Optional status, recurrence, notes, and attendance closing time; move the existing attendance roster, corrections, excuses, manual status changes, clear actions, and member-local feedback into this page; add manual refresh and refresh attendance every 30 seconds only while its attendance window is open; redirect `/attendance?meetingId=[ID]` to the matching detail route and bare `/attendance` to Dashboard. Preserve authorization, attendance semantics, audit behavior, and unknown-meeting handling. Exclude meeting editing, Discord actions, contests, and the Dashboard browser redesign.
Sources: `docs/idea_inbox.md` (IN-059, IN-062); WU-014; WU-035; WU-037; `apps/dashboard/src/attendance-workspace.tsx`; `apps/dashboard/src/app-shell.tsx`; `apps/dashboard/src/router.tsx`; `apps/api/src/index.ts`; `docs/DASHBOARD.md`; `docs/ARCHITECTURE.md`.
Acceptance: direct and in-app `/meetings/[ID]` navigation renders the requested meeting summary and complete attendance workflow; legacy Attendance bookmarks land at the correct replacement; manual refresh works; automatic refresh runs only while attendance is open; Back/Forward, permissions, and member-local outcomes remain correct.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused browser coverage for direct routes, redirects, meeting switching, lifecycle states, attendance actions, refresh timing, and responsive accessibility.
Release: v0.15.0 meeting detail, integration controls, and dashboard refinement.

### WU-045 — Dashboard meeting browser and navigation

Status: merged (`9f20755`)

Owner: Codex coordinator
Branch: `codex/wu-045-dashboard-meeting-browser`
Base: `31808256cb9a2b8cc68f96e5520d8bfe983b8d34`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\48d9\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:7b52e569-87ee-4479-814e-5a5494988be1`
Candidate: `21d0fd3112cbf7122282c83be955353559510dea`; commit subject and dashboard navigation/test files match this WU.

Goal: make Dashboard the single place to browse and select meetings.
Dependencies: WU-044
Scope: rename Home to Dashboard while retaining `/dashboard`; remove Meetings and Attendance from primary navigation; present the existing five-week calendar by default with forward/backward navigation; add a remembered Calendar/Table view toggle; keep the meeting dropdown and Add meeting action available in both views; make calendar events, table rows, and dropdown choices open `/meetings/[ID]`; redirect `/meetings` to Dashboard table view. Preserve browser history, role access, meeting search, and supported responsive layouts. Exclude the create dialog, meeting management dialogs, Discord actions, contests, and displaced-utility cleanup.
Sources: `docs/idea_inbox.md` (IN-058, IN-059, IN-060); WU-035; WU-044; `apps/dashboard/src/home-page.tsx`; `apps/dashboard/src/meetings-page.tsx`; `apps/dashboard/src/app-shell.tsx`; `apps/dashboard/src/router.tsx`; `apps/dashboard/src/styles.css`; `docs/DASHBOARD.md`; `docs/ARCHITECTURE.md`.
Acceptance: Dashboard offers remembered Calendar and Table meeting browsers with consistent selector and Add meeting access; calendar navigation changes the visible date range; every meeting selection opens its canonical detail route; primary navigation and legacy `/meetings` behavior match the approved design.
Verification: `npm run verify:dashboard`; focused desktop/mobile browser coverage for view persistence, calendar navigation, table search, selection routes, redirects, and Back/Forward behavior.
Release: v0.16.0 Dashboard meeting-browser and update reliability release.

### WU-046 — Dashboard meeting-creation dialog

Status: merged (`747b956`)

Owner: Codex coordinator
Branch: `codex/wu-046-dashboard-meeting-creation-dialog`
Base: `d1577c807e711dc3091a168359f1a117a9260c42`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\9dd5\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:4b9c0c9a-3725-4a8f-8e4d-2454849d37b0`
Integration: feature candidate `17b314e` was merged as `6e13780`; corrective candidate `ddeb281` was merged as `747b956`. On the corrected merged tree, `npm run verify:api`, `npm run verify:dashboard`, `npm run verify:kiosk`, and the 44-test full browser suite passed.

Goal: create meetings without leaving the active Dashboard meeting browser.
Dependencies: WU-045
Scope: move the existing creation fields into an accessible dialog opened from the Dashboard meeting-browser header; preserve one-time and recurring creation, validation, duplication support, and best-effort Discord calendar sync; after success close the dialog, refresh both active browser view and meeting selector, and announce the created count without navigation. Exclude edit/delete management and changes to recurrence or Discord policy.
Sources: `docs/idea_inbox.md` (IN-061); WU-008; WU-020; WU-045; `apps/dashboard/src/meetings-page.tsx`; `apps/dashboard/src/modal-focus.ts`; `apps/dashboard/src/styles.css`; `apps/api/src/index.ts`; `docs/DASHBOARD.md`.
Acceptance: keyboard and pointer users can open, complete, cancel, and recover validation errors in the dialog; successful one-time or recurring creation closes it, announces the correct count, and updates the currently selected Dashboard view and selector without changing routes.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused browser coverage for dialog focus, validation, duplication, recurrence, Discord-sync outcomes, refresh, and responsive layout.
Release: v0.17.0 Dashboard meeting creation and kiosk version visibility.

### WU-047 — Meeting-detail Discord and contest operations

Status: merged (`6644a8a`)

Owner: Codex task
Branch: `codex/wu-047-meeting-detail-discord-contests` (requested; provisioning Worktree)
Base: `bb9ecca51a4531ec4ed33efd345e46ca7f293877`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\9227\\LancerLogin Workspace` (detached)
Task: `01a06b96-69d0-7be1-877b-c2efc817c9f0`
Candidate: `45bae194be479cd29ccf4b37b08b783aba3eadbf`; commit subject and API/dashboard/documentation/test files match this WU.
Integration: candidate `45bae194be479cd29ccf4b37b08b783aba3eadbf` was merged as `6644a8a`; on the merged tree, `npm run verify:api`, `npm run verify:dashboard`, `npm run verify:docs`, the focused Data-dialog rerun, and the 47-test full browser suite passed.

Goal: keep meeting-specific Discord and contest actions on the meeting they affect.
Dependencies: WU-034, WU-039, and WU-044
Scope: place eligible Discord calendar sync, absence notification, and contest review on `/meetings/[ID]`; hide Discord actions unless Discord is enabled and verified; allow calendar sync through scheduled meeting end and mute it afterward; mute absence notification before scheduled start and allow it from start onward; retain the top-right notifier for all open contests. Preserve signed-provider boundaries, review reasons, contest outcomes, and audit history. Exclude global Discord configuration and non-meeting utility relocation.
Sources: `docs/idea_inbox.md` (IN-063); WU-022; WU-030; WU-034; WU-039; WU-044; `apps/dashboard/src/meetings-page.tsx`; `apps/dashboard/src/attendance-workspace.tsx`; `apps/dashboard/src/contest-indicator.tsx`; `apps/api/src/index.ts`; `docs/INTEGRATIONS.md`; `docs/DASHBOARD.md`; `docs/SECURITY.md`.
Acceptance: verified enabled Discord exposes only time-eligible meeting actions; disabled or unverified Discord exposes none; meeting contests are reviewable with existing validation and audit behavior; the global notifier still reaches all pending contests and refreshes after resolution.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused authorization, provider-state, timing-boundary, contest-resolution, notifier, and browser coverage.
Release: v0.18.0 meeting operations and kiosk feedback.

### WU-048 — Split meeting management by scope

Status: merged (`7131f53`)

Owner: Codex task
Branch: `codex/wu-048-split-meeting-management`
Base: `48e07f97df38fa3c00f2caa4ed61be3d05eeb84e`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\1f49\\LancerLogin Workspace`
Task: `01a06ba8-6e00-7490-8405-2297d6640890`
Candidate: `e71e936ac88660279fe5ea524206697850fdd698`; commit subject and API/dashboard/documentation/test files match this WU.
Integration: reviewed and merged as `7131f53`; combined `verify:api`, `verify:dashboard`, and `verify:docs` passed, then the obsolete mobile row-action assertion was updated to the retained selection contract; its focused rerun and the clean full browser suite passed (51/51).

Goal: put single-meeting management on meeting detail while retaining bulk operations in Dashboard Table view.
Dependencies: WU-044 and WU-045
Scope: move Edit, Duplicate, and Delete to `/meetings/[ID]` in focused accessible dialogs; preserve occurrence-versus-future-series behavior; after deletion return to Dashboard with existing Undo capability; retain search, selection checkboxes, bulk delete, and Sync all to Discord in Dashboard Table view; prevent row navigation from toggling or disrupting checkbox selection. Exclude meeting creation and Discord policy changes.
Sources: `docs/idea_inbox.md` (IN-064); WU-008; WU-021; WU-044; WU-045; `apps/dashboard/src/meetings-page.tsx`; `apps/dashboard/src/modal-focus.ts`; `apps/dashboard/src/styles.css`; `apps/api/src/index.ts`; `docs/DASHBOARD.md`.
Acceptance: detail-page dialogs correctly manage an occurrence or its future series; successful deletion returns to Dashboard and can be undone; table bulk selection and row navigation remain independent; search, bulk delete, and Sync all retain their outcomes.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused recurrence-scope, deletion/Undo, dialog accessibility, checkbox isolation, bulk action, and browser coverage.
Release: v0.18.0 meeting operations and kiosk feedback.

### WU-049 — Consolidate displaced meeting utilities

Status: merged (`b6c560d`)

Owner: Codex task
Branch: `codex/wu-049-displaced-meeting-utilities` (requested; provisioning Worktree)
Base: `48e07f97df38fa3c00f2caa4ed61be3d05eeb84e`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\edd5\\LancerLogin Workspace` (detached)
Task: `01a06ba8-7f31-7780-bbed-1ea8fb19b335`
Candidate: `fe2c1ba95b1a7715be1aec29a899403723dc882e`; reconciled directly onto the integrated WU-048 tree and supersedes `081c6d25d44039af07167d00f329b33bdd56ca3a`.
Integration: reviewed and merged as `b6c560d`; combined `verify:api`, `verify:dashboard`, and `verify:docs` passed, then the obsolete Dashboard contest-section assertion was updated to the retained global-notifier contract; its focused rerun and the clean full browser suite passed (54/54).

Goal: give utilities displaced by the Dashboard redesign one clear, non-duplicated home.
Dependencies: WU-044, WU-045, and WU-047
Scope: retain attendance CSV export in Reports; move persistent Discord kiosk-status sync beside physical health information on Kiosks and gate it on enabled-and-verified Discord; rely on each meeting detail for its live roster; remove the duplicate Dashboard contest list only after meeting-detail review and the refreshed global notifier are available. Preserve authorization, provider verification, kiosk health behavior, exports, and contest access. Exclude new Discord capabilities and report redesign.
Sources: `docs/idea_inbox.md` (IN-065); WU-030; WU-039; WU-044; WU-045; WU-047; `apps/dashboard/src/home-page.tsx`; `apps/dashboard/src/attendance-workspace.tsx`; `apps/dashboard/src/reports-page.tsx`; `apps/dashboard/src/kiosks-page.tsx`; `apps/api/src/index.ts`; `docs/DASHBOARD.md`; `docs/KIOSK.md`; `docs/INTEGRATIONS.md`.
Acceptance: CSV export remains in Reports; authorized kiosk-status sync appears on Kiosks only when Discord is enabled and verified; Dashboard no longer duplicates live-roster or contest content; meeting detail and the global notifier remain complete replacement paths.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused Reports export, Kiosks integration gating, contest-access, navigation, and combined browser coverage.
Release: v0.18.0 meeting operations and kiosk feedback.

### WU-050 — Updates-page latency and degraded loading

Status: merged (`d379e9e`)

Owner: Codex task
Branch: `codex/wu-050-updates-page-latency`
Base: `75e9f9c9ceb10d8697ffc79f36326c5a97b1f224`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\wu050\\LancerLogin Workspace`
Task: `01a06b0c-a678-7c43-9062-ddd2d7b90adf`
Candidate: `d2f4ec1230aa05b34f4e67e690fbeeccb89f5303`; commit subject and Updates page/test files match this WU.

Goal: make the Updates settings page usable promptly when the public release feed is slow or unavailable.
Dependencies: none
Scope: bound the external release-check latency; prevent overlapping periodic refreshes; render locally available installation and kiosk update information independently of the public GitHub release response; and present an actionable degraded state when the latest release cannot be determined. Preserve the required pre-update backup, guarded private-workflow handoff, kiosk updater behavior, update authorization, and credential boundaries. Exclude deployment automation, release-selection changes, and new update capabilities.
Sources: `docs/idea_inbox.md` (IN-066, IN-067); WU-023; `apps/dashboard/src/updates-page.tsx`; `apps/dashboard/src/update-indicator.tsx`; `apps/dashboard/src/dashboard-api.ts`; `docs/DASHBOARD.md`; `docs/BOOTSTRAPPING.md`.
Acceptance: `/settings/updates` exits its loading overlay within a defined bounded interval even when the public release feed stalls; locally available installed-version, workflow, and kiosk information remains usable when the feed fails; the unavailable latest-release state is clear; periodic retries cannot accumulate concurrently; and successful update flows retain their current safeguards and outcomes.
Verification: `npm run verify:dashboard`; focused mocked slow, unavailable, and recovered release-feed coverage; browser coverage for bounded loading, degraded local information, and non-overlapping refresh behavior.
Release: v0.16.0 Dashboard meeting-browser and update reliability release.

### WU-051 — Kiosk release-version footer

Status: merged (`4911370`)

Owner: Codex coordinator
Branch: `codex/wu-051-kiosk-release-version-footer`
Base: `d1577c807e711dc3091a168359f1a117a9260c42`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\5c7c\\LancerLogin Workspace`
Task: provisioning client `client-new-thread:0a148572-a8a9-4e21-b6a1-a54e6bff4b98`
Integration: candidate `232547d` was merged as `4911370`; shared WU-046 corrective candidate `ddeb281` was merged as `747b956`. On the corrected merged tree, `npm run verify:kiosk` and the 44-test full browser suite passed.

Goal: show the running kiosk software version on the physical attendance interface while keeping reader failures visible.
Dependencies: none
Scope: expose the local `LANCERLOGIN_VERSION` through the loopback-only display-state response and replace the successful `Fingerprint reader online` footer copy with that version. Retain an explicit reader-offline warning, queue count, uptime, pairing behavior, and the dashboard heartbeat version. Exclude version selection, update behavior, dashboard Kiosks-page changes, and new diagnostic details.
Sources: `docs/idea_inbox.md` (IN-068); `apps/kiosk/src/service.mjs`; `apps/kiosk/src/ui.mjs`; `tests/kiosk-runtime.test.mjs`; `docs/KIOSK.md`.
Acceptance: a paired physical kiosk displays its running release version in the footer when the reader is online; development and missing-version states use a clear safe fallback; a reader failure still replaces the version text with the existing offline warning; no credential, biometric, or additional host detail is exposed.
Verification: `npm run verify:kiosk`; focused display-state and kiosk-rendering coverage for release, development/fallback, and reader-offline states.
Release: v0.17.0 Dashboard meeting creation and kiosk version visibility.

### WU-052 — Kiosk scan and offline visual feedback

Status: merged (`935640d`)

Owner: Codex task
Branch: `codex/wu-052-kiosk-scan-feedback` (requested; provisioning Worktree)
Base: `bb9ecca51a4531ec4ed33efd345e46ca7f293877`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\3dd2\\LancerLogin Workspace` (detached)
Task: `01a06b96-7800-7b51-af9b-502dd452c8bb`
Candidate: `2cfb0d7f90d9bc83e2f9b4c5126fc19bc5bae991`; commit subject and kiosk presentation/test files match this WU.
Integration: candidate `2cfb0d7f90d9bc83e2f9b4c5126fc19bc5bae991` was merged as `935640d`; on the combined WU-047/WU-052 tree, `npm run verify:kiosk` and the 49-test full browser suite passed.

Goal: make scan processing, duplicate attendance, and offline outcomes immediately recognizable from the physical kiosk screen.
Dependencies: none
Scope: add a blue full-screen gradient sweep during the processing state; flash purple for the duplicate state; use green feedback for a recognized scan saved for later sync and red for an unrecognized or rejected scan while offline; and pulse the network-connectivity icon whenever cloud connectivity is unavailable. Preserve the existing semantic display-state contract, text feedback, queue ordering, R503 aura behavior, debounce, organization theming, and `prefers-reduced-motion` handling. Exclude sensor-protocol changes, new attendance outcomes, network-setting changes, and browser-simulator expansion.
Sources: `docs/idea_inbox.md` (IN-069, IN-070, IN-071); `apps/kiosk/src/kiosk-presentation.mjs`; `apps/kiosk/src/kiosk-states.mjs`; `apps/kiosk/src/scanner.mjs`; `apps/kiosk/src/ui.mjs`; `tests/kiosk-runtime.test.mjs`; `tests/fixtures/kiosk-preview-server.mjs`; `docs/KIOSK.md`.
Acceptance: processing produces a bounded blue sweep; duplicate attendance produces a bounded purple flash; offline recognized and unrecognized/rejected outcomes remain textually distinct and use green and red feedback respectively; the connectivity icon pulses only while offline; all motion has a clear reduced-motion fallback; existing state durations and attendance outcomes remain correct.
Verification: `npm run verify:kiosk`; focused state-contract and CSS assertions plus physical-kiosk-sized browser coverage for processing, duplicate, offline success/failure, connectivity recovery, and reduced motion.
Release: v0.18.0 meeting operations and kiosk feedback.

### WU-053 — Dashboard visual-language standard

Status: merged (`f6788c9`)

Owner: Codex task
Branch: `codex/wu-053-dashboard-ui-standard`
Base: `2a5d0c3`
Integration: candidate `a35f097` was merged as `f6788c9`; on the merged tree, `npm run verify:dashboard` and the 44-test full browser suite passed.

Goal: give dashboard development one durable visual-language contract that reduces recurring spacing, typography, alignment, and native-control inconsistencies.
Dependencies: none
Scope: add the canonical dashboard UI standard and required planning/review checklist; route dashboard work to it from agent, dashboard, and development guidance; establish central semantic tokens for typography, spacing, control sizing, radii, surfaces, focus, and status roles; preserve the current Roboto/Bebas Neue identity through configurable font-role variables. Grandfather existing styling until its owning surface is intentionally changed. Exclude broad UI cleanup, a new style linter, formal WCAG conformance, kiosk and public-documentation styling, and end-user typography settings.
Sources: user-approved Dashboard Visual-Language Standard plan; `apps/dashboard/src/styles.css`; `docs/DASHBOARD.md`; `docs/DEVELOPMENT.md`; WCAG 2.2 and WAI-ARIA Authoring Practices.
Acceptance: future dashboard sessions have one mandatory, linked contract with explicit typography, spacing, alignment, form-control, responsive, theme, and accessibility defaults; the checklist requires documented exceptions and desktop/mobile, theme, keyboard, and control-state review; central font roles preserve the current rendered families and support later configuration without component-level font rewrites; no existing page is broadly restyled.
Verification: `npm run verify:dashboard`; validate documentation links and checklist content; inspect representative dashboard markup for feasibility; confirm the font-role tokens preserve current Roboto/Bebas Neue rendering; manually exercise the checklist at 1280x900 and 390x844 in light, dark, and representative adopter-brand themes.
Release: v0.18.0 meeting operations and kiosk feedback (development standard; no broad UI retrofit in this release).

### WU-054 — Dashboard design inventory and shared foundations

Status: merged (`d35c649`)

Owner: Codex task
Branch: `codex/wu-054-dashboard-design-foundations` (requested; provisioning Worktree)
Base: `cd694a4`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\2053\\LancerLogin Workspace` (detached)
Task: provisioning client `client-new-thread:2762d651-3eb1-4b41-9b29-e727801bb044`
Candidate: `04c1f3b43f2f1909ccab188c3067c40a331bd506`; commit subject and shared dashboard foundation/test files match this WU.
Integration: candidate `04c1f3b43f2f1909ccab188c3067c40a331bd506` was merged as `d35c64989fdf2b5fba1b79531665a883e45c5f2a`; on the merged tree, `npm run verify:dashboard` and the 61-test full browser suite passed.

Goal: make the dashboard's shared shell, tokens, controls, panels, dialogs, and responsive foundations conform to the visual-language contract before page-specific work begins.
Dependencies: WU-053
Scope: turn the durable initiative matrix into executable shared checks; converge central semantic typography, spacing, shape, control, surface, focus, and status roles; conform the authenticated shell, primary/Settings navigation, theme control, loading overlay, contest dialog, update popup, redirects, and unavailable-page state; establish reusable card, form, table, status, and dialog patterns for later units. Preserve branding behavior, routing, roles, and all product outcomes. Exclude page-specific content redesign and every surface outside the contract boundary.
Sources: `docs/PLANS/dashboard-design-conformance.md`; WU-053; `docs/UI-STANDARDS.md`; `apps/dashboard/src/styles.css`; `apps/dashboard/src/app-shell.tsx`; `apps/dashboard/src/main.tsx`; `apps/dashboard/src/loading-overlay.tsx`; `apps/dashboard/src/contest-indicator.tsx`; `apps/dashboard/src/update-indicator.tsx`; `apps/dashboard/src/modal-focus.ts`.
Acceptance: shared surfaces use contract tokens and hierarchy without duplicate literals; global controls and overlays have complete hover/focus/disabled/error behavior, 44px targets, correct semantics, focus containment/return, and no clipping or page overflow at reference sizes; an automated matrix identifies every governed route and overlay assigned to WU-055 through WU-060. No standards exception is expected.
Verification: `npm run verify:dashboard`; focused shell/navigation/theme/loading/dialog browser coverage at 1280x900 and 390x844 in light/dark, adopter-brand, keyboard, and reduced-motion variants; unfiltered browser suite after integration.
Release: v0.19.0 dashboard design conformance.

### WU-055 — Authentication and guided-setup conformance

Status: merged (`2cd4c2b`)

Owner: Codex task
Branch: `codex/wu-055-authentication-guided-setup` (requested; provisioning Worktree)
Base: `a7a98cc`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\9257\\LancerLogin Workspace` (detached)
Task: provisioning client `client-new-thread:10d233b8-8832-4a75-875a-8c8def93dab3`
Candidate: `d5e74961abb84d6e0f17fbfbf0245ec296904e31`; commit subject and authentication/setup UI and browser-test files match this WU.
Integration: candidate `d5e74961abb84d6e0f17fbfbf0245ec296904e31` was merged as `2cd4c2bbb0dd5919e5cbbcd1bea2c5dcf441fba2`; after correcting candidate-only test selectors and setup fixtures, `npm run verify:dashboard`, the 7-test focused authentication/setup browser matrix, and the 68-test full browser suite passed on the integrated code.

Goal: make every dashboard-rendered authentication and guided-setup state follow the shared visual and interaction contract.
Dependencies: WU-054
Scope: conform boot/auth checks, first-Admin bootstrap, local and Google sign-in, auth-mode choices, validation/pending/denied/locked/error states, the five embedded guided-setup steps, progress, skip/reopen/completed states, and completion overlay. Reuse the shared form, card, status, dialog, typography, spacing, focus, and semantic-color roles. Preserve credential handling, authentication policy, setup persistence, authorization, and completion behavior. Exclude external provider pages and provisioning UI outside the React dashboard.
Sources: `docs/PLANS/dashboard-design-conformance.md`; `docs/UI-STANDARDS.md`; `docs/SECURITY.md`; `docs/DASHBOARD.md`; `apps/dashboard/src/main.tsx`; `apps/dashboard/src/setup-workspace.tsx`; `apps/dashboard/src/color-editor.tsx`; `apps/dashboard/src/roster-import-panel.tsx`; `apps/dashboard/src/styles.css`.
Acceptance: every included state has correct headings, labels, instructions, validation associations, primary-action hierarchy, visible focus, persistent status cues, and responsive fit; setup completion respects reduced motion and remains understandable without animation; reference-size, theme, adopter-brand, keyboard, and applicable Admin-state checks pass. No standards exception is expected.
Verification: `npm run verify:dashboard`; focused bootstrap/sign-in/setup/completion browser coverage at the required combinations; unfiltered browser suite after integration.
Release: v0.19.0 dashboard design conformance.

### WU-056 — Dashboard and meeting-workspace conformance

Status: merged (`cced1d5`)

Owner: Codex task
Branch: `codex/wu-056-dashboard-meeting-conformance` (requested; provisioning Worktree)
Base: `dd9fdfd`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\7a10\\LancerLogin Workspace` (detached)
Task: provisioning client `client-new-thread:f70d9333-7379-4fe1-b898-7a9ef93c6a84`
Candidate: `e8520c7`; commit subject and dashboard/meeting UI, styling, and conformance tests match this WU.
Integration: candidate `e8520c7` was merged as `cced1d5ed1670be54749499244095640285b67bf`; after correcting candidate-only document routing and mobile header assertions, `npm run verify:api`, `npm run verify:dashboard`, the 8-test focused meeting matrix, and the 76-test full browser suite passed on the integrated code.

Goal: make Dashboard meeting browsing and every canonical meeting-detail state conform without changing meeting or attendance behavior.
Dependencies: WU-055
Scope: conform Dashboard Calendar/Table, selector, search, selection, bulk controls, status/empty/error/Undo states, creation dialog, canonical meeting detail, lifecycle summary, Discord operations, contest review, attendance states/actions, unavailable state, and edit/duplicate/delete dialogs. Reuse shared tokens and patterns, preserve row-selection isolation, time gates, recurring scope, roles, focus behavior, and API outcomes. Exclude Reports, Roster, Kiosks, Settings, physical kiosk, and simulator presentation.
Sources: `docs/PLANS/dashboard-design-conformance.md`; `docs/UI-STANDARDS.md`; `docs/DASHBOARD.md`; WU-044 through WU-049; `apps/dashboard/src/home-page.tsx`; `apps/dashboard/src/meetings-page.tsx`; `apps/dashboard/src/meeting-management.tsx`; `apps/dashboard/src/attendance-workspace.tsx`; `apps/dashboard/src/contest-review-list.tsx`; `apps/dashboard/src/styles.css`.
Acceptance: every included populated, empty, loading, success, error, disabled, configured/unconfigured, timing, and dialog state has consistent hierarchy/alignment/control treatment; all overlays contain and return focus; desktop/mobile, light/dark, adopter-brand, Admin/Operator, keyboard, and reduced-motion checks pass without page overflow or clipped controls. No standards exception is expected.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused meeting-browser/detail/dialog/Discord/contest/attendance browser matrix; unfiltered browser suite after integration.
Release: v0.19.0 dashboard design conformance.

### WU-057 — Roster and reporting conformance

Status: merged (`ac5c769`, corrected by `9162f04`)

Owner: Codex task
Branch: `codex/wu-057-roster-reporting-conformance` (requested; provisioning Worktree)
Base: `b84368d`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\c676\\LancerLogin Workspace` (detached)
Task: provisioning client `client-new-thread:cc64a84b-fc1a-4c34-a46d-6c6242ad2cf9`
Candidate: `8c6d81fe5d8e9da36a3f769e51f588536f88fc2`; the task created branch `codex/wu-057-roster-reporting`, and its commit subject and Reports/Roster/member-detail/test files match this WU.
Integration: candidate `8c6d81fe5d8e9da36a3f769e51f588536f88fc2d` was merged as `ac5c76915855030586535ff0f66382a4695ad9a1`; integration review corrected formatter-sensitive static assertions, restored native member-link semantics, and widened the new report filter container in `9162f047aaa2f2b42f2530ed69a953a671c78466`. `npm run verify:api`, `npm run verify:dashboard`, the 7-test focused Reports/Roster matrix, the 17-test dashboard smoke suite, and the 83-test full browser suite passed on the corrected integrated code.

Goal: make Reports, Roster, member detail, and member-management overlays consistently scannable and operable under the dashboard contract.
Dependencies: WU-056
Scope: conform Reports filters, saved views, trend, leaderboard, CSV, preserved-history and empty states; Roster search/filter/table and Admin/Operator actions; member detail linked/unlinked, active/inactive, history, and unavailable states; add/edit member and CSV import/preview/error dialogs. Preserve reporting calculations, export safety, roster history, Discord identity policy, authorization, imports, and deep links. Exclude meeting, Kiosks, Settings, and public-documentation redesign.
Sources: `docs/PLANS/dashboard-design-conformance.md`; `docs/UI-STANDARDS.md`; `docs/DASHBOARD.md`; `apps/dashboard/src/reports-page.tsx`; `apps/dashboard/src/roster-page.tsx`; `apps/dashboard/src/member-detail-page.tsx`; `apps/dashboard/src/roster-import-panel.tsx`; `apps/dashboard/src/styles.css`.
Acceptance: all included controls and states use shared roles, tables remain readable with only contained overflow, multiline rows align deliberately, dialogs manage focus, and reference-size, theme, adopter-brand, role, keyboard, and reduced-motion checks pass without clipped content. No standards exception is expected.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused Reports/Roster/member/import browser matrix; unfiltered browser suite after integration.
Release: v0.19.0 dashboard design conformance.

### WU-058 — Kiosks dashboard conformance

Status: merged (`a4a8099`, corrected by `64fb51e`)

Owner: Codex task
Branch: `codex/wu-058-kiosks-dashboard-conformance` (requested; provisioning Worktree)
Base: `3611e2b`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\ee83\\LancerLogin Workspace` (detached)
Task: provisioning client `client-new-thread:18f96031-053a-499d-a5da-3d713d7f909c`
Candidate: `07ccd9f9aeb2f919df7231fc50b5164818fb7ed4` (detached Worktree candidate; commit subject and Kiosks dashboard/test files match this WU).
Integration: candidate `07ccd9f9aeb2f919df7231fc50b5164818fb7ed4` was merged as `a4a8099534a911aaa31462d9b83de65526459434`; integration review aligned the pre-existing refresh-failure smoke assertion with the new error-alert semantics in `64fb51e70c0ab54de540e03a276f74c8fa685152`. `npm run verify:api`, `npm run verify:dashboard`, the 9-test focused Kiosks matrix, the 17-test dashboard smoke suite, and the 92-test full browser suite passed on the corrected integrated code. The physical kiosk presentation and shared kiosk contracts were unchanged, so `verify:kiosk` was not required.

Goal: make the dashboard-owned kiosk health and management workspace conform while preserving the physical kiosk boundary.
Dependencies: WU-057
Scope: conform `/kiosks` paired/unpaired, healthy/degraded/offline, Admin/Operator, Discord configured/unconfigured, action feedback, device history, pairing dialog, maintenance callout, physical-device actions, and browser-simulator entry card. Preserve diagnostic privacy, pairing/replacement rules, fixed command allowlist, provider verification, roles, and kiosk behavior. Exclude `/simulator` kiosk-display presentation, physical kiosk UI, local maintenance/network pages, deployment, and Pi changes.
Sources: `docs/PLANS/dashboard-design-conformance.md`; `docs/UI-STANDARDS.md`; `docs/KIOSK.md`; `docs/SECURITY.md`; `docs/DASHBOARD.md`; `apps/dashboard/src/kiosks-page.tsx`; `apps/dashboard/src/styles.css`.
Acceptance: all included states have consistent card hierarchy, aligned diagnostics/actions, semantic status treatment, 44px controls, focused pairing behavior, and no clipping or page overflow across the required sizes, themes, adopter brand, roles, keyboard, and reduced-motion settings. No standards exception is expected.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and `npm run verify:kiosk` if shared kiosk contracts change; focused Kiosks dashboard browser matrix; unfiltered browser suite after integration.
Release: v0.19.0 dashboard design conformance.

### WU-059 — Settings workspace conformance

Status: merged (`34c25db`, corrected by `c5865d5`)

Owner: Codex task
Branch: `codex/wu-059-settings-workspace-conformance` (requested; provisioning Worktree)
Base: `ae18d75`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\93cc\\LancerLogin Workspace` (detached)
Task: provisioning client `client-new-thread:60d35335-3bd4-473a-902b-3fa205ba9b38`
Candidate: `7cb7caf14f9fdf963d83396f12cc3449d138dfc6` (detached Worktree candidate; commit subject and all eight Settings route/test files match this WU).
Integration: candidate `7cb7caf14f9fdf963d83396f12cc3449d138dfc6` was merged as `34c25dbed5dc14771bab8167028b14cc50dca47e`; integration review narrowed the new Settings form selectors so they could not override Reports controls in `c5865d5b61fedb1196783bf4bb5d57072ac1b0e6`. `npm run verify:api`, `npm run verify:dashboard`, the 6-test focused Settings matrix, the focused Reports selector regression, and the 98-test full browser suite passed on the corrected integrated code. No guidance changed, so `verify:docs` was not required.

Goal: make every Settings category and its operational states conform to one predictable dashboard form and panel system.
Dependencies: WU-058
Scope: conform Organization, Configuration, Access, Integrations, Privacy, Data, Guided Setup, and Updates pages; include enabled/disabled/configured integration cards, validation and save states, telemetry choices, backup/restore/delete dialog, update current/available/degraded states, and navigation hierarchy. Preserve authentication safeguards, encrypted secrets, destructive confirmations, backup/update gates, telemetry consent, roles, and configuration outcomes. Exclude provider websites, deployment execution, public docs styling, and private-infrastructure mutation.
Sources: `docs/PLANS/dashboard-design-conformance.md`; `docs/UI-STANDARDS.md`; `docs/DASHBOARD.md`; `docs/INTEGRATIONS.md`; `docs/SECURITY.md`; `apps/dashboard/src/organization-settings.tsx`; `apps/dashboard/src/configuration-settings.tsx`; `apps/dashboard/src/user-settings.tsx`; `apps/dashboard/src/integration-settings.tsx`; `apps/dashboard/src/privacy-settings.tsx`; `apps/dashboard/src/data-settings.tsx`; `apps/dashboard/src/updates-page.tsx`; `apps/dashboard/src/styles.css`.
Acceptance: every included page, expanded/collapsed card, form state, status, and dialog uses the shared hierarchy and control contract; labels/errors are associated, selects retain inset arrows, destructive actions remain distinct, and required size/theme/brand/role/keyboard/reduced-motion checks pass without clipping or page overflow. No standards exception is expected.
Verification: `npm run verify:api`, `npm run verify:dashboard`, and `npm run verify:docs` when guidance changes; focused browser matrix for all eight Settings routes and overlays; unfiltered browser suite after integration.
Release: v0.19.0 dashboard design conformance.

### WU-060 — Dashboard design convergence audit

Status: merged (`f964c66`)

Owner: Codex task
Branch: `codex/wu-060-dashboard-design-convergence` (requested; provisioning Worktree)
Base: `be8e891`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\92b6\\LancerLogin Workspace` (detached)
Task: provisioning client `client-new-thread:102c938d-541a-4faa-a47d-518eaff732c6`
Candidate: `6c6679b2b25ba7e2c85af2281e6d962137bcfc4f` (detached Worktree candidate; commit subject and convergence-audit coverage match this WU).
Integration: candidate `6c6679b2b25ba7e2c85af2281e6d962137bcfc4f` was merged as `f964c664b3c5cc42259daf52a1c2568e42cfb1f5`. The 4-test convergence audit traversed all 14 governed routes at 1280x900 and 390x844 in light and dark reference-brand modes and found no remaining heading, labeling, target-size, clipping, or page-overflow violation. `npm run verify:dashboard` and the 102-test full browser suite passed on the integrated tree. WU-060 changed only durable browser audit coverage, so API verification was not required; the WU-059 integrated API gate remained green. No standards exception remains.

Goal: prove the integrated governed dashboard has no unresolved violation of the visual-language standard and repair any final cross-surface inconsistency.
Dependencies: WU-054, WU-055, WU-056, WU-057, WU-058, and WU-059
Scope: execute the complete route/overlay/state matrix on the integrated tree; repair remaining governed-surface token, hierarchy, alignment, control-state, focus, semantic-color, responsive, theme, adopter-brand, role, keyboard, or reduced-motion inconsistencies; record any deliberate exception and its justification. Preserve product behavior and all exclusions in the initiative plan. Exclude new features, policy changes, public-doc redesign, physical/simulator kiosk presentation, provisioning, deployment, and Pi work.
Sources: `docs/PLANS/dashboard-design-conformance.md`; `docs/UI-STANDARDS.md`; WU-054 through WU-059; all governed dashboard components and browser tests.
Acceptance: the final matrix covers every governed page, subpage, popup, dialog, overlay, shared element, and meaningful state at 1280x900 and 390x844 in light/dark with primary `#7c3aed`, secondary `#0f766e`, applicable Admin/Operator roles, keyboard operation, and reduced motion; there is no page-level horizontal overflow, clipped content/focus, invalid heading/control semantics, duplicated design literals, or unresolved standards violation. Any unavoidable exception is explicit and blocks completion unless accepted as conforming by the contract.
Verification: `npm run verify:api` if behavior-adjacent corrections occur; `npm run verify:dashboard`; complete focused conformance matrix; unfiltered browser suite; `npm run verify:release` during v0.19.0 packaging; exact-commit GitHub Verify before tagging.
Release: v0.19.0 dashboard design conformance.

### WU-061 — Google OAuth setup guidance

Status: merged (`c4e553a`)

Owner: Codex task
Branch: `codex/wu-061-google-oauth-guidance` (requested; provisioning Worktree)
Base: `64c5b1fa960ecb96127ee5b58addc75e363f8574`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\b57d\\LancerLogin Workspace` (detached)
Task: provisioning client `client-new-thread:f2caa650-435f-48d7-81d2-0ad3c1b54fcb`
Recovery: the recorded provisioning client never produced an addressable task, and the detached Worktree remained at the recorded base with no candidate commit. A replacement task may be launched from current `main`; do not reuse the stale provisioning client.
Replacement branch: `codex/wu-061-google-oauth-guidance-v2`
Replacement base: `dc72fcf`
Replacement Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\cbca\\LancerLogin Workspace`
Replacement task: `01a06ecc-a2d5-7fb1-a72d-79499dfe9c48` (provisioned from client `client-new-thread:e674f441-5105-4192-a775-2ee93eb5da0e`)
Integration: candidate `2a39f6efcbba5cf48aec89c4bfa519dca41be16f` was merged as `c4e553aaeb82727d3781829e47412a4102b04a8b`. `npm run verify:dashboard`, `npm run verify:docs`, and the complete 118-test browser suite passed on the integrated tree. Current official Google Auth Platform guidance was checked for Branding, Audience, Clients, Data Access, Verification Center, Internal/External publishing behavior, exact redirect matching, and the basic-identity scope exception. No live Google project was mutated and no real identifiers or secrets were added.

Goal: make Google OAuth setup accurate, current, and easy to complete from either first-Admin setup or Settings without crowding the dashboard with screenshots.
Dependencies: none
Scope: update the first-Admin and Settings > Integrations Google OAuth instructions to reflect the current Google Auth Platform flow and the setup choices available to adopters; replace long dashboard walkthroughs with concise safe guidance and a link to a thorough public documentation section containing sanitized Google-console screenshots; keep the exact installation-specific authorized redirect URI visible and copyable. Preserve OAuth scopes, client credential handling, active-Admin verification, Google-only lockout prevention, and the rule that dashboard UI does not embed setup screenshots. Exclude authentication-policy, provider-client, callback, credential-storage, and unrelated integration changes.
Sources: `docs/idea_inbox.md` (IN-072); current official Google Auth Platform documentation; `apps/dashboard/src/main.tsx`; `apps/dashboard/src/integration-settings.tsx`; `docs-site/setup.html`; `docs-site/assets/google-oauth-setup.png`; `docs/BOOTSTRAPPING.md`; `docs/INTEGRATIONS.md`; `docs/SECURITY.md`; `tests/docs-site.test.mjs`; `tests-browser/auth-setup-conformance.spec.ts`; `tests-browser/settings-conformance.spec.ts`.
Acceptance: first-Admin setup and Settings > Integrations describe the currently available Google project, branding, audience, client, and verification choices without obsolete labels; both dashboard paths link to one thorough public guide; the public guide includes sanitized screenshots and the exact Pages callback pattern; no dashboard screenshot is added; and secrets, authorization, verification, and lockout safeguards remain unchanged.
Verification: `npm run verify:dashboard`; `npm run verify:docs`; focused first-Admin and Integrations browser coverage for links, callback values, and responsive keyboard access; manually compare the public guide with current official Google Auth Platform guidance.
Release: next documentation and setup-guidance bundle.

### WU-062 — Public documentation visual conformance

Status: merged (`fb497cc`)

Owner: Codex task
Branch: `codex/wu-062-public-docs-conformance`
Base: `77d7a47`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\8527\\LancerLogin Workspace`
Task: `01a06ede-ee19-7cc3-af9d-549dfa0ebb1a` (provisioned from client `client-new-thread:36a3b24d-7866-4ff1-b9a0-ee8aef2a5c96`)
Integration: candidate `f43acc676475be08686fd9bfa4c29197990c2a15` was merged as `fb497cc0b721629c300389352301ab48f2197874`. `npm run verify:docs` and the complete 125-test browser suite passed on the integrated tree. The public-docs matrix covered all seven pages at 1280x900 and 390x844 in light/dark device modes, including fixed red/gold brand tokens, keyboard focus, 44px targets, contrast, reduced motion, loaded images, contained tables/screenshots, and page-overflow checks. Chromium is the repository's configured browser; Firefox and WebKit were not separately run.

Goal: make the complete public documentation site feel like LancerLogin while remaining readable, responsive, and accessible in light and dark environments.
Dependencies: WU-061 (both units change the public setup guide, shared documentation styles, and documentation coverage; settle OAuth content before the site-wide presentation pass)
Scope: restyle all public documentation pages and shared components using the dashboard visual language where it fits a task-first documentation site; use fixed primary `#B80100` and secondary `#EEB822` brand colors rather than adopter-configurable colors; provide complete light and dark palettes that follow the user's device preference; align typography, navigation, headings, cards, notices, controls, tables, code, screenshots, annotations, and footer treatment; preserve content, sanitized assets, static GitHub Pages hosting, task-first information architecture, and reduced-motion behavior. Exclude dashboard, kiosk, adopter branding configuration, documentation content expansion other than presentation-accessibility fixes, and client-side theme persistence or deployment changes.
Sources: `docs/idea_inbox.md` (IN-073); `docs/UI-STANDARDS.md` as an applicable visual-language reference only; `docs-site/index.html`; `docs-site/setup.html`; `docs-site/kiosk.html`; `docs-site/operations.html`; `docs-site/privacy.html`; `docs-site/releases.html`; `docs-site/technical.html`; `docs-site/styles.css`; `docs-site/assets/`; `tests/docs-site.test.mjs`; `.github/workflows/docs.yml`.
Acceptance: every public page uses the fixed red/gold identity consistently; light and dark device preferences produce complete high-contrast palettes without flashes, unreadable states, clipped content, or horizontal page overflow; navigation, focus, headings, links, notices, tables, code, screenshots, and annotations remain understandable by keyboard and at desktop and mobile widths; existing documentation content and links remain intact; no adopter-controlled color or dashboard/kiosk presentation changes are introduced.
Verification: `npm run verify:docs`; add focused structural assertions for brand tokens, light/dark support, focus, and shared page wiring; browser-check all seven pages at 1280x900 and 390x844 in light and dark modes with keyboard navigation, reduced motion, screenshot/table overflow, and contrast review.
Release: next public-documentation visual refresh.

### WU-063 — Dashboard meeting-selector visual conformance

Status: merged (`26671ba`)

Owner: Codex task
Branch: `codex/wu-063-meeting-selector-conformance`
Base: `7ab4a83aee56d70cbbd2747df45f6be9a119beda`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\095a\\LancerLogin Workspace`
Task: `01a06d76-a306-72c0-b11d-9aafbfeb3d0a`
Integration: candidate `131598f6966a996b68fb3b251d6b8692785d8947` was merged as `26671bae6512e7844ab5feeb2a492d878846df33`. `npm run verify:dashboard` and the 106-test unfiltered browser suite passed on the integrated tree. The required desktop/mobile, light/dark, representative adopter-brand, keyboard, focus, disabled-state, clipping, and overflow checks passed with no standards exception.

Goal: make the Dashboard meeting-selector dropdown match the established dashboard form-control language without changing meeting navigation.
Dependencies: none
Scope: conform the Dashboard meeting selector's label, native select, inset arrow, spacing, typography, border, radius, height, hover, focus, disabled, light/dark, adopter-brand, and responsive treatment using shared tokens and established patterns. Preserve the native-select interaction, meeting ordering, selection routing, Calendar/Table behavior, and Add meeting hierarchy. Exclude meeting-detail and guided-setup selectors, meeting data or routing changes, and unrelated dashboard controls.
Sources: `docs/idea_inbox.md` (IN-074); `docs/UI-STANDARDS.md`; `docs/DASHBOARD.md`; `apps/dashboard/src/home-page.tsx`; `apps/dashboard/src/styles.css`; `tests/dashboard-shell.test.mjs`; `tests-browser/dashboard-meeting-browser.spec.ts`; `tests-browser/convergence-audit.spec.ts`.
Acceptance: the Dashboard selector uses the shared native-control and inset-arrow treatment, remains visibly labeled with a 44px target and clear focus/disabled states, preserves navigation behavior, and fits without clipping or page-level overflow at 1280x900 and 390x844 in light/dark with representative adopter colors. No standards exception is expected.
Verification: `npm run verify:dashboard`; focused Dashboard meeting-browser coverage for selection and keyboard operation; desktop/mobile light/dark and adopter-brand visual checks.
Release: next dashboard polish bundle.

### WU-064 — Discord kiosk-status message self-healing

Status: merged (`098e15c`)

Owner: Codex task
Branch: `codex/wu-064-discord-status-self-healing`
Base: `7ab4a83aee56d70cbbd2747df45f6be9a119beda`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\723a\\LancerLogin Workspace`
Task: `01a06d76-90db-7712-b8ef-0c5a0632ddc5`
Integration: candidate `5aa6d7ba66651ace62a1316928a6fa61793c8c8f` was merged as `098e15cd24f5ab97dd46e8fc11172d5e6eb149bb`. `npm run verify:api`, `npm run verify:dashboard`, and the 106-test unfiltered browser suite passed on the integrated tree. Provider-fake coverage proves manual and scheduled recovery, replacement mapping persistence, unchanged follow-up idempotence, controlled mentions, and refusal to recreate on unrelated Discord failures. Live Discord validation remains a release-note manual check.

Goal: make manual and scheduled Discord kiosk-status synchronization recover automatically when its previously tracked Discord message has been deleted.
Dependencies: none
Scope: when updating the stored persistent kiosk-status message receives Discord's missing-message response, create a replacement in the configured attendance channel and replace the stored message mapping and content hash before reporting success. Preserve Admin/Operator authorization, verified-integration gating, controlled mentions, unchanged-content idempotence when the tracked message exists, audit records, channel selection, and existing handling for permissions, rate limits, authentication, and other Discord failures. Exclude calendar sync, absence-notice behavior, Discord configuration UI, channel-manager mode, and unrelated kiosk presentation.
Sources: `docs/idea_inbox.md` (IN-075 and IN-076); `docs/INTEGRATIONS.md`; `docs/SECURITY.md`; `apps/api/src/index.ts`; `apps/dashboard/src/kiosks-page.tsx`; `tests/integration-workflows.test.mjs`; relevant API integration tests; `tests-browser/displaced-meeting-utilities.spec.ts`.
Acceptance: a missing tracked status message causes exactly one replacement to be posted to the configured attendance channel, the new Discord message ID and content hash become authoritative, the dashboard reports success, and a later unchanged sync is idempotent; non-missing Discord errors remain actionable failures and no unrelated message is modified or deleted.
Verification: `npm run verify:api`; `npm run verify:dashboard` if response or dashboard handling changes; focused mocked Discord coverage for existing-message update, missing-message recreation, persisted replacement mapping, unchanged follow-up, and non-404 failures; focused Kiosks browser coverage for recovered success and actionable error feedback.
Release: next Discord reliability bundle; suitable for a narrow patch if the failure affects production adopters.

### WU-065 — Discord designated-channel manager mode

Status: blocked

Goal: offer an opt-in Discord mode that maintains a dedicated attendance channel's LancerLogin-owned status, guidance, and expiring absence messages as one coherent operational surface.
Dependencies: WU-061 and WU-064; product decision required on whether “status message at the top” means a Discord-pinned message or the oldest maintained LancerLogin message in the dedicated channel
Scope: add an Admin-only Discord configuration toggle; when enabled, maintain a persistent kiosk/status message followed by a pairing-and-contest how-to message, send controlled absence pings after each meeting's late-scan window closes, and delete each tracked absence message after the configured Discord contest window; move the contest-window setting from Settings > Configuration to the Discord card in Settings > Integrations. Restrict management to the configured attendance channel and to LancerLogin-owned, explicitly tracked messages; never delete or rewrite unrelated or user-authored content. Preserve provider verification, encrypted credentials, signed contests, recipient history, retry/idempotence, authorization, controlled mentions, and behavior when the mode is disabled. Exclude general Discord moderation, managing other channels, changing attendance or contest policy, and unrelated Settings presentation.
Sources: `docs/idea_inbox.md` (IN-077); `docs/INTEGRATIONS.md`; `docs/SECURITY.md`; `docs/DASHBOARD.md`; `apps/dashboard/src/integration-settings.tsx`; `apps/dashboard/src/configuration-settings.tsx`; `apps/api/src/index.ts`; `apps/api/migrations/`; Discord integration and scheduler tests; `tests-browser/settings-conformance.spec.ts`.
Acceptance: the toggle and contest-window setting are available only to Admins in the Discord integration surface; enabled mode maintains exactly one current status message and one current how-to message according to the approved ordering mechanism, sends each eligible absence ping only after the late-scan cutoff, deletes only its tracked absence message after contest expiry, survives deleted managed messages, and leaves unrelated channel content untouched; disabled mode preserves current Discord behavior.
Verification: `npm run verify:migrations`, `npm run verify:api`, and `npm run verify:dashboard`; focused provider-fake coverage for enable/disable, message ordering and self-healing, cutoff scheduling, retries, expiry deletion, contest validity, controlled mentions, and unrelated-message safety; focused Admin/Operator and responsive Settings browser coverage; supported-server manual validation before release.
Release: later Discord channel-management feature bundle after its dependencies and product decision are resolved.

### WU-066 — Wide-desktop dashboard utilization

Status: merged (`2cbb739`)

Owner: Codex task
Branch: `codex/wu-066-wide-desktop-dashboard`
Base: `8122e57`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\1a4d\\LancerLogin Workspace`
Task: `01a06ecc-b195-77b2-a9f9-7527edf4f914` (provisioned from client `client-new-thread:96955809-e03b-4bcf-8f6c-8a88b8d2be32`)
Integration: candidate `410107f578315a6d07cad2cb9b08e07d22745eb7` was merged as `2cbb7391bc15e2a42b8bd4367935357835d7c151`. `npm run verify:dashboard` and the 108-test unfiltered browser suite passed on the integrated tree. The six-case all-route audit covered 2560x1440, 1280x900, and 390x844 in light/dark modes; focused coverage also passed for representative adopter colors, keyboard focus/return, responsive navigation, dialogs, tables, clipping, and page overflow. No standards exception remains.

Goal: use wide desktop displays more effectively so the authenticated dashboard does not require browser zoom to avoid excessive side whitespace.
Dependencies: WU-063 (both units change shared dashboard layout styling; integrate the focused selector work first)
Scope: adjust the authenticated dashboard shell and governed page-width behavior for wide desktop viewports; preserve readable line lengths within text-heavy cards while allowing data, calendar, table, and operational workspaces to use materially more horizontal space. Reuse the established layout, spacing, radius, typography, and semantic-color tokens. Exclude font scaling, browser-zoom control, public documentation, kiosk and simulator presentation, navigation redesign, and unrelated card-level restyling.
Sources: `docs/idea_inbox.md` (IN-078); `docs/UI-STANDARDS.md`; `docs/DASHBOARD.md`; `apps/dashboard/src/app-shell.tsx`; `apps/dashboard/src/styles.css`; `tests/dashboard-shell.test.mjs`; `tests-browser/convergence-audit.spec.ts`; governed route browser coverage.
Acceptance: at 2560x1440 and 100% browser zoom, governed dashboard workspaces use the available width without excessive outer gutters while text remains readable and page hierarchy stays intact; existing 1280x900 and 390x844 layouts remain conforming; light/dark modes, representative adopter colors, keyboard focus, dialogs, contained table scrolling, and responsive navigation show no clipping or page-level horizontal overflow. No standards exception is expected.
Verification: `npm run verify:dashboard`; focused all-route browser checks at 2560x1440, 1280x900, and 390x844 in light/dark modes with representative adopter colors, keyboard navigation, dialogs, tables, and overflow inspection; unfiltered browser suite after integration.
Release: next dashboard layout and polish bundle.

### WU-067 — Contest-review member and scan context

Status: merged (`65c0516`, corrected by `950bcc5`)

Owner: Codex task
Branch: `codex/wu-067-contest-review-context`
Base: `8122e57`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\d558\\LancerLogin Workspace`
Task: `01a06ecc-c13b-7711-a74e-16c62b27b01e` (provisioned from client `client-new-thread:088b5b89-9cd0-43fb-9211-fc6ea30788fb`)
Integration: candidate `4484a5a229593231999e50053f650e5661614b58` was merged as `65c0516`. `npm run verify:api` and `npm run verify:dashboard` passed on the integrated tree. The first unfiltered browser run exposed a test-only modal sequencing error: it attempted to click the background theme switch while the contest dialog correctly contained pointer interaction. Correction `950bcc5` closes the dialog, verifies focus return, changes theme, reopens the dialog, and rechecks the context. The focused regression and the complete 110-test browser suite then passed. Provider-fake and UI coverage prove lifetime counts across preserved statuses, partial/no/complete raw scan distinctions independent of corrections, Operator/Admin access, and unavailable unauthorized/unverified paths.

Goal: give reviewers enough member history and raw scan context to judge each attendance contest from either review surface.
Dependencies: WU-064 (both units change the Discord Worker surface and related integration coverage; integrate the reliability repair first)
Scope: extend the authorized contest query with the member's lifetime submitted-contest count, including the current contest and every preserved status, plus whether the contested meeting has a raw check-in without a raw check-out; display both facts on the global contest-handler popup and the meeting-detail contest card. Preserve the current meeting/member identity, occurrence date, reason-required resolution workflow, signed contest submission, authorization, and notifier refresh. Exclude contest scoring, automatic resolution, attendance-policy changes, deletion of contest history, and unrelated Discord messaging.
Sources: `docs/idea_inbox.md` (IN-079); `docs/DASHBOARD.md`; `docs/INTEGRATIONS.md`; `docs/SECURITY.md`; `apps/api/src/index.ts`; `apps/dashboard/src/contest-indicator.tsx`; `apps/dashboard/src/contest-review-list.tsx`; `apps/dashboard/src/attendance-workspace.tsx`; `tests-ts/worker-runtime.test.ts`; `tests-browser/displaced-meeting-utilities.spec.ts`; `tests-browser/meeting-detail.spec.ts`.
Acceptance: every authorized contest result carries a count of all contests submitted for that member and a raw partial-scan flag for that meeting; both review surfaces show the same labeled values; a check-in without check-out is identified even if a later correction changed the attendance disposition; no-scan and completed-scan cases remain distinct; Operators and Admins retain access while unauthorized or unverified paths remain unavailable.
Verification: `npm run verify:api`; `npm run verify:dashboard`; focused API coverage for count/status history and partial/no/complete scan cases; focused global-popup and meeting-detail browser coverage at desktop/mobile with keyboard and light/dark checks; unfiltered browser suite after integration.
Release: next attendance-review and Discord operations bundle.

### WU-068 — Meeting attendance scan-time visibility

Status: merged (`582a6ab`)

Owner: Codex task
Branch: `codex/wu-068-attendance-scan-times`
Base: `c816e0b`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\0f69\\LancerLogin Workspace`
Task: `01a06ede-fca3-78c0-aaa9-92003f7713bb` (provisioned from client `client-new-thread:96bfd272-cdb8-45c5-b8ae-8ac74c63549b`)
Integration: candidate `e6c178d68d013bd2ba1b74f9f59013ad51acef7d` was merged as `582a6abb06e766fd474632e80722bebfd2aa1985`. `npm run verify:dashboard` and the complete 121-test browser suite passed on the integrated tree. The first full-suite run had one unrelated transient loading-overlay timing failure; that existing reduced-motion test passed alone and the unchanged full suite passed on rerun. Focused coverage proves locally formatted authoritative check-in/check-out values for complete, partial, missing, and corrected rows at desktop/mobile, light/dark, representative branding, keyboard, and overflow conditions. The API contract was unchanged, so no API gate was required.

Goal: show each member's recorded check-in and check-out times directly in the canonical meeting attendance workspace.
Dependencies: WU-063 (both units touch the meeting-browser/detail dashboard presentation and shared styling; integrate selector conformance first)
Scope: display the existing attendance response's `checkedInAt` and `checkedOutAt` values for every member row on `/meetings/[ID]`, with a clear unavailable value when a scan is absent and without obscuring status or correction actions. Preserve the member-detail history, which already shows both timestamps and satisfies that half of IN-080; preserve attendance derivation, corrections, refresh timing, roles, and raw event history. Exclude new scan capture, attendance-policy changes, reports, exports, and member-history redesign.
Sources: `docs/idea_inbox.md` (IN-080); `docs/UI-STANDARDS.md`; `docs/DASHBOARD.md`; `apps/dashboard/src/attendance-workspace.tsx`; `apps/dashboard/src/member-detail-page.tsx`; `apps/dashboard/src/styles.css`; `apps/api/src/index.ts`; `tests/dashboard-shell.test.mjs`; `tests-browser/meeting-detail.spec.ts`; `tests-browser/meeting-workspace-conformance.spec.ts`.
Acceptance: meeting attendance rows expose locally formatted check-in and check-out times from the authoritative response for complete, partial, and no-scan cases; active/present/absent/corrected semantics and actions remain unchanged; labels and table relationships are understandable by assistive technology; the added information remains usable without page overflow at 1280x900 and 390x844 in light/dark and representative adopter-brand modes. No standards exception is expected.
Verification: `npm run verify:dashboard`; focused meeting-detail browser coverage for complete, partial, missing, and corrected records plus keyboard and responsive layout checks; `npm run verify:api` only if the existing attendance contract must change; unfiltered browser suite after integration.
Release: next attendance workspace bundle.

### WU-069 — Configurable attendance-anomaly metric

Status: blocked

Goal: define configurable late-arrival and early-departure thresholds and expose each member's mean anomalous time on member detail.
Dependencies: product decision required on whether the mean uses all preserved eligible history or the active reporting period, whether check-in and check-out deviations are averaged as individual scan values or first combined per meeting, and the displayed unit/rounding rule
Scope: after the aggregation contract is approved, add Admin-only organization settings for the late-arrival and early-departure thresholds; derive anomalies from raw check-in relative to scheduled start and raw check-out relative to scheduled end; calculate the per-member mean according to the approved population; and show the labeled statistic and empty state on member detail. Preserve the organization-wide late-scan allowance as a separate attendance-closing rule, participation start dates, corrections, excuses, optional-meeting semantics, raw events, roles, and existing reporting calculations. Exclude Discord anomaly delivery, automatic attendance corrections, kiosk feedback, and meeting weighting.
Sources: `docs/idea_inbox.md` (IN-081 and IN-082); `docs/DECISIONS.md`; `docs/DASHBOARD.md`; `docs/UI-STANDARDS.md`; `apps/api/migrations/`; `apps/api/src/index.ts`; `apps/api/src/attendance-lifecycle.ts`; `apps/dashboard/src/organization-settings.tsx`; `apps/dashboard/src/member-detail-page.tsx`; attendance lifecycle, member-history, Settings, and roster/reporting tests.
Acceptance: after the named policy decision is recorded, Admins can save bounded nonnegative thresholds with validation and audit history; Operators cannot change them; anomaly calculations use scheduled meeting boundaries and authoritative raw scans without conflating the late-scan allowance; member detail shows the approved mean and a clear no-anomalies state; participation and reporting-period rules match the approved aggregation contract; upgrades receive documented defaults without changing existing attendance outcomes.
Verification: `npm run verify:migrations`; `npm run verify:api`; `npm run verify:dashboard`; focused calculation coverage for exact thresholds, late/early/both/partial scans, participation dates, corrections, empty history, and approved aggregation semantics; focused Admin/Operator Settings and member-detail browser checks at required themes/viewports; unfiltered browser suite after integration.
Release: later attendance-insights bundle after the aggregation decision is resolved.

### WU-070 — Scheduled Discord anomaly reports

Status: blocked

Goal: deliver a controlled Discord report of anomalous arrivals and departures after the relevant attendance windows close.
Dependencies: WU-069 and WU-065; product decision required on whether reports reuse WU-065's designated attendance channel or use a separate privileged channel, and whether delivery is one report per closed meeting or one organization-local daily digest with an explicit time zone and send time
Scope: after the channel and schedule contract is approved, add the Admin-only Discord configuration required by that contract; send idempotent reports containing only members and anomaly values eligible under WU-069 after their meetings can no longer accept scans; persist delivery state for retry safety; and keep messages confined to the approved configured channel. Preserve provider verification, encrypted credentials, controlled mentions, role restrictions, retry behavior, existing absence/contest/status workflows, and unrelated channel content. Exclude changing anomaly calculations, attendance outcomes, general moderation, direct messages, and managing messages outside LancerLogin's tracked report records.
Sources: `docs/idea_inbox.md` (IN-083); WU-065; WU-069; `docs/INTEGRATIONS.md`; `docs/SECURITY.md`; `docs/DASHBOARD.md`; `apps/api/migrations/`; `apps/api/src/index.ts`; `apps/dashboard/src/integration-settings.tsx`; Discord scheduler/provider tests; `tests-browser/settings-conformance.spec.ts`.
Acceptance: after the named decisions and dependencies clear, only Admins can configure report delivery; each eligible reporting period produces at most one tracked message in the approved channel after all included meetings close; retries cannot duplicate delivery; empty periods follow the approved contract; unverified/disabled integrations do not send; content uses controlled mentions and never exposes secrets or modifies unrelated messages.
Verification: `npm run verify:migrations`; `npm run verify:api`; `npm run verify:dashboard`; focused provider-fake coverage for timing, time-zone boundaries if applicable, idempotence, retry, empty periods, channel isolation, controlled mentions, disabled/unverified states, and dependency semantics; focused Admin/Operator responsive Settings coverage; supported-server manual validation before release.
Release: later Discord attendance-insights bundle after WU-065, WU-069, and the scheduling decision are complete.

### WU-071 — Configurable meeting weights

Status: blocked

Goal: let organizations define reusable meeting-weight categories, optional duration-based automatic criteria, and manual per-meeting assignments.
Dependencies: product decision required on what meeting weights change in attendance percentages and reports, how multiple matching automatic criteria resolve, and how assignment edits propagate across recurring-series occurrences
Scope: after the weighting contract is approved, add an Admin-managed ordered category model with a bounded positive weight and optional duration criterion; allow categories to be added, edited, reordered, and retired without invalidating historical meetings; preselect the approved automatic match during meeting creation while allowing manual assignment with no matching criterion; and expose assignment editing on canonical meeting detail. Preserve required/optional attendance, participation dates, meeting overlap rules, recurrence safety, existing unweighted history, roles, and auditability. Exclude hard-coded category names or thresholds, retroactive silent reassignment, changing kiosk scan behavior, and unrelated template or report redesign.
Sources: `docs/idea_inbox.md` (IN-084); `docs/DECISIONS.md`; `docs/DASHBOARD.md`; `docs/UI-STANDARDS.md`; `apps/api/migrations/`; `apps/api/src/index.ts`; `apps/dashboard/src/organization-settings.tsx`; `apps/dashboard/src/meeting-management.tsx`; `apps/dashboard/src/attendance-workspace.tsx`; `apps/dashboard/src/reports-page.tsx`; meeting lifecycle, recurrence, reporting, Settings, and meeting-workspace tests.
Acceptance: after the named policy decisions are recorded, Admins can manage validated weight categories and optional criteria; meeting creation deterministically preselects the approved match and always permits an authorized manual choice; detail edits obey the approved occurrence/series rule; retired categories remain readable on historical meetings; attendance percentages and exports apply weights exactly according to the approved contract; upgrades preserve prior results with a documented default weight.
Verification: `npm run verify:migrations`; `npm run verify:api`; `npm run verify:dashboard`; focused coverage for category lifecycle, validation, automatic matching/ties, manual override, recurrence edits, retirement/history, migration defaults, authorization, and weighted calculations; responsive keyboard browser coverage for Organization settings and meeting create/detail at required themes/viewports; unfiltered browser suite after integration.
Release: later weighted-attendance feature bundle after the product decisions are resolved.

### WU-072 — Discord member attendance-report command

Status: in progress

Owner: Codex task
Branch: `codex/wu-072-discord-attendance-report`
Base: `c816e0b`
Worktree: `C:\\Users\\Izz\\.codex\\worktrees\\a1d5\\LancerLogin Workspace`
Task: `01a06edf-0dad-7160-aae9-37b0b5bcb6e5` (provisioned from client `client-new-thread:2d644f08-aaef-46f5-a8e6-8a04938bbeb2`)

Goal: let a Discord-linked roster member privately request their own current attendance report.
Dependencies: WU-064 (both units change the Discord interaction handler and provider-fake coverage; integrate the reliability repair first)
Scope: handle a documented Discord attendance-report application command for a verified installation; bind the requester to exactly one active linked roster member; return an ephemeral response containing that member's absent meetings and current attendance percentage using the dashboard's canonical participation-start and operational-reporting-period semantics; bound long histories to Discord response limits with an explicit omitted-count summary. Preserve interaction signature verification, server binding, integration enablement/verification, roster pairing, attendance corrections/excuses, controlled mentions, and dashboard report calculations. Exclude reports for another member, public/channel responses, direct messages, changing attendance, PDF/CSV attachments, and Discord-side configuration automation.
Sources: `docs/idea_inbox.md` (IN-085); `docs/INTEGRATIONS.md`; `docs/SECURITY.md`; `docs/DASHBOARD.md`; `apps/api/src/index.ts`; `apps/dashboard/src/reports-page.tsx`; `apps/dashboard/src/member-detail-page.tsx`; `tests-ts/worker-runtime.test.ts`; `tests/integration-workflows.test.mjs`; Discord setup guidance and tests.
Acceptance: a correctly signed command from the configured server returns only the linked active member's report with current percentage and absent-meeting names/dates; the response is ephemeral and fits provider limits; corrections, excuses, participation start dates, optional meetings, deleted meeting history, and the operational reporting baseline match the canonical dashboard calculation; unlinked, inactive, wrong-server, disabled, unverified, unsigned, and malformed requests receive private actionable responses without attendance disclosure.
Verification: `npm run verify:api`; `npm run verify:docs` when command-registration guidance changes; focused signed-interaction coverage for successful, empty, long, linked/unlinked, inactive, wrong-server, disabled/unverified, and tampered requests plus parity with canonical reporting semantics; no live Discord traffic in automated tests.
Release: next Discord self-service feature bundle after WU-064 is integrated.

### WU-073 — Persistent-message attendance-report button

Status: ready

Goal: let a Discord-linked member request the same private attendance report from the persistent attendance-channel message without typing the slash command.
Dependencies: WU-065 and WU-072 (the managed persistent message and canonical attendance-report interaction must exist first)
Scope: add one attendance-report button to the LancerLogin-owned persistent attendance-channel message maintained by WU-065; route its interaction through WU-072's canonical linked-member lookup, report calculation, provider-limit handling, and ephemeral response; and ensure message creation, updates, and self-healing preserve exactly one current button. Preserve Discord interaction-signature verification, configured-server binding, provider verification, controlled mentions, channel isolation, member pairing, attendance privacy, idempotent persistent-message ownership, and slash-command behavior. Exclude a second report calculation, public report output, reports for another member, direct messages, unrelated message controls, and changes to attendance policy.
Sources: `docs/idea_inbox.md` (IN-086); WU-065; WU-072; `docs/INTEGRATIONS.md`; `docs/SECURITY.md`; `apps/api/src/index.ts`; Discord provider and interaction tests.
Acceptance: the one current managed persistent message contains a clearly labeled attendance-report button; a correctly signed click from the configured server returns the same ephemeral content and edge-case behavior as WU-072 for the clicking linked member; unlinked, inactive, wrong-server, disabled, unverified, unsigned, and malformed interactions disclose no attendance; persistent-message refresh or recreation does not duplicate or drop the button; the slash command remains unchanged.
Verification: `npm run verify:api`; focused provider-fake coverage for message create/update/recreation, one-button idempotence, slash/button response parity, linked/unlinked/inactive users, configured-server enforcement, disabled/unverified integrations, and tampered interactions; supported-server manual validation after both dependencies are integrated.
Release: later Discord self-service and designated-channel bundle with WU-065 and WU-072.

### WU-074 — One-way Google Calendar meeting sync

Status: blocked

Goal: optionally mirror LancerLogin meeting dates and times into one configured Google Calendar while keeping LancerLogin authoritative.
Dependencies: WU-061; product decision required on whether calendar access extends the existing Google sign-in integration or uses a separately enabled credential/consent record, whether LancerLogin deletion and restoration remove/recreate calendar events, and whether Google failures block meeting mutations or enter a durable retry queue
Scope: after the credential and failure-policy decisions are recorded, add an Admin-only optional Google Calendar configuration with one selected calendar and verified write access; create one mapped event for each created meeting occurrence; immediately push date/time edits for one occurrence or future series according to the dashboard mutation scope; persist installation-scoped mappings and retry/idempotence state; and never import Google-side changes. Transmit only start/end date and time plus the minimum stable generic event identity required for mapping—never meeting titles, notes, attendance, roster, or organization data. Preserve Google sign-in lockout protection, encrypted secrets/tokens, Admin-only integration configuration, Admin/Operator meeting-management roles, recurrence behavior, audit history, and LancerLogin as the source of truth. Exclude two-way sync, attendee invitations, reminders, descriptions, meeting-title sync, multiple calendars, historical backfill, and unrelated Google or Discord behavior.
Sources: `docs/idea_inbox.md` (IN-087); WU-061; current official Google Calendar API and OAuth guidance; `docs/ARCHITECTURE.md`; `docs/INTEGRATIONS.md`; `docs/SECURITY.md`; `docs/DASHBOARD.md`; `docs/UI-STANDARDS.md`; `apps/api/migrations/`; `apps/api/src/index.ts`; `apps/dashboard/src/integration-settings.tsx`; `apps/dashboard/src/meeting-management.tsx`; Google integration, meeting lifecycle/recurrence, Settings, and browser tests.
Acceptance: after the named decisions are recorded, only Admins can enable, authorize, select, rotate, or remove calendar access; a created occurrence maps to exactly one event in the configured calendar, and authorized occurrence/future-series edits update only mapped start/end values; retries cannot duplicate events; no Google-side change mutates LancerLogin; disabled, unverified, revoked, rate-limited, and unavailable-provider states follow the approved failure policy with actionable feedback; API responses never return saved credentials or refresh tokens; sign-in enablement and sole-Admin lockout safeguards remain independent and intact.
Verification: `npm run verify:migrations`; `npm run verify:api`; `npm run verify:dashboard`; `npm run verify:docs` when setup guidance changes; focused provider-fake coverage for authorization, calendar selection, create/update/series mapping, idempotence, retries, revocation, rate limits, disabled/unverified states, transmitted-field allowlisting, deletion/restoration per the approved policy, role enforcement, and Google sign-in isolation; focused responsive keyboard Settings and meeting-workspace browser coverage at required themes/viewports; manual supported-calendar validation before release.
Release: later Google Calendar integration bundle after WU-061 and the credential/failure-policy decisions are complete.

## Release bundling

- Release planning happens after units are merged. Create a release bundle from completed units that form a clear user-facing story and have compatible risk and deployment requirements.
- A production-blocking repair may justify a narrowly scoped `0.n.X` patch release. Otherwise, let completed units accumulate until the user chooses a release bundle.
- Before tagging, identify the included work units, update the matching `docs/releases/v0.n.n.md` notes, run the complete release gate, and follow the release procedure in `AGENTS.md`.
- A release or private-adopter deployment still requires explicit user authorization. Do not update the Pi unless the user specifically requests it.
