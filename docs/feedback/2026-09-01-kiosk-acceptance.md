# Physical kiosk acceptance feedback - 2026-09-01

Status: physical kiosk revision batch implemented locally and applied to the test Pi where noted below. Later feedback remains queued until the user finishes collecting and explicitly authorizes another bulk execution pass.

## Items

1. Network settings list only the current network.
   - Affected area: physical Raspberry Pi kiosk, PIN-protected network settings.
   - Observation: the Wi-Fi screen shows only the single network the Pi is already connected to and does not list other visible networks.
   - Expected behavior: the kiosk should scan and show available Wi-Fi networks, including networks other than the active connection, while still avoiding password storage or display.
   - Acceptance notes: verify on the physical Pi with NetworkManager and confirm the list refreshes without exposing saved credentials.

2. Kiosk brand/logo header needs dynamic physical-screen layout.
   - Affected area: physical Raspberry Pi kiosk top brand area.
   - Observation: the logo next to the organization name is very small, and part of it appears blacked out.
   - Expected behavior: dynamically position the organization name `RoboLancers Testing Co.`, subtitle `FRC321`, and the logo between them at the top of the screen, resizing to accommodate different logo sizes.
   - Design dependency: apply the same transparent-logo contrast and light/dark color logic used by the web dashboard.
   - Acceptance notes: verify with the current test organization branding on the 800x480 Waveshare display, then test with at least one light-background transparent logo and one dark-background transparent logo.

3. Fingerprint maintenance long-press does not open.
   - Affected area: physical Raspberry Pi kiosk top brand/organization-name hold target.
   - Observation: holding the logo and holding the organization name did not open fingerprint maintenance.
   - Expected behavior: the physical kiosk should provide a reliable touch path into PIN-protected fingerprint maintenance.
   - Acceptance notes: consider a visible maintenance affordance or stronger hold feedback while preserving local-only access and PIN protection.

4. Fingerprint enrollment action is incorrectly styled and unresponsive.
   - Affected area: physical Raspberry Pi kiosk fingerprint maintenance enrollment form.
   - Observation: after selecting a user, finger, and sensor slot, the button to begin scanning is purple instead of following the configured organization theme. It initially appeared not to respond to clicks, but may have been silently listening for fingerprint reads without visible staged feedback.
   - Expected behavior: the primary enrollment action should use the organization theme colors and reliably start the two-scan enrollment flow on the touch display.
   - Design dependency: reference and emulate the pre-community fingerprint enrollment workflow, including color cues and clear on-screen prompts for waiting, accepted first scan, remove finger, waiting for second scan, success, and failure states.
   - Layout expectation: the fingerprint maintenance window should fit the 800x480 physical kiosk screen without a scroll bar if possible.
   - Acceptance notes: verify the button state, touch/click handler, form submission, selected-member/finger/slot payload, visible two-scan prompts, color cues, and no-scroll maintenance layout on the physical kiosk. Keep biometric templates inside the R503 and store only the local slot mapping.

## Execution considerations

- Preserve the v0.9 single-active-kiosk, local-only maintenance, fingerprint-storage, and no-credential-display boundaries.
- Keep the copied pre-community scan-screen proportions that fixed the top-half display issue unless a later approved item explicitly revisits that layout.
- Network diagnostics may require inspecting NetworkManager output on the Pi, but should not alter saved networks except during an explicitly approved connection test.

## Next dashboard and release-management batch

Status: partly implemented during the authorized follow-up pass, then paused by user request to keep later feedback saved instead of continuing into another round.

1. Remove the test-meeting checkbox and feature.
   - Implemented: the dashboard meeting form no longer exposes test meetings; setup no longer has a test-meeting step; the simulator now uses an Admin-selected active meeting instead of a special test flag.
2. Simplify meeting scheduling around one calendar date plus start/end times.
   - Assume all meetings start and end on the same day.
   - Do not state that assumption in the start/end fields.
   - Selecting a start time should autofill the end time to 2.5 hours later.
   - Implemented: create/edit forms compose a date plus start/end time into the existing ISO API contract. Start changes autofill the end time to 150 minutes later, capped to the selected date.
3. Add meeting deletion, including future-series deletion.
   - One-time meetings should be deletable.
   - For a recurring series, selecting an occurrence should allow deleting that occurrence and all later occurrences while preserving earlier ones.
   - Implemented as soft deletion: meetings are hidden from active scheduling, scanning, attendance pages, exports, and Discord processing while attendance/audit history stays in D1.
4. Ensure meeting creation syncs to the Discord calendar automatically if it does not already.
   - Add a way to sync all existing meetings to the Discord calendar.
   - Syncing existing meetings must not duplicate events that already exist.
   - Implemented: creation requests best-effort Discord calendar sync after D1 write; the Meetings page has a sync-all action; existing Discord event mappings are patched instead of duplicated.
5. Fill dead space across pages and implementations.
   - Reference screenshot: <https://i.imgur.com/rIHfItd.png>
   - Observation: the area to the right of the Create Meeting card is empty even though nothing else uses that space.
   - Expected behavior: cards and page content should expand intelligently to use available empty space.
   - Implemented initial pass: meeting create/edit forms and update cards now use available page width instead of narrow max-width caps.
6. Add kiosk self-update management.
   - Kiosk updates should be manageable from Settings > Updates and from the Kiosks page.
   - When the kiosk is online, a single button should prompt it to pull the latest compatible GitHub release and automatically update itself.
   - Review the private Upgrade workflow's final confirmation option. It appears to duplicate the selected action and slug, so determine whether it can be calculated from those inputs instead.
   - Not implemented yet. The requested one-click Pi self-update requires granting the kiosk service a persistent root-level update path. That security decision needs explicit approval before code changes. The private Upgrade workflow confirmation is still retained as an intentional destructive-action guard.
7. Standardize version display format.
   - Some areas use `n.n.n`; others use `vn.n.n`.
   - Pick one format and apply consistently.
   - Until further notice, keep releases in the `0.n.n` namespace.
   - Reserve `1.0.0` for a future major release after product acceptance.
   - Use `0.n.X` releases for very small bug fixes.
   - Implemented for dashboard app surfaces: versions display as plain semantic versions such as `0.10.0`. Git tags and release-note filenames keep the existing `v0.10.0` convention for release automation.

## Holding queue

The user is still gathering the next feedback round. Record new observations here, but do not begin implementing another round until the user explicitly says the feedback is reconciled and ready for bulk execution.

### Next physical kiosk polish batch

1. Remove the visible `FP` shortcut.
   - Observation: the physical kiosk currently shows an `FP` icon in the top-right corner.
   - Expected behavior: fingerprint enrollment should return to a secret long-press on the logo/brand area, without a visible fingerprint shortcut.
   - Implemented: the visible shortcut is removed, and the organization brand shows a held-state outline during the three-second long-press.
   - Acceptance notes: verify the hidden gesture is reliable on the 800x480 touch display.
2. Hide maintenance content until the PIN is accepted.
   - Observation: the reader, enroll, and mappings cards are visible before entering the maintenance PIN.
   - Expected behavior: before unlock, the only visible maintenance UI should be PIN entry.
   - Implemented: the maintenance screen now enforces hidden content with CSS and keeps the pre-unlock view centered on PIN entry only.
   - Acceptance notes: no reader state, member names, mapping slots, or enrollment controls should be visible before successful PIN entry.
3. Replace the member dropdown with a touch-friendly selector.
   - Observation: the scrolling dropdown for member selection in fingerprint enrollment is not touch friendly.
   - Expected behavior: member selection should behave like a mobile-friendly picker with large rows, clear selected state, and natural scrolling.
   - Implemented: roster member selection now opens a touch-sized picker sheet with large rows and search.
   - Acceptance notes: verify touch scrolling, row selection, search/filter behavior, and no accidental page scroll on the Waveshare display.
4. Use a popup numeric keypad for slot entry.
   - Observation: the slot number text input does not open an on-screen keyboard and browser increment/decrement arrows are awkward on touch.
   - Expected behavior: remove number-stepper arrows and show a numeral-only popup keypad for slot entry.
   - Implemented: slot entry uses a read-only input and popup numeral keypad with browser stepper arrows removed.
   - Acceptance notes: verify slot 0-199 entry on the physical kiosk.
5. Translate fingerprint enrollment errors into user-friendly language.
   - Observation: reenrolling a finger that is already saved/recognized can surface a raw sensor error such as `0x0a`.
   - Expected behavior: non-technical users should see plain-language recovery guidance without needing sensor protocol context.
   - Implemented: known R503 codes now map to plain-language enrollment guidance; the `0x0a` case is covered by a regression test.
   - Acceptance notes: verify real reader failures show recovery guidance instead of protocol codes.
6. Investigate pre-community roster and fingerprint mapping migration.
   - Question: can the roster and fingerprint mappings be ported from the pre-community-edition installation into a LancerLogin installation when using the same physical fingerprint sensor?
   - Expected behavior: provide a migration path if the old install has roster/member identifiers and slot mappings that can be matched to the new roster.
   - Implemented: added a file-based helper that converts exported roster CSV and legacy slot mapping JSON into dashboard roster CSV, kiosk `slot-mappings.json`, and an import review report.
   - Acceptance notes: do not extract or transfer biometric templates from the sensor. Preserve the templates already stored on the same R503 sensor slots and manually review unmatched member IDs before copying mappings onto the Pi.

### Safety-gated items not completed in this pass

1. One-click kiosk self-update remains blocked.
   - Requested behavior: queue a dashboard command that lets the kiosk pull and apply the latest compatible GitHub release automatically.
   - Blocker: the implementation requires a persistent Polkit-approved root execution path that downloads and executes release code on the Pi. The safety reviewer rejected the patch pending exact explicit approval of that privilege and supply-chain risk.
2. Removing the private deployment workflow typed confirmation remains blocked.
   - Requested behavior: calculate the final confirmation from selected operation and slug.
   - Blocker: the workflow changes Cloudflare account resources, and removing the typed confirmation weakens a persistent safety guard. The safety reviewer rejected the patch pending exact explicit approval.

### Next feedback collection - layout, meetings, attendance, kiosk status, typography

Status: queued. Do not implement until the user explicitly reconciles this round and switches to execution.

1. Fingerprint maintenance slot selector overflows its card.
   - Affected area: physical kiosk fingerprint maintenance enrollment form.
   - Observation: the slot selector box extends off the side of the card.
   - Expected behavior: the slot control should stay inside the card at 800x480, preserve touch-sized hit targets, and avoid horizontal overflow.
   - Acceptance notes: verify on the physical Waveshare display and in the 800x480 browser smoke test.
2. Slot number keypad popup overflows its popup card.
   - Affected area: physical kiosk fingerprint maintenance numeric slot keypad.
   - Observation: the input keypad for the slot number extends off the side of the popup card.
   - Expected behavior: the keypad should fit inside its dialog, keep readable/touchable keys, and remain usable without page scrolling.
   - Acceptance notes: test one-, two-, and three-digit slots, including 0 and 199.
3. Wi-Fi network list still only shows the connected network.
   - Affected area: physical kiosk network settings.
   - Observation: the selector still shows only the single Wi-Fi network already connected, even though other networks are available and were previously visible.
   - Expected behavior: the list should rescan and show all nearby visible networks, with the active network marked.
   - Acceptance notes: diagnose with NetworkManager on the Pi, comparing raw `nmcli` output to the kiosk API response before changing parsing or permissions.
4. Discord sync confirmation appears at the top of the Meetings page.
   - Affected area: dashboard Meetings page.
   - Observation: the sync-to-Discord confirmation can appear off screen at the top.
   - Expected behavior: success and error messages should appear next to the item or action they relate to, especially for off-screen table/card actions.
   - Acceptance notes: test sync-one, sync-all, success, and failure states.
5. Consolidate meeting deletion actions.
   - Affected area: dashboard Meetings page.
   - Observation: meetings currently expose separate Delete and Delete future buttons.
   - Expected behavior: one-time meetings should delete after confirmation. Recurring meetings should open a confirmation dialog with Delete this meeting and Delete this and future meetings options, listing affected future events.
   - Acceptance notes: confirm a non-recurring delete, a single occurrence delete, and a future-series delete, with prior occurrences preserved.
6. Split meeting table start information into separate columns.
   - Affected area: dashboard Meetings page.
   - Observation: the Start column contains both date and time.
   - Expected behavior: show Date, Start, and End as separate columns.
   - Acceptance notes: ensure responsive behavior remains readable on narrow screens.
7. Add immediate undo after meeting deletion.
   - Affected area: dashboard Meetings page.
   - Expected behavior: after deleting a meeting or future series occurrences, show an immediate undo affordance that restores the deleted meeting(s). The undo can disappear after refresh or the next action.
   - Acceptance notes: verify undo restores table visibility and Discord sync state does not duplicate events.
8. Attendance meeting selector text is cut off.
   - Affected area: dashboard Attendance page.
   - Observation: the View attendance for selector cuts text off the edge.
   - Expected behavior: each option should show the date, then the meeting name, without the meeting time. Long date/name text should truncate cleanly with an ellipsis.
   - Acceptance notes: test long meeting names and narrow viewport widths.
9. Theme the Send Discord absence notice button.
   - Affected area: dashboard Attendance page.
   - Observation: the button is still unthemed.
   - Expected behavior: use the same primary color and rounded profile as other primary dashboard buttons.
10. Remove Link Discord from individual meeting attendance actions.
    - Affected area: dashboard Attendance page.
    - Expected behavior: Discord linking should be handled from the Roster page, not per-member attendance rows.
11. Remove per-member email actions from Attendance.
    - Affected area: dashboard Attendance page.
    - Expected behavior: remove Email missed and Email report actions from each member row.
12. Restore traditional kiosk network status icon.
    - Affected area: physical kiosk normal scan screen.
    - Observation: the circular network status symbol looks odd.
    - Expected behavior: return to the pre-community-style Wi-Fi reception bars with color state and a small adjacent icon. Show an Ethernet icon instead of Wi-Fi when connected by Ethernet.
    - Acceptance notes: verify Wi-Fi online, Ethernet online, cloud offline, and queued/offline states.
13. Replace bottom clock with kiosk uptime.
    - Affected area: physical kiosk normal scan screen footer.
    - Observation: the third bottom item currently shows the time of day.
    - Expected behavior: show kiosk uptime instead. The counter should reset when the display/runtime service restarts, the system crashes, or the kiosk process restarts.
    - Acceptance notes: define whether uptime starts at browser load, kiosk service start, or successful service health start before implementation.
14. Establish a larger typography scale.
    - Affected area: dashboard and physical kiosk surfaces.
    - Request: increase font sizes across the board after reviewing current styling rules.
    - Current dashboard rules: base text inherits browser default, page `h1` uses responsive clamps around 2.1rem to 3.6rem, `h2` is about 1.55rem, table text is about .78rem, table headers about .68rem, labels about .82rem, and standard controls have at least 2.75rem height.
    - Current kiosk scan-screen rules: main message is 48px, supporting text 24px, member name 30px, meeting text 20px, footer 18px, with slightly smaller values under 520px height.
    - Current kiosk maintenance rules: headings are 28px and 20px, labels 14px, table text 13px, status message 15px, keypad buttons 20px, enrollment prompt 30px/18px, with smaller values under 520px height.
    - Design dependency: choose a standard typography scale for dashboard tables/forms, dashboard page content, kiosk scan state, kiosk maintenance forms, and kiosk modal/keypad controls before implementation.
15. Make bulk Discord calendar sync resilient and explain partial results.
    - Affected area: dashboard Meetings page and the Discord scheduled-event API adapter.
    - Observation: Sync all to Discord displayed `Discord rejected the request (400)`, while some calendar events appeared to have been added.
    - Current behavior: the server syncs meetings sequentially and aborts on the first Discord error. Successfully created/updated earlier events remain in Discord, but the UI receives only a generic status and no meeting-level result.
    - Likely validation sources: a past meeting, Discord's 100 active/scheduled-event limit, or a meeting title/notes exceeding Discord's 100-character name or 1,000-character description limits. The current UI permits 120-character titles and 2,000-character notes.
    - Expected behavior: continue through eligible meetings, preserve a per-meeting outcome, show partial success beside Sync all, identify the affected meeting, and safely surface actionable Discord validation detail. Skip historical meetings with an explicit reason and avoid duplicate events through the existing mapping table.
    - Acceptance notes: test a mixed historical/future set, a title over 100 characters, notes over 1,000 characters, an existing mapped event, a missing/deleted mapped event, and an event-limit rejection.
16. Theme the Sync all to Discord action.
    - Affected area: dashboard Meetings page.
    - Observation: the Sync all to Discord button does not use the organization theme like other primary actions.
    - Expected behavior: apply the standard primary button color, contrast, rounded profile, hover/focus states, and disabled/loading treatment used by other dashboard commands.
