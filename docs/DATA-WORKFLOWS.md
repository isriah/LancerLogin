# Data workflows

Admins add and manage roster members. Operators can view the roster. Admins can separately link a roster member to an Admin or Operator dashboard account, or retain non-rostered dashboard accounts. Operators and Admins create meetings, record attendance, apply reasoned corrections or excuses, and export reports as CSV. Every write and export produces an audit record. Kiosk-originated attendance is idempotent by a locally generated kiosk event ID, so an offline queue can safely retry.

Roster CSV imports require `memberId`, `firstName`, and `lastName`; `email` and `discordUserId` are optional. The importer validates required columns, duplicate IDs, and email format before applying any rows, returning a row-numbered error list for correction.

Every meeting requires a scheduled end. Members scan once on arrival and once on departure. One arrival scan is active but not yet present; a completed pair is present. At the scheduled end plus the single organization-wide late-scan allowance (30 minutes by default), an incomplete pair is absent. A reasoned correction or excuse overrides the derived result without deleting the source scans. Source events remain retained for auditability.

Dashboard Data settings provide three independent data categories: Meetings and attendance, Roster, and Entire installation. Each category has a matching JSON backup, restore, and typed-confirmation delete action. A backup can restore only its matching category. Whole-installation backups include sensitive password hashes, encrypted integration ciphertext, and credential hashes, so they must be protected like administrator credentials.
