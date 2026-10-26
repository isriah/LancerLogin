# Dashboard guide

This guide is for Administrators and Operators. An Administrator configures the installation and manages access. An Operator manages permitted attendance work but cannot open administrative settings.

## Page walkthroughs

First-visit walkthroughs introduce Dashboard, Outreach, Roster, member detail, Reports, meeting attendance, Kiosks, and the Administrator browser simulator. Settings and its subpages do not have walkthroughs. Member records share one member-detail walkthrough, meeting records share one meeting-workspace walkthrough, and all Leaderboard and saved-report routes share one Reports walkthrough.

On Dashboard, **Start walkthrough** introduces the navigation, meeting calendar, searchable table, and meeting form. You can practice changing views, searching, selecting meetings, and filling the form. The **Practice preview** cannot save or delete meetings. Your previous calendar position, view, search, and selections return when you finish or exit. The final **Add meeting** action opens a fresh, normal form where you can save a real meeting.

The other page walkthroughs explain the visible controls without sending provider actions or device commands. The Outreach guide follows dated activities, public or Discord member submissions, Submission Log review, activity-scoped corrections, staff manual-entry exceptions, and the handoff to Reports. Create, rename, archive, or reopen Outreach labels from the **Labels** subtab, then assign active labels to activities. The activity calendar and table show scheduled events by default. Open **Visibility** to include Team support or Other service without removing them from the direct Activity selector. The activity-level **Corrections** indicator appears only while a request needs review. In the Reports guide, **Add example report** optionally saves and pins a personal **Monthly attendance example** using your roster, current-month attendance counts, labels, and report-period policy results. The report remains after the tour and can be edited or deleted normally. Skipping the option creates nothing.

The Kiosks guide covers diagnostics, pairing, naming, selectable authentication, local maintenance, restarts, PIN recovery, updates, and retirement. If no physical kiosk is paired, the tour shows a clearly labeled example with disabled management controls. It disappears when the tour closes and never creates a device record. Existing kiosks remain unchanged.

Choose **Not now** to receive the invitation on a later visit, or **Don't show automatically again** to stop automatic invitations for that page. Progress is recorded separately for each page and follows your signed-in account across browsers and devices. Completing a walkthrough stops its automatic invitations.

Page walkthroughs are separate from Guided Setup. Reopening or resetting setup does not reset them.

## Navigation and access

After sign-in, the primary navigation contains **Dashboard**, **Roster**, **Reports**, and **Kiosks**. **Settings** gives both roles theme and sign-out controls. Administrators have separate **Organization**, **Configuration**, **Access**, **Integrations**, **Data**, **Guided Setup**, and **Updates** pages.

An unfinished installation opens Guided Setup instead of the normal dashboard for Administrators. Any Administrator can resume its shared progress. Operators do not complete or reset Guided Setup.

| Area | Administrator | Operator |
| --- | --- | --- |
| Dashboard and meeting details | Create, edit, duplicate, and delete meetings; manage attendance | Create, edit, duplicate, and delete meetings; manage attendance |
| Reports and roster | Manage roster; create personal or shared reports; export reports | View roster; create personal or shared reports; export reports |
| Kiosks | Pair, name, retire, and manage maintenance actions | View status and use permitted attendance operations |
| Settings | Full access | Theme and sign-out only |

Roster membership does not grant dashboard access. An Administrator creates, links, deactivates, or changes dashboard roles in **Settings → Access**.

## Run attendance

1. Open **Dashboard**. Choose the Calendar or Table view, then select a meeting to open its detail page.
2. Use **Add meeting** to create a one-time or recurring meeting. Every meeting needs an end time. Attendance windows cannot overlap.
3. During an eligible meeting, the kiosk resolves the meeting from the scan time. A single arrival is **Active · not checked out**. A completed arrival and departure is **Present**. After the meeting end plus the organization-wide late scan allowance, an incomplete pair is **Absent** unless a correction or excuse overrides it.
4. In the meeting workspace, choose **Present**, **Excuse**, or **Absent** when a correction is needed. **Excuse** and **Absent** require a reason; **Present** accepts an optional note. An Administrator can also choose **Clear** to remove recorded attendance for one attendee and meeting. Source scans and correction history remain available for auditability.

Use **Configuration** to set the organization-wide late scan allowance, late-arrival and early-departure limits, optional reporting baseline, and reusable meeting-weight categories. Those limits do not change a recorded attendance outcome.

Attendance contest review supports individual or bulk acceptance and rejection. Filter by name, member ID or meeting, select specific entries or **Select all filtered contests**, and enter one **Shared review reason**. **Accept selected contests** marks those members present and records a separate resolution and audit entry for each contest. **Reject selected contests** records a separate rejection and audit entry for each selected contest without changing attendance. Changing the filter clears the selection, so hidden entries are never included. Successfully resolved items leave the review list; failures remain with their error and can be retried without resubmitting successful entries.

Members may contest a rejected absence again while the original notice is still within its contest window. **Previous reviews** shows earlier rejection reasons on the new request, and submitted-contest counts include each attempt. An Admin can turn on **Block re-contests after rejection** in **Settings → Integrations → Discord bot** to prevent another request after rejection. Approved requests and requests resolved with **Keep attendance** stay closed.

## Roster and reports

In **Roster**, an Administrator can select **Add member** or import a CSV. The importer previews changes before writing. Required columns are `memberId`, `firstName`, and `lastName`; `email`, `discordUserId`, and `attendanceRequiredFrom` are optional. Replacing the active roster makes omitted people inactive and preserves their attendance history and dashboard accounts.

**Reports** opens a routed tab workspace. **Leaderboard** is always first and keeps its own period, meeting, roster, label, membership, sorting, and pagination controls. It also contains policy alerts, the team regular-attendance trend, and any attendance contests awaiting review. Choose 25, 50, 100, or all matching members per page.

Saved reports appear as account-synced tabs. **Browse reports** finds accessible personal and shared reports, and **+** opens one unsaved draft. Closing a tab unpins it without deleting the report. A direct report link pins that report for the signed-in account. Administrators and Operators can create, edit, or delete shared reports. A personal report is visible only to its owner. Saved reports open in a read-only view that shows their current settings; select **Edit** before changing filters, sorting, or columns.

The report builder supports fixed and rolling periods, active or complete roster history, required/optional/all meetings, Any or All matching across multiple labels, and current or historical label membership. **Member** is the first required column. While editing, use **Add column** at the right edge of the results table to choose curated roster, regular-attendance, policy, count, and date-list columns. Label-specific policy choices are grouped by result type, followed by a searchable label selection. Open a column heading to sort, move, or remove it, or drag movable headings left and right. Column heading menus offer Contains and Equals for text, and Equals, Minimum, Maximum, and Between for numbers and dates. Dates also retain Contains for older saved filters. Between includes both endpoints; choose Apply range after entering both values. Is empty and Is not empty distinguish missing values from zero. Unavailable module data stays unavailable, rather than matching an empty filter. Duration thresholds use the selected hours or minutes and convert when units change. Text comparisons ignore case. Filters are preserved in saved reports and apply to CSV exports. Results refresh after a short delay and paginate without saving the current page in the report definition. Official policy columns keep their configured windows. Report-period policy columns recalculate inside the report dates while preserving dated rule periods.

In saved reports, **Current membership** uses each member's labels today throughout the selected report period, including meetings before those labels were assigned. For a monthly class report, select **Current month**, the class label, and its **Report-period policy result** column. There is no need to backdate label assignments. **Historical membership** uses the labels held on each meeting date. Both modes still respect attendance-required start dates, meeting audiences, completed attendance windows, policy rule periods, and the policy's excuse handling. This report setting does not rewrite label history or change official policy results.

**Download report CSV** exports every matching member using the selected columns and order. **Download detailed attendance CSV** exports the filtered meeting-level records with the existing explicit `regular*` and `policy*` fields. Both exports use the report's membership selection; detailed `policyRate` and other official policy summary fields retain their configured windows and dated membership. Both exports escape CSV values and neutralize spreadsheet formulas. A browser-local report view from an older release appears in **Browse reports** as an unsaved imported draft and is removed only after saving or dismissal.

## Kiosks and simulator

Administrators can open **Rejected scans** on the Kiosks page to review uploaded evidence from active or retired devices. The **Needs review** and **Reviewed** lists remain available even when no kiosk is currently paired. Expand a record to inspect its IDs, rejection reason, original scan time, cloud receipt time, and any clock evidence. An unverified kiosk clock may have recorded the wrong date or time. Use Attendance to apply a correction supported by your event records, then add a review note and select **Mark reviewed**. This action records the review without changing attendance or inventing arrival and departure times. Failed reviews retain the note for retry. The review timestamp is when the cloud recorded the review, including reviews uploaded later by a kiosk.

Filter rejected scans by kiosk and rejection reason, then select individual records, **Select this page**, or **Select all matching**. Check the selected count, enter a shared review note, and confirm **Dismiss scans**. Dismissal marks those scans reviewed, retains their evidence and records a separate audit entry for each newly reviewed scan. Attendance is unchanged, and existing review notes are preserved. The selection is fixed to the records in the loaded view, so new uploads are not included. A dismissal supports at most 500 scans in one atomic request; larger sets require a narrower filter or a selected page. A failed request preserves the selection and note for retry, and a successful dismissal returns to the first page. Reviewed status synchronizes back to the originating kiosks through their normal retained-scan synchronization.

Open **Kiosks**, select a device, and choose **Manage kiosk → Diagnostics** to review its pairing, reader, network, pending scans, last successful sync, installed release, and heartbeat. The selected device's **Manage kiosk** page also groups Administrator controls under **Authentication settings**, **Device maintenance**, and **Retire kiosk**. Administrators can choose **Add kiosk**, download the guided Pi installer, and create a time-limited pairing key without interrupting existing kiosks. Paste that key into the new Pi's local pairing page.

Administrators can select fingerprint, RFID badge, NFC badge, member ID, or QR code authentication for each device under **Manage kiosk → Authentication settings**. Fingerprint remains selected for existing installations until an Administrator changes it. The page shows the configured method separately from the method most recently reported by each selected kiosk. A pending message means that kiosk has not yet applied or acknowledged the new selection. Use **Authentication maintenance** separately at each Pi for fingerprint enrollment or local badge and QR mappings; member ID entry needs no enrollment.

Organization-wide cloud storage controls are in **Settings → Attendance → Fingerprint sharing**. Fingerprint recovery remains a separate Attendance settings section.

### Re-enroll older fingerprints

The **Fingerprint re-enrollment** card in **Settings → Attendance → Fingerprint recovery** replaces legacy identity review. Staff re-enroll members through **Authentication maintenance** on an online kiosk. Older and review-derived mappings cannot be approved for sharing by looking up a member ID. New online enrollments retain immutable roster identities and can use optional automatic sharing.

To start over, back up protected kiosk state, use the explicit mappings reset below, and wait for every active kiosk to acknowledge it before re-enrolling. Reader templates remain. Replace only known occupied slots deliberately, not unidentified fingerprints.

### Reset fingerprint mappings

**Reset all fingerprint mappings** requires typing `RESET ALL FINGERPRINT MAPPINGS`. It deletes live cloud copies, disables cloud storage and peer sync, and queues fingerprint member-to-slot association removal for every currently active paired kiosk. Reader templates are retained for deliberate replacement during re-enrollment. Roster, attendance, kiosk pairing and other authentication mappings are unchanged.

Review each kiosk's **Fingerprint reset status**. An offline kiosk can continue using its old local associations until it reconnects and completes the durable reset. Pending kiosks cannot share fingerprints; a completed acknowledgement confirms mapping removal, not sensor erasure. A previous pairing is no longer authorized. Do not treat a queued reset as immediate removal from every device or from historical infrastructure backups.

The roster table keeps names and emails together, with member IDs in a separate column. **Edit** shows the attendance-required date without adding it to the directory table.

The **Browser simulator** is available to Administrators. Normal reads follow physical-kiosk check-in, duplicate-scan and check-out rules. It uses browser-selected simulated reads and does not count as physical kiosk activity. Do not use simulator results as evidence that a reader, network, or physical kiosk update succeeded.

## Settings tasks

- **Organization** controls name, subtitle, logo, colors, and appearance.
- **Configuration** controls attendance timing, the reporting baseline, and meeting-weight categories.
- **Access** controls authenticated Administrator and Operator accounts.
- **Integrations** controls optional Google, Resend, and Discord connections.
- **Data** downloads or restores category-specific backups and performs typed-confirmation deletion.
- **Guided Setup** reopens the shared setup checklist without deleting data.
- **Updates** compares releases and provides the backup-first web update flow.

Every user can turn on **Debug mode** in the Settings navigation bar. Debug mode reveals diagnostic history such as member label history, current-label attendance history, and recent roster imports for that user only. On a page with a registered walkthrough, it also shows a floating **Reset page walkthrough** button. Resetting clears that account's progress for the current page and immediately opens its first-visit invitation. It does not change organization data or another user's view.

## Update safely

Web and physical-kiosk updates are separate. For a web update, open **Settings → Updates**, review the release notes, select **Back up and begin update**, download the entire-installation backup, check the saved-backup confirmation, and select **Start update** once. Refreshing only restores progress; it does not start another update. Select **Reload updated dashboard** only after the page reports verified completion.

The selected device on **Kiosks** may offer **Update kiosk** when the kiosk is online and a fresh compatible release check succeeds. The completed 1.0.2 migration used the terminal updater through Raspberry Pi Connect remote shell. Dashboard-driven kiosk release lookup acceptance remains unproven, so follow [kiosk operations](KIOSK.md) for the physical-kiosk path.

## If something fails

- A **Page unavailable** message means the route does not exist or the current role cannot open it. Return to **Dashboard** and sign in with the correct account if needed.
- A roster import error identifies the row or column to correct. Fix the CSV and preview it again.
- An integration failure does not undo a saved meeting or attendance change. Review the provider's card and retry only after correcting the stated setup issue.
- For backup, restore, and update recovery, use [data backup and restore](BACKUP-RESTORE.md) and [web updates](WEB-UPDATES.md). Do not restore an old kiosk queue automatically.
