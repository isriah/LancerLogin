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

## IN-048

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: When a contest is resolved or approved, automatically refresh the top-of-screen contest notifier so it clears when no pending contests remain.
Disposition: WU-034

## IN-049

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Replace the dark-mode/light-mode button with a toggle control.
Disposition: WU-040

## IN-050

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Fix the sort-dropdown overflow still shown in https://i.imgur.com/QJYzbFJ.png.
Disposition: WU-041

## IN-051

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Investigate the Reports-page Reporting period dropdown, which appears functionally useless. If it never has an option, remove it; if it does, explain what the option is before deciding what to do.
Disposition: WU-041

## IN-052

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Vertically center values in the table shown at https://i.imgur.com/znv288V.png instead of top-aligning them.
Disposition: WU-042

## IN-053

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: In the same table, place actions on the right rather than below the name area.
Disposition: WU-042

## IN-054

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: In the same table, vertically center the headers.
Disposition: WU-042

## IN-055

Status: covered
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Remove the Kiosks-page card reading Kiosk status is current.; the status is already visible in the kiosk-information card.
Disposition: WU-038 already removed this redundant successful-refresh message.

## IN-056

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Move the Replace kiosk button into the kiosk-information card.
Disposition: WU-043

## IN-057

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Add right-side padding to selection-dropdown arrows, which currently sit too far to the right (https://i.imgur.com/M7ow2UK.png).
Disposition: WU-041

## IN-058

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Add forward and backward arrows to calendar views for navigation.
Disposition: WU-045

## IN-059

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Rename Home to Dashboard while retaining `/dashboard`, and consolidate the current Home, Meetings, and Attendance navigation into a Dashboard-to-meeting-detail flow. Remove Meetings and Attendance from primary navigation after adding canonical `/meetings/[ID]` detail pages. Preserve old bookmarks by redirecting `/meetings` to Dashboard table view, `/attendance?meetingId=[ID]` to the matching meeting detail, and bare `/attendance` to Dashboard.
Disposition: WU-044, WU-045

## IN-060

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Make Dashboard the meeting browser. Present the existing five-week meeting calendar by default, add a toggle for the existing meetings table, remember the selected Calendar/Table view in that browser, and keep the same meeting dropdown and Add meeting action visible in both views. Calendar events, table meetings, and dropdown selections should all open the canonical meeting deep link.
Disposition: WU-045

## IN-061

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Turn the existing Create meeting card into an accessible popup opened from the Dashboard meeting-browser header. Preserve one-time and recurring creation, validation, duplication support, and existing best-effort Discord calendar sync. After success, close the popup, refresh the active Dashboard view and meeting selector, and announce how many meetings were created without navigating away.
Disposition: WU-046

## IN-062

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Add a canonical `/meetings/[ID]` detail page with no calendar. Show a Back to Dashboard action, a dropdown for switching meetings, the meeting title, date, start and end times, Upcoming/In progress/Late scan window/Past state, Required/Optional status, recurrence context, notes, and attendance closing time. Show the existing member attendance list and preserve all current attendance statuses, corrections, excuses, manual present/absent changes, clear actions, and member-local feedback. Add manual refresh and refresh attendance every 30 seconds while the attendance window is open.
Disposition: WU-044

## IN-063

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Put meeting-specific Discord controls and contests on `/meetings/[ID]`. Hide Discord controls unless Discord is enabled and verified; allow Discord calendar sync until the scheduled meeting end and mute it afterward; mute the Discord absence ping before the meeting starts and allow it from the scheduled start onward. Keep contest review on the relevant meeting detail and use the top-right notifier for access across all pending contests.
Disposition: WU-047

## IN-064

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Split meeting management by scope after the Dashboard redesign. Put Edit, Duplicate, and Delete on `/meetings/[ID]` in focused dialogs, preserving occurrence-versus-future-series behavior. After deletion, return to Dashboard with the existing Undo capability. Keep meeting search, selection checkboxes, bulk delete, and Sync all to Discord in Dashboard table view, and ensure selecting a meeting does not interfere with checkbox-based bulk selection.
Disposition: WU-048

## IN-065

Status: promoted
Recorded: 2026-09-03
Source: WU Idea Inbox
Request: Consolidate the non-meeting-specific utilities removed with the standalone Attendance page. Keep attendance CSV export in Reports, move persistent Discord kiosk-status sync into the Kiosks page beside its existing health information, replace the separate Home live-roster section with each meeting's detail roster, and remove the duplicate Home contest list after contest review is available from meeting details and the top-right notifier.
Disposition: WU-049
