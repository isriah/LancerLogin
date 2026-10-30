# Data workflows

This guide is for Administrators and Operators. Administrators manage roster records and dashboard access. Operators can view the roster, manage permitted attendance work, and export reports.

## Roster

Administrators add one member in **Roster** with **Add member**, or many from a spreadsheet with **Import > Members from CSV**. CSV imports require Member ID, First name and Last name columns; Email and Discord user ID are optional. Header names are matched loosely (for example `First Name`, `first_name` or `firstName`), other columns are ignored with a warning, and **Download template** saves a starter `roster-template.csv`. The dashboard validates the file and shows a preview before any change is written.

Choose **Add to or update the current roster** to merge rows. Choose **Replace the active roster** only when that is intentional: omitted active members become inactive, while their attendance history and dashboard accounts remain preserved. An attendance-required date excludes earlier meetings from that person's attendance obligation and reporting denominator; it does not remove earlier scans or corrections.

Roster membership is separate from dashboard access. Use **Settings > Access** to create or link an Admin or Operator account. Deactivating a member preserves history. Meetings that start while the member is inactive do not count as absences or attendance opportunities, including after reactivation. This applies to individual and bulk status changes and CSV replacement. Each inactive period is retained in roster and installation backups. Inactive periods from before this feature was installed cannot be reconstructed; already inactive members are tracked from installation of the update. Permanent deletion is available only when no attendance history references the member.

## Meetings and attendance

Administrators and Operators create meetings and record reasoned corrections or excuses. Every meeting requires an end time, and attendance windows cannot overlap. A kiosk event has a locally generated ID, so a queued scan can retry safely after connectivity returns.

At the scheduled end plus the organization-wide late scan allowance, an incomplete arrival/departure pair becomes absent unless a correction or excuse overrides it. Source events stay in history. Administrators can clear one member's attendance events and corrections for one meeting only after entering the exact **CLEAR ATTENDANCE** confirmation.

## Reports and audit history

Open **Reports** for the fixed paginated Leaderboard or a saved report tab. Saved personal and shared reports, including the selected filters, ordered columns, and one sort, are stored in the installation. Each account has its own ordered pinned tabs. The default new report begins at the optional baseline set in **Settings > Modules > Attendance > Meeting configuration**; when no baseline exists, it uses all preserved completed history.

Use **Download report CSV** for one row per matching member and only the selected columns. Its header names and order follow the saved report, so changing the columns changes the CSV header. Use **Download detailed attendance CSV** for the filtered meeting-level data and its explicit regular and policy fields. Both exports include all filtered results rather than the visible page. LancerLogin records audit entries for saved-report writes and both exports. CSV cells that could be interpreted as spreadsheet formulas are exported as text. CSV is the supported report export format; PDF and spreadsheet exports are not included.
