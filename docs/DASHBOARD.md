# Dashboard reference

This page describes dashboard behavior in detail. Task instructions are on the documentation site: [Operate LancerLogin](https://isriah.github.io/LancerLogin/operations.html).

## Navigation and access

After Attendance setup is complete, the primary navigation shows **Meetings**, a page for each enabled module that adds one, **Roster**, **Reports**, **Kiosks**, and **Settings**. Before Attendance is ready, the first item reads **Dashboard** and **Kiosks** is hidden.

Admins see these settings pages:

| Page | Contents |
| --- | --- |
| Organization | Name, subtitle, logo and colors. |
| Modules | **Manage modules** (turn modules on or off, **Add module**, update or remove modules, **Apply changes**, module access), **Attendance**, and one page per module that has settings. Attendance has the tabs Attendance rules, Labels, Meeting configuration, Fingerprint sharing, Fingerprint recovery and Attendance setup. |
| Access | Admin and Operator accounts, their roster links and the modules each Operator can use. |
| Integrations | Google sign-in, Google Calendar, Resend and Discord. |
| Data | Category backups, restores and typed-confirmation deletion. |
| Updates | Update track, dashboard updates and module deployment status. |

Operators see their own session settings and the modules they are assigned to.

| Area | Administrator | Operator assigned to Attendance |
| --- | --- | --- |
| Meetings and meeting workspaces | Create, edit, duplicate and delete meetings; manage attendance | Same |
| Roster | Manage members, labels and imports | View |
| Reports | Create personal or shared reports; export | Same |
| Kiosks | Pair, rename, retire, configure and send maintenance commands | View status and diagnostics |
| Settings | Full access | Session settings only |

Roster membership never grants dashboard access. Accounts are managed in **Settings > Access**.

## Page walkthroughs

First-visit walkthroughs introduce Meetings, Roster, member detail, Reports, the meeting workspace, Kiosks, the browser simulator and module pages that provide one. Settings pages have none. Walkthroughs use practice previews that cannot save or delete records and never send provider actions or device commands; the Kiosks tour shows a labelled example device when none is paired. **Not now** postpones the invitation and **Don't show automatically again** stops it for that page. Progress follows the signed-in account across browsers.

Every user can turn on **Debug mode** in the Settings navigation. It reveals diagnostic history such as member label history and recent roster imports, and a **Reset page walkthrough** button on pages with a walkthrough, for that user only.

## Meetings and attendance

Every meeting needs an end time, and attendance windows cannot overlap. A single arrival is **Active · not checked out**; an arrival and a departure is **Present**. After the meeting end plus the late scan allowance, an incomplete pair is **Absent** unless corrected or excused. **Excuse** and **Absent** require a reason; **Present** accepts an optional note. Admins can also **Clear** one attendee's records for one meeting. Source scans and correction history remain for audit.

**Settings > Modules > Attendance > Meeting configuration** sets the late scan allowance, the late-arrival and early-departure limits that flag unusual times, the optional reporting baseline and meeting-weight categories. These limits do not change a recorded outcome.

Attendance contest review supports individual and bulk acceptance or rejection with one shared reason. Changing the filter clears the selection, so hidden entries are never included; failures stay in the list for retry. Members may contest again after a rejection while the original notice is within its contest window, unless an Admin turns on **Block re-contests after rejection** in the Discord integration settings.

## Roster and reports

The roster importer previews every change before writing. Required columns are Member ID, First name and Last name; Email and Discord user ID are optional. **Download template** saves `roster-template.csv` with the header row and one example. Headers are matched loosely: case, spaces, underscores, hyphens and dots are ignored, and common aliases work (`id` or `Student ID` for Member ID, `First` or `Given name`, `Last`, `Surname` or `Family name`, `Email address` or `Mail`, `Discord ID` or `Discord`), so the camelCase `memberId`, `firstName`, `lastName`, `email` and `discordUserId` still work. Other columns are ignored and listed as a warning. Spreadsheet rows pasted without a header must use the template column order. **Add to or update the current roster** keeps people not in the file; **Replace the active roster** makes omitted people inactive while preserving their history and dashboard accounts. See [data workflows](DATA-WORKFLOWS.md) and [labels and attendance policies](ATTENDANCE-POLICIES.md).

**Reports** opens a routed tab workspace. **Leaderboard** is always first, with its own period, meeting, roster, label, membership, sorting and pagination controls, policy alerts, the team regular-attendance trend and contests awaiting review. Saved reports appear as account-synced tabs; **Browse reports** finds personal and shared reports and **+** opens a draft. Closing a tab unpins it without deleting the report. Admins and Operators can create, edit or delete shared reports; a personal report is visible only to its owner.

The report builder supports fixed and rolling periods, active or complete roster history, required, optional or all meetings, Any or All matching across labels, and current or historical label membership. **Member** is the first required column. Column menus sort, move, remove and filter (Contains and Equals for text; Equals, Minimum, Maximum and Between for numbers and dates; Is empty and Is not empty). Filters are saved with the report and apply to CSV exports. **Current membership** applies each member's labels today across the whole period; **Historical membership** uses the labels held on each meeting date. Both respect attendance start dates, meeting audiences, policy rule periods and excuse handling.

**Download report CSV** exports every matching member with the selected columns. **Download detailed attendance CSV** exports the filtered meeting-level records with explicit `regular*` and `policy*` fields. Both escape CSV values and neutralize spreadsheet formulas.

## Kiosks and rejected scans

**Rejected scans** on the Kiosks page lists evidence uploaded by active or retired kiosks, in **Needs review** and **Reviewed** lists. Expand a record for its IDs, reason, original scan time, cloud receipt time and clock evidence. Correct attendance in the meeting if the evidence supports it, then add a note and **Mark reviewed**; reviewing never changes attendance. **Dismiss scans** marks up to 500 filtered or selected records reviewed in one request, with a separate audit entry for each. Reviewed status synchronizes back to the originating kiosks.

Kiosk diagnostics, authentication methods and maintenance commands are described in the [kiosk reference](KIOSK.md#dashboard-management-and-recovery).

**Settings > Modules > Attendance > Fingerprint sharing** controls fingerprint cloud storage. **Fingerprint recovery** holds **Reset all fingerprint mappings**, which requires typing `RESET ALL FINGERPRINT MAPPINGS`. It deletes live cloud copies, turns cloud storage off and queues fingerprint mapping removal for every active paired kiosk. Each kiosk's **Fingerprint reset status** shows when it has acknowledged; an offline kiosk keeps its old mappings until it reconnects. Reader templates, roster, attendance, pairing and badge or QR mappings are unchanged. Re-enroll members through **Authentication maintenance** afterwards.

## Updates

Dashboard updates are made in **Settings > Updates** and kiosk updates with **Update kiosk** on the Kiosks page. See [Update LancerLogin](https://isriah.github.io/LancerLogin/updates.html) and the [web update reference](WEB-UPDATES.md).

## If something fails

- **Page unavailable** means the route does not exist or the current role cannot open it.
- A roster import error identifies the row or column to correct.
- An integration failure does not undo a saved meeting or attendance change.
- For backup, restore and update recovery, see [backup and restore](BACKUP-RESTORE.md) and [web updates](WEB-UPDATES.md#recovery). Do not restore an old kiosk queue.
