# Idea Inbox

This is LancerLogin's durable raw-intake record. Capture ideas in the Codex task titled **WU Idea Inbox**; that task appends them here without a commit. `$ll-inbox-process` triages `untriaged` entries and, after user approval, records their final disposition in the planning commit. An explicit inbox-sync request may commit the file earlier when remote backup or cross-device access is needed.

Do not implement work directly from this file.

## Entry format

```md
## IN-###

Status: untriaged | covered | promoted | discarded
Recorded: YYYY-MM-DD
Source: WU Idea Inbox
Request: <preserved raw user request>
Disposition: <WU ID(s), covered-by ID, or approved rationale; blank while untriaged>
```

## Entries

## IN-001

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Network Settings fails after local PIN entry because `nmcli device wifi rescan ifname wlan0` is not authorized by NetworkManager.
Disposition: WU-018

## IN-002

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: From the calendar, route a future meeting to its Meetings view and a current or past meeting to its Attendance view.
Disposition: WU-014

## IN-003

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Reports shows no data for All meetings, while Regular meetings returns meetings.
Disposition: WU-011

## IN-004

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Remove test meetings from the Reports dropdown and add Optional meetings, defined by Attendance required being unchecked.
Disposition: WU-011

## IN-005

Status: covered
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Make roster member names lead to a stable per-member deep link with stats, meeting history, and member actions; move Edit, Deactivate, and Delete from roster cards to that page.
Disposition: WU-006

## IN-006

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Perform a card-alignment polish pass, including vertically centering the Roster Members heading and shown count rather than leaving them too high in the header.
Disposition: WU-016

## IN-007

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Remove the displayed Active status from roster member entries.
Disposition: WU-016

## IN-008

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Add an editable member start date, defaulted to when the member was added to the roster; do not count or report absences for meetings before it.
Disposition: WU-012

## IN-009

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: In guided setup, make Finish and return a correctly formatted themed button.
Disposition: WU-016

## IN-010

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Do a full Data-page formatting pass for alignment and sizing, generally vertically centering elements rather than top-aligning them.
Disposition: WU-016

## IN-011

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Fix the overflowing sort dropdown shown in https://i.imgur.com/DdCqFYL.png.
Disposition: WU-011

## IN-012

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Add spacing between member names and IDs on the Reports page.
Disposition: WU-011

## IN-013

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Do not send Discord absence notices for meetings that have not started.
Disposition: WU-013

## IN-014

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: For a meeting that has not happened yet, replace every member's Absent bubble with a neutral muted state such as N/A.
Disposition: WU-013

## IN-015

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Keep the primary-theme gradient static across page navigation so its colors do not shift slightly and feel jarring.
Disposition: WU-015

## IN-016

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Add a Home-style calendar view above the Attendance meeting-selector dropdown.
Disposition: WU-014

## IN-017

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: On Kiosks, replace the Healthy status line with a vertically centered bubble and remove Recovery guidance unless it proves necessary.
Disposition: WU-017

## IN-018

Status: promoted
Recorded: 2026-09-02
Source: WU Idea Inbox
Request: Replace layout-shifting loading cards with animated loading overlays that do not move page content, consistently across similar pages.
Disposition: WU-015

## IN-019

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: When approving an attendance contest without a reason, do not silently fail and leave the contest open; validate clearly or handle the missing reason.
Disposition: WU-019

## IN-020

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Remove the Meetings-page Attendance required tooltip that reads Uncheck for an optional meeting.
Disposition: WU-020

## IN-021

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Disable meeting-template functionality.
Disposition: WU-021

## IN-022

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Diagnose Discord bulk-event sync: initial events fail with 403 Missing Permissions and later events fail with 429 rate limiting.
Disposition: WU-022

## IN-023

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Make the dashboard update card mimic the kiosk update card; move the update button into its first card; download backups without opening a blank tab; and open GitHub in a new tab rather than navigating away.
Disposition: WU-023

## IN-024

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Reduce excessive Data-management-card height (https://i.imgur.com/ToR1rmA.png); style and align Choose file; move delete-meeting confirmation to a post-click popup; remove the category guidance card; and remove the restart-onboarding card from Settings > Data.
Disposition: WU-024

## IN-025

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Refine guided setup: style Choose file; remove stored in d1 from logo selection; add spacing between theme selection and color buttons (https://i.imgur.com/CM9uDEb.png); remove light/dark preference text and synchronized-progress card; reduce padding above Save and continue; and add a top progress bar containing the percentage.
Disposition: WU-025

## IN-026

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Make Meetings-page checkboxes follow the active theme and rename the search header to Search Meetings.
Disposition: WU-020

## IN-027

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Fix the sort-field overflow within the Attendance leaderboard selector.
Disposition: WU-026

## IN-028

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Investigate the Reports All meetings regression: default All meetings still shows no results while Required/Regular meetings does, despite the last release explicitly claiming this was fixed; determine why verification missed it.
Disposition: WU-026

## IN-029

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Add missing vertical padding between the calendar and cards on the Attendance page.
Disposition: WU-027

## IN-030

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Lay roster action buttons out horizontally, not vertically, to prevent overly tall member rows (https://i.imgur.com/9H1rBUS.png).
Disposition: WU-028

## IN-031

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Vertically align the Roster-page shown count and Add member button (https://i.imgur.com/ytdn1ql.png).
Disposition: WU-028

## IN-032

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Replace oversized Dashboard Access radio selectors with compact slide toggles (https://i.imgur.com/UK2mU0G.png).
Disposition: WU-029

## IN-033

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: In Data management, hide the visible file selector behind a Restore file button and a validation/restore modal; make delete meetings and delete attendance each a single button with confirmation and warnings in a modal.
Disposition: WU-024

## IN-034

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Remove Contests awaiting review from Reports; show a pending-contests notifier in the upper right like update notifications; retain contests on the relevant meeting page.
Disposition: WU-030

## IN-035

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Remove the Settings > Configuration card that says Changes apply to every meeting after you save them.
Disposition: WU-031

## IN-036

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: When viewing a Settings sub-page, give the parent Settings item a bubble matching the active sub-page treatment.
Disposition: WU-031

## IN-037

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Remove the Settings > Integrations card that says Saved secret values are encrypted and never displayed.
Disposition: WU-031

## IN-038

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Remove the Settings > Organization card that reads Changes apply after you save them.
Disposition: WU-031

## IN-039

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Add a Roster column that appears when Discord integration is configured and shows a member's paired Discord ID.
Disposition: WU-032

## IN-040

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Add Discord pairing like the old system: a Discord command that accepts a member ID and pairs the Discord account with that member.
Disposition: WU-032

## IN-041

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Make the top-right Contests awaiting review notifier open a popup containing the same contest list as the card, so contests can be addressed there. In both views, show the contested date as well as the meeting name, and place the user ID next to the member name rather than next to the meeting title.
Disposition: WU-034

## IN-042

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Fix member deep links: clicking a member from Roster or Reports updates the browser URL to the member-detail route but does not change the displayed page. Use shared dashboard route state so the member-detail page renders after an in-app click.
Disposition: WU-035

## IN-043

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Show a member's Discord ID on their `/roster/[ID]` member-detail page.
Disposition: WU-036

## IN-044

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: On the member-detail page, show the Discord ID only when Discord integration is enabled; if integration is enabled but the member is unlinked, show a muted bubble indicating that state.
Disposition: WU-036

## IN-045

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Fix Attendance-page calendar selection: clicking a meeting does not properly switch the active meeting.
Disposition: WU-037

## IN-046

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Remove the Kiosk status is current. card from the Kiosks page.
Disposition: WU-038

## IN-047

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Add an enable toggle for each integration, defaulted off; show configuration options only when enabled. List integrations vertically with enabled entries above disabled ones, and render each disabled integration as one fully condensed row.
Disposition: WU-039
