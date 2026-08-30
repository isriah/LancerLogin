# Data workflows

Admins add and manage roster members. Operators and Admins create meetings, record attendance, apply reasoned corrections or excuses, and export reports as CSV. Every write and export produces an audit record. Kiosk-originated attendance is idempotent by a locally generated kiosk event ID, so an offline queue can safely retry.

Roster CSV imports require `memberId`, `firstName`, and `lastName`; `email` and `discordUserId` are optional. The importer validates required columns, duplicate IDs, and email format before applying any rows, returning a row-numbered error list for correction.

The visible attendance disposition is a correction/excuse when one exists; otherwise it is derived from an attendance event. Source events remain retained for auditability. This service layer is backed by D1 in a later binding unit; current tests run against an intentionally isolated in-memory adapter.
