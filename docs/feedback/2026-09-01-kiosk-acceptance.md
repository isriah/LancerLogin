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
