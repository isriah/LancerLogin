# Data workflows

Admins add and manage roster members. Operators can view the roster. Admins can separately link a roster member to an Admin or Operator dashboard account, or retain non-rostered dashboard accounts. Operators and Admins create meetings, record attendance, apply reasoned corrections or excuses, and export reports as CSV. Every write and export produces an audit record. Kiosk-originated attendance is idempotent by a locally generated kiosk event ID, so an offline queue can safely retry.

Roster CSV imports require `memberId`, `firstName`, and `lastName`; `email` and `discordUserId` are optional. The importer validates required columns, duplicate IDs, and email format before applying any rows, returning a row-numbered error list for correction.

The visible attendance disposition is a correction/excuse when one exists; otherwise it is derived from an attendance event. Source events remain retained for auditability. The deployed Worker stores these records in D1; focused policy tests also use an intentionally isolated in-memory adapter.

Dashboard Data settings provide three independent data categories: Meetings and attendance, Roster, and Entire installation. Each category has a matching JSON backup, restore, and typed-confirmation delete action. A backup can restore only its matching category. Whole-installation backups include sensitive password hashes, encrypted integration ciphertext, and credential hashes, so they must be protected like administrator credentials.
