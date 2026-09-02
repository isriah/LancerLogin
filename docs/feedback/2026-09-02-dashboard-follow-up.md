# Dashboard follow-up feedback - 2026-09-02

Status: collecting. Do not implement until the user explicitly reconciles this round and authorizes bulk execution.

## Attendance

1. Manual present notes must be optional.
   - Affected area: Attendance member action.
   - Expected behavior: marking a member present succeeds without a reason/note. Show a temporary success or failure bubble beside that member, not a page-level message.
2. Remove the resolved Discord attendance-contest audit card.
   - Screenshot: <https://i.imgur.com/JD89wYg.png>
   - Expected behavior: do not show an audited/resolved contest card at the top of Attendance. Show a temporary inline result beside the related member instead.
3. Provide two attendance rates.
   - Primary rate: present versus absent, without adjusting for excuses; display this rate in most product surfaces.
   - Excuse-adjusted rate: exclude excused meetings from both numerator and denominator; this is the robotics-class rate.
4. Hide the kiosk meeting ID from the Attendance meeting card.
5. Remove the always-positive "meeting data is current" card. Reserve this space for real loading or error states only.
6. Standardize card vertical padding across the dashboard, including the Attendance/Kiosk area, so adjacent cards align.

## Home navigation

1. Preserve the selected meeting when opening Attendance from the calendar.
   - Affected area: Home calendar and Attendance route.
   - Observation: selecting any meeting on Home currently opens Attendance at the same historical meeting instead of the meeting that was clicked.
   - Expected behavior: a calendar meeting opens Attendance with that exact meeting selected.
   - Implemented in v0.12.6: Home now passes a meeting-specific Attendance deep link, and Attendance honors the selected meeting ID.

## Kiosk simulator

1. Build the real browser-simulated kiosk.
   - It must render the physical kiosk interface and reuse its states and behavior, substituting browser controls for R503 hardware input.
   - Include normal scan behavior, protected maintenance, fingerprint enrollment/mappings, networking, and supported recovery/update states.
   - Simulator activity must remain visibly simulated/audited and must not become a physical active kiosk.

## Settings and updates

1. Move Discord contest settings and the late-scan allowance from Organization settings into a Settings sub-tab named Configuration.
   - Align the two controls cleanly in their new layout.
   - Screenshot: <https://i.imgur.com/3HPrkUB.png>
2. Reshape the kiosk update area to match the dashboard installed-versus-latest release comparison instead of a full-width card.
3. Move the dashboard access card that grants Operator/Admin powers into Settings.
4. Show a prominent update-available popup across the dashboard, including Home.
   - Observation: update availability is too easy to miss when a user remains on the Home screen.
   - Expected behavior: display a highly visible, dismissible popup when a compatible dashboard or kiosk update is available, with a clear route to the relevant update action.
5. Add active feedback and reliable acknowledgement for dashboard-triggered kiosk updates.
   - Observation: after requesting the kiosk update from 0.10.5 to 0.12.6, the dashboard showed no queued, in-progress, success, or failure state. Pi inspection confirmed that `lancerlogin-update.service` was never invoked and the kiosk remains on 0.10.5.
   - Expected behavior: surface a durable per-kiosk update state near the action, including request accepted/queued, device received, installing, success (with installed version), or actionable failure. The state must remain available after navigation or refresh until completion.
6. Move Guided Setup into its own Settings sub-tab.
   - Observation: reopening Guided Setup is currently located in Organization settings.
   - Expected behavior: expose Guided Setup as a dedicated Settings sub-tab and remove the redundant Organization placement.

## Reports

1. Keep CSV export as a secondary utility and add an operational reports view:
   - sortable attendance leaderboard by primary attendance rate, first name, and last name;
   - line graph of team primary attendance over a selectable meeting count or date period;
   - outstanding attendance contests with direct review action.
   - Show excuse-adjusted rate as a secondary class-oriented metric in the leaderboard.
2. Correct the attendance-report meeting scope.
   - Observation: member `9453898` is present for the three current meetings on Aug. 26, Aug. 28, and Aug. 31, but Reports shows 60%.
   - Investigation: Reports also includes two imported historical attendance meetings from May 28 and May 31 in the denominator, producing three present records out of five. The live trend chart confirms all five meetings are included.
   - Expected behavior: define the operational attendance-report baseline so imported historical records do not silently lower current-roster percentages. Preserve historical records and make the selected reporting period/baseline explicit.
3. Correct Reports card alignment.
   - Observation: the "Contests awaiting review" card is pushed far below the Team attendance trend card when the leaderboard is taller.
   - Expected behavior: position Contests directly below Team attendance trend with the standard vertical card gap, independently of the leaderboard height.

## Roster

1. Add one search field that matches member name, email, and ID together.
2. Add an Active-only versus All-members filter.
3. Correct the desktop roster action-button layout.
   - Screenshot: <https://i.imgur.com/sr3gjcD.png>
   - Observation: the roster action buttons are improperly formatted on desktop.
   - Expected behavior: show the related action buttons side by side on desktop and apply the established styled-button treatment consistently.
4. Add durable roster-member deep links and a member detail workspace.
   - Observation: selecting a member in Reports or another roster-oriented view does not open a reusable member-specific page.
   - Expected behavior: member names link to a stable route such as `/roster/<member-id>`. The page provides allowed member actions and detailed per-meeting attendance history, including check-in/check-out timestamps or an absence/excuse result for each completed meeting.

## Additional approved refinements

1. Add a member attendance drilldown.
   - Show meeting-by-meeting history and explain the numerator/denominator behind both attendance rates.
2. Support duplicating a meeting or starting from a meeting template.
   - Preserve typical timing and recurrence choices to reduce repeated scheduling work.
3. Add a privacy-safe kiosk diagnostics snapshot.
   - Include software version, uptime, reader state, network type/signal, last Wi-Fi scan, pending queue count, and actionable recovery guidance.
   - Do not expose credentials, raw scan data, or unrestricted logs.
4. Add useful Reports filters and saved views.
   - Prioritize date range, meeting type, and active-roster filters before expanding chart variety.
5. Use clear attendance-metric labels and short definitions wherever both rates appear.
   - Primary: "Attendance rate".
   - Secondary: "Excuse-adjusted class rate".
