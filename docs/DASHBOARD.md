# Dashboard guide

This guide is for Administrators and Operators. An Administrator configures the installation and manages access. An Operator manages permitted attendance work but cannot open administrative settings.

## Navigation and access

After sign-in, the primary navigation contains **Dashboard**, **Roster**, **Reports**, and **Kiosks**. **Settings** gives both roles theme and sign-out controls. Administrators have separate **Organization**, **Configuration**, **Access**, **Integrations**, **Data**, **Guided Setup**, and **Updates** pages.

An unfinished installation opens Guided Setup instead of the normal dashboard for Administrators. Any Administrator can resume its shared progress. Operators do not complete or reset Guided Setup.

| Area | Administrator | Operator |
| --- | --- | --- |
| Dashboard and meeting details | Create, edit, duplicate, and delete meetings; manage attendance | Create, edit, duplicate, and delete meetings; manage attendance |
| Reports and roster | Manage roster; create personal or shared reports; export reports | View roster; create personal or shared reports; export reports |
| Kiosks | Pair, replace, name, retire, and manage maintenance actions | View status and use permitted attendance operations |
| Settings | Full access | Theme and sign-out only |

Roster membership does not grant dashboard access. An Administrator creates, links, deactivates, or changes dashboard roles in **Settings → Access**.

## Run attendance

1. Open **Dashboard**. Choose the Calendar or Table view, then select a meeting to open its detail page.
2. Use **Add meeting** to create a one-time or recurring meeting. Every meeting needs an end time. Attendance windows cannot overlap.
3. During an eligible meeting, the kiosk resolves the meeting from the scan time. A single arrival is **Active · not checked out**. A completed arrival and departure is **Present**. After the meeting end plus the organization-wide late scan allowance, an incomplete pair is **Absent** unless a correction or excuse overrides it.
4. In the meeting workspace, choose **Present**, **Excuse**, or **Absent** when a correction is needed. **Excuse** and **Absent** require a reason; **Present** accepts an optional note. An Administrator can also choose **Clear** to remove recorded attendance for one attendee and meeting. Source scans and correction history remain available for auditability.

Use **Configuration** to set the organization-wide late scan allowance, late-arrival and early-departure limits, optional reporting baseline, and reusable meeting-weight categories. Those limits do not change a recorded attendance outcome.

## Roster and reports

In **Roster**, an Administrator can select **Add member** or import a CSV. The importer previews changes before writing. Required columns are `memberId`, `firstName`, and `lastName`; `email`, `discordUserId`, and `attendanceRequiredFrom` are optional. Replacing the active roster makes omitted people inactive and preserves their attendance history and dashboard accounts.

**Reports** opens a routed tab workspace. **Leaderboard** is always first and keeps its own period, meeting, roster, label, membership, sorting, and pagination controls. It also contains policy alerts, the team regular-attendance trend, and any attendance contests awaiting review. Choose 25, 50, 100, or all matching members per page.

Saved reports appear as account-synced tabs. **Browse reports** finds accessible personal and shared reports, and **+** opens one unsaved draft. Closing a tab unpins it without deleting the report. A direct report link pins that report for the signed-in account. Administrators and Operators can create, edit, or delete shared reports. A personal report is visible only to its owner. Saved reports open in a read-only view that shows their current settings; select **Edit** before changing filters, sorting, or columns.

The report builder supports fixed and rolling periods, active or complete roster history, required/optional/all meetings, Any or All matching across multiple labels, and current or historical label membership. **Member** is the first required column. While editing, use **Add column** at the right edge of the results table to choose curated roster, regular-attendance, policy, count, and date-list columns. Label-specific policy choices are grouped by result type, followed by a searchable label selection. Open a column heading to sort, move, or remove it, or drag movable headings left and right. Text columns can also be filtered from the heading menu. Results refresh after a short delay and paginate without saving the current page in the report definition. Official policy columns keep their configured windows. Report-period policy columns recalculate inside the report dates while preserving dated rule periods.

**Download report CSV** exports every matching member using the selected columns and order. **Download detailed attendance CSV** exports the filtered meeting-level records with the existing explicit `regular*` and `policy*` fields. Both exports escape CSV values and neutralize spreadsheet formulas. A browser-local report view from an older release appears in **Browse reports** as an unsaved imported draft and is removed only after saving or dismissal.

## Kiosks and simulator

Open **Kiosks** to review the physical kiosk's pairing, reader, network, pending scans, last successful sync, installed release, and heartbeat. Administrators can choose **Add kiosk** or **Replace kiosk**, download the guided Pi installer, and create a time-limited pairing key. Paste that key into the Pi's local pairing page.

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

Every user can turn on **Debug mode** in the Settings navigation bar. Debug mode reveals diagnostic history such as member label history, current-label attendance history, and recent roster imports for that user only. It does not change organization data or another user's view.

## Update safely

Web and physical-kiosk updates are separate. For a web update, open **Settings → Updates**, review the release notes, select **Back up and begin update**, download the entire-installation backup, check the saved-backup confirmation, and select **Start update** once. Refreshing only restores progress; it does not start another update. Select **Reload updated dashboard** only after the page reports verified completion.

The kiosk card may offer **Update to latest stable** when the kiosk is online and a fresh compatible release check succeeds. The completed 1.0.2 migration used the terminal updater through Raspberry Pi Connect remote shell. Dashboard-driven kiosk release lookup acceptance remains unproven, so follow [kiosk operations](KIOSK.md) for the physical-kiosk path.

## If something fails

- A **Page unavailable** message means the route does not exist or the current role cannot open it. Return to **Dashboard** and sign in with the correct account if needed.
- A roster import error identifies the row or column to correct. Fix the CSV and preview it again.
- An integration failure does not undo a saved meeting or attendance change. Review the provider's card and retry only after correcting the stated setup issue.
- For backup, restore, and update recovery, use [data backup and restore](BACKUP-RESTORE.md) and [web updates](WEB-UPDATES.md). Do not restore an old kiosk queue automatically.
