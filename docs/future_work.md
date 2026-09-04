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

Implementation commits use the `WU-###:` prefix. If Codex produces a detached Worktree, retain it and record an explicit candidate commit/path; `$ll-integrate all` can propose it for review. Do not start a duplicate task for a WU with recorded branch, task, or candidate evidence.

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

Status: in progress

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
Release: v0.14.1 dashboard navigation and integration refinement.

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
Release: v0.14.1 dashboard navigation and integration refinement.

### WU-036 — Member-detail Discord identity

Status: ready

Goal: show Discord linkage clearly on a member's detail page only while Discord integration is enabled.
Dependencies: WU-039
Scope: add the member's paired Discord ID to `/roster/[ID]` when Discord is enabled; show a muted unlinked-state bubble when enabled without a pairing; hide the field when Discord is disabled. Preserve pairing, access control, and credential secrecy. Exclude pairing or integration-configuration changes.
Sources: `docs/idea_inbox.md` (IN-043, IN-044); WU-032; WU-039; `apps/dashboard/src/member-detail-page.tsx`; `apps/api/src/index.ts`; `docs/DASHBOARD.md`; `docs/INTEGRATIONS.md`.
Acceptance: enabled Discord shows either the paired ID or an accessible muted unlinked state on member detail; disabled Discord shows neither; no secret integration values are returned.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused conditional member-detail and authorization coverage.
Release: v0.14.1 dashboard navigation and integration refinement.

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
Release: v0.14.1 dashboard navigation and integration refinement.

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
Release: v0.14.1 dashboard navigation and integration refinement.

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
Release: v0.14.1 dashboard navigation and integration refinement.

### WU-041 — Reports selector clarity and spacing

Status: ready

Goal: keep Reports selectors legible and explain the operational reporting-period choice.
Dependencies: none
Scope: fix the clipped Attendance-leaderboard sort value; add sufficient right-side space around select arrows on the affected Reports controls; retain the operational-baseline versus preserved-history behavior and clearly explain when no baseline is configured. Exclude reporting calculations, baseline storage, and unrelated global form restyling.
Sources: `docs/idea_inbox.md` (IN-050, IN-051, IN-057); WU-002; WU-026; `apps/dashboard/src/reports-page.tsx`; `apps/dashboard/src/styles.css`; `tests-browser/dashboard-smoke.spec.ts`; `docs/DASHBOARD.md`.
Acceptance: every affected selector shows its selected value and arrow without clipping at supported widths; Reports explains that the operational-baseline option is available only when configured and otherwise clearly identifies preserved history as the active scope; existing report results remain unchanged.
Verification: `npm run verify:dashboard`; focused responsive browser geometry and reporting-period state coverage.
Release: v0.14.1 dashboard navigation and integration refinement.

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
Release: v0.14.1 dashboard navigation and integration refinement.

### WU-043 — Kiosk information-card action consolidation

Status: in progress

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
Release: v0.14.1 dashboard navigation and integration refinement.

### WU-044 — Canonical meeting-detail workspace

Status: ready

Goal: give every meeting one durable detail route containing its operational context and attendance workflow.
Dependencies: none
Scope: add `/meetings/[ID]` with Back to Dashboard and meeting-switcher controls; show meeting timing, lifecycle state, Required/Optional status, recurrence, notes, and attendance closing time; move the existing attendance roster, corrections, excuses, manual status changes, clear actions, and member-local feedback into this page; add manual refresh and refresh attendance every 30 seconds only while its attendance window is open; redirect `/attendance?meetingId=[ID]` to the matching detail route and bare `/attendance` to Dashboard. Preserve authorization, attendance semantics, audit behavior, and unknown-meeting handling. Exclude meeting editing, Discord actions, contests, and the Dashboard browser redesign.
Sources: `docs/idea_inbox.md` (IN-059, IN-062); WU-014; WU-035; WU-037; `apps/dashboard/src/attendance-workspace.tsx`; `apps/dashboard/src/app-shell.tsx`; `apps/dashboard/src/router.tsx`; `apps/api/src/index.ts`; `docs/DASHBOARD.md`; `docs/ARCHITECTURE.md`.
Acceptance: direct and in-app `/meetings/[ID]` navigation renders the requested meeting summary and complete attendance workflow; legacy Attendance bookmarks land at the correct replacement; manual refresh works; automatic refresh runs only while attendance is open; Back/Forward, permissions, and member-local outcomes remain correct.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused browser coverage for direct routes, redirects, meeting switching, lifecycle states, attendance actions, refresh timing, and responsive accessibility.
Release: v0.15.0 Dashboard and meeting-workspace redesign.

### WU-045 — Dashboard meeting browser and navigation

Status: ready

Goal: make Dashboard the single place to browse and select meetings.
Dependencies: WU-044
Scope: rename Home to Dashboard while retaining `/dashboard`; remove Meetings and Attendance from primary navigation; present the existing five-week calendar by default with forward/backward navigation; add a remembered Calendar/Table view toggle; keep the meeting dropdown and Add meeting action available in both views; make calendar events, table rows, and dropdown choices open `/meetings/[ID]`; redirect `/meetings` to Dashboard table view. Preserve browser history, role access, meeting search, and supported responsive layouts. Exclude the create dialog, meeting management dialogs, Discord actions, contests, and displaced-utility cleanup.
Sources: `docs/idea_inbox.md` (IN-058, IN-059, IN-060); WU-035; WU-044; `apps/dashboard/src/home-page.tsx`; `apps/dashboard/src/meetings-page.tsx`; `apps/dashboard/src/app-shell.tsx`; `apps/dashboard/src/router.tsx`; `apps/dashboard/src/styles.css`; `docs/DASHBOARD.md`; `docs/ARCHITECTURE.md`.
Acceptance: Dashboard offers remembered Calendar and Table meeting browsers with consistent selector and Add meeting access; calendar navigation changes the visible date range; every meeting selection opens its canonical detail route; primary navigation and legacy `/meetings` behavior match the approved design.
Verification: `npm run verify:dashboard`; focused desktop/mobile browser coverage for view persistence, calendar navigation, table search, selection routes, redirects, and Back/Forward behavior.
Release: v0.15.0 Dashboard and meeting-workspace redesign.

### WU-046 — Dashboard meeting-creation dialog

Status: ready

Goal: create meetings without leaving the active Dashboard meeting browser.
Dependencies: WU-045
Scope: move the existing creation fields into an accessible dialog opened from the Dashboard meeting-browser header; preserve one-time and recurring creation, validation, duplication support, and best-effort Discord calendar sync; after success close the dialog, refresh both active browser view and meeting selector, and announce the created count without navigation. Exclude edit/delete management and changes to recurrence or Discord policy.
Sources: `docs/idea_inbox.md` (IN-061); WU-008; WU-020; WU-045; `apps/dashboard/src/meetings-page.tsx`; `apps/dashboard/src/modal-focus.ts`; `apps/dashboard/src/styles.css`; `apps/api/src/index.ts`; `docs/DASHBOARD.md`.
Acceptance: keyboard and pointer users can open, complete, cancel, and recover validation errors in the dialog; successful one-time or recurring creation closes it, announces the correct count, and updates the currently selected Dashboard view and selector without changing routes.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused browser coverage for dialog focus, validation, duplication, recurrence, Discord-sync outcomes, refresh, and responsive layout.
Release: v0.15.0 Dashboard and meeting-workspace redesign.

### WU-047 — Meeting-detail Discord and contest operations

Status: ready

Goal: keep meeting-specific Discord and contest actions on the meeting they affect.
Dependencies: WU-034, WU-039, and WU-044
Scope: place eligible Discord calendar sync, absence notification, and contest review on `/meetings/[ID]`; hide Discord actions unless Discord is enabled and verified; allow calendar sync through scheduled meeting end and mute it afterward; mute absence notification before scheduled start and allow it from start onward; retain the top-right notifier for all open contests. Preserve signed-provider boundaries, review reasons, contest outcomes, and audit history. Exclude global Discord configuration and non-meeting utility relocation.
Sources: `docs/idea_inbox.md` (IN-063); WU-022; WU-030; WU-034; WU-039; WU-044; `apps/dashboard/src/meetings-page.tsx`; `apps/dashboard/src/attendance-workspace.tsx`; `apps/dashboard/src/contest-indicator.tsx`; `apps/api/src/index.ts`; `docs/INTEGRATIONS.md`; `docs/DASHBOARD.md`; `docs/SECURITY.md`.
Acceptance: verified enabled Discord exposes only time-eligible meeting actions; disabled or unverified Discord exposes none; meeting contests are reviewable with existing validation and audit behavior; the global notifier still reaches all pending contests and refreshes after resolution.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused authorization, provider-state, timing-boundary, contest-resolution, notifier, and browser coverage.
Release: v0.15.0 Dashboard and meeting-workspace redesign.

### WU-048 — Split meeting management by scope

Status: ready

Goal: put single-meeting management on meeting detail while retaining bulk operations in Dashboard Table view.
Dependencies: WU-044 and WU-045
Scope: move Edit, Duplicate, and Delete to `/meetings/[ID]` in focused accessible dialogs; preserve occurrence-versus-future-series behavior; after deletion return to Dashboard with existing Undo capability; retain search, selection checkboxes, bulk delete, and Sync all to Discord in Dashboard Table view; prevent row navigation from toggling or disrupting checkbox selection. Exclude meeting creation and Discord policy changes.
Sources: `docs/idea_inbox.md` (IN-064); WU-008; WU-021; WU-044; WU-045; `apps/dashboard/src/meetings-page.tsx`; `apps/dashboard/src/modal-focus.ts`; `apps/dashboard/src/styles.css`; `apps/api/src/index.ts`; `docs/DASHBOARD.md`.
Acceptance: detail-page dialogs correctly manage an occurrence or its future series; successful deletion returns to Dashboard and can be undone; table bulk selection and row navigation remain independent; search, bulk delete, and Sync all retain their outcomes.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused recurrence-scope, deletion/Undo, dialog accessibility, checkbox isolation, bulk action, and browser coverage.
Release: v0.15.0 Dashboard and meeting-workspace redesign.

### WU-049 — Consolidate displaced meeting utilities

Status: ready

Goal: give utilities displaced by the Dashboard redesign one clear, non-duplicated home.
Dependencies: WU-044, WU-045, and WU-047
Scope: retain attendance CSV export in Reports; move persistent Discord kiosk-status sync beside physical health information on Kiosks and gate it on enabled-and-verified Discord; rely on each meeting detail for its live roster; remove the duplicate Dashboard contest list only after meeting-detail review and the refreshed global notifier are available. Preserve authorization, provider verification, kiosk health behavior, exports, and contest access. Exclude new Discord capabilities and report redesign.
Sources: `docs/idea_inbox.md` (IN-065); WU-030; WU-039; WU-044; WU-045; WU-047; `apps/dashboard/src/home-page.tsx`; `apps/dashboard/src/attendance-workspace.tsx`; `apps/dashboard/src/reports-page.tsx`; `apps/dashboard/src/kiosks-page.tsx`; `apps/api/src/index.ts`; `docs/DASHBOARD.md`; `docs/KIOSK.md`; `docs/INTEGRATIONS.md`.
Acceptance: CSV export remains in Reports; authorized kiosk-status sync appears on Kiosks only when Discord is enabled and verified; Dashboard no longer duplicates live-roster or contest content; meeting detail and the global notifier remain complete replacement paths.
Verification: `npm run verify:api` and `npm run verify:dashboard`; focused Reports export, Kiosks integration gating, contest-access, navigation, and combined browser coverage.
Release: v0.15.0 Dashboard and meeting-workspace redesign.

## Release bundling

- Release planning happens after units are merged. Create a release bundle from completed units that form a clear user-facing story and have compatible risk and deployment requirements.
- A production-blocking repair may justify a narrowly scoped `0.n.X` patch release. Otherwise, let completed units accumulate until the user chooses a release bundle.
- Before tagging, identify the included work units, update the matching `docs/releases/v0.n.n.md` notes, run the complete release gate, and follow the release procedure in `AGENTS.md`.
- A release or private-adopter deployment still requires explicit user authorization. Do not update the Pi unless the user specifically requests it.
