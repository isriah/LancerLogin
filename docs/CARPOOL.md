# Carpool module

Carpool is an optional staff workspace for planning rides to and from an event. Enable it in Settings, complete its one-step setup by creating a plan, and grant `Manage Carpool` to Operators who should use it. Carpool works when Attendance and Outreach are disabled.

## Plans and participants

A plan can stand alone. With access to both Attendance and Carpool, staff can optionally choose an **Associated meeting** when creating a plan or editing **Event settings**. This adds navigation only. It does not change attendance, meeting times, participants, ride assignments, or provider messages. Several Carpool plans can refer to the same meeting.

Linked meetings show a car icon in the meeting calendar and table, and their detail view provides links to the associated Carpool plans. A plan's **Open meeting** link appears throughout its workflow. Plan links use a stable URL and can be bookmarked.

Disabling Attendance hides its meeting names and quicklinks without deleting the saved association. The plan remains usable, and **None - standalone Carpool** removes the association even while Attendance is disabled. Deleting a meeting never deletes the Carpool plan. A missing meeting is shown as unavailable until staff remove or replace the link. Portable single-plan exports remove this installation-specific association; entire-installation backups retain it.

Staff may also save an opaque external event reference, title, and start-time snapshot. Carpool uses narrow authorized meeting-reference projections, not another module's private tables. Participants may be linked to an active Core roster identity or kept as ad hoc people. A roster link is helpful for consistent identity, but it is not required.

For each participant, record outbound and return details independently:

- whether the person can drive, needs a ride, already arranged a ride, uses other transit, or needs review;
- the address and coordinates for that direction;
- available passenger seats when the person can drive.

Return travel can reuse the outbound location. Staff can edit any participant, including manually entering latitude and longitude when an address cannot be resolved.

## Build and review groups

Generate both trip directions together. Suggestions maximize the number of riders placed before minimizing straight-line geographic distance. They do not calculate road routes, order stops, or invent meeting points.

Review every result before sharing it. The workspace shows an interactive OpenStreetMap view, each vehicle's capacity, and explicit reasons for unassigned riders. Staff can drag an unlocked rider card to another car, drop it on a rider to swap places when the destination is full, lock reviewed assignments, and undo the most recent assignment action. Locked assignments are preserved during regeneration unless they conflict with capacity or eligibility, in which case neither direction changes and regeneration stops for review.

## CSV import and export

The workspace combines import and response review into one first stage, followed by Resolve locations, Generate groups, Map and edit, and Save and export. Select a CSV, review the automatically suggested column associations, then correct only highlighted invalid values. Unmapped columns and fully acceptable rows stay out of the correction view. A changed field keeps its original imported value visible for reference, and staff can download the corrected working CSV before import. A reviewed mapping is remembered when the same header set returns. Import up to 500 participants at a time. Re-import matches a roster member ID when present, otherwise normalized name and contact. It uses a three-way merge:

- source values refresh fields that still match the previous import;
- staff edits, including a changed roster link, remain unchanged;
- only assignments for a direction whose source travel details changed are cleared for review.

Duplicate identities, stale mappings, oversized fields, and malformed CSV are rejected before writes. Export outbound groups, return groups, and unresolved rides as formula-safe CSV files.

## Location lookup

Automatic geocoding is available when the Worker has a `CARPOOL_GEOAPIFY_KEY` secret. The address needed for a lookup is sent to Geoapify. For a street-only address, the request also includes an event-level median proximity point derived from complete addresses in the same plan. This reduces distant matches without excluding legitimate outliers. Staff can explicitly re-resolve short addresses after enabling a provider or reviewing questionable pins. Successful and no-match results are cached to avoid repeated requests. Manual coordinates are the complete fallback and do not require a provider. The map uses OpenStreetMap tiles with provider attribution and does not calculate driving routes.

## Backup and removal

An entire-installation backup includes every Carpool-owned table and is the primary disaster-recovery artifact. Staff can also download a portable plan backup containing assignments, unresolved reasons, locks, and validated import metadata. The Carpool workspace does not offer event-backup restore. Provider credentials are never included.

Archiving removes a plan from the active picker without deleting it. Staff may also delete one reviewed plan and its people and assignments while retaining the installation-wide location cache. Disabling Carpool follows the normal delayed module-cleanup lifecycle. Its owned plans, people, assignments, import profiles, and location cache are removed only when the reviewed cleanup runs. Core roster members and other modules are never changed.

## Privacy

Addresses, coordinates, contact details, and ride assignments are sensitive operational data. Grant Carpool access only to staff who need it, avoid putting this data in logs or screenshots, protect exported files, and delete copies when they are no longer needed. See [Privacy](PRIVACY.md), [Security](SECURITY.md), and [Data backup and restore](BACKUP-RESTORE.md).
