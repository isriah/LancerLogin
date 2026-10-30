# Carpool module

Carpool is an optional staff workspace for planning rides to and from an event. Enable it in Settings, complete its one-step setup by creating a plan, and grant `Manage Carpool` to Operators who should use it. Carpool works when Attendance and Outreach are disabled.

Carpool is a separately selected plugin, maintained outside LancerLogin itself. An installation includes it by listing the Carpool plugin in its `lancerlogin.modules.json`. An installation that already uses Carpool adds that entry before, or with, the update that removes Carpool from Core; its data, settings and permissions carry over unchanged. On v2.0.0-beta.11 or earlier, which cannot add modules from Settings, add the entry to `lancerlogin.modules.json` in the private deployment repository before updating. An update that would drop Carpool while it is in use is refused before it changes anything, and **Settings > Updates** offers **Keep Carpool (add module)**, which adds the released Carpool module through **Settings > Modules**, or **Remove Carpool**. See [module plugins](MODULE-PLUGINS.md#updating-an-installation-that-uses-a-module-that-moved-into-a-plugin) and, for what happens without the plugin, [Carpool is a plugin](MODULE-PLUGINS.md#carpool-is-a-plugin).

## Plans and participants

The workspace has three areas: **People**, **Groups**, and **Share**. Event selection, settings, trip direction, saved-state feedback, and readiness stay available throughout. Bookmarked links retain the area and direction. Choose both directions or a one-way plan in event settings. The other direction remains unplanned, and a missing response is never treated as an arranged ride.

A plan can stand alone. With access to both Attendance and Carpool, staff can optionally choose an **Associated meeting** when creating a plan or editing **Event settings**. This adds navigation only. It does not change attendance, meeting times, participants, ride assignments, or provider messages. Several Carpool plans can refer to the same meeting.

Linked meetings show a car icon in the meeting calendar and table, and their detail view provides links to the associated Carpool plans. A plan's **Open meeting** link appears throughout its workflow. Plan links use a stable URL and can be bookmarked.

Disabling Attendance hides its meeting names and quicklinks without deleting the saved association. The plan remains usable, and **None - standalone Carpool** removes the association even while Attendance is disabled. Deleting a meeting never deletes the Carpool plan. A missing meeting is shown as unavailable until staff remove or replace the link. Portable single-plan exports remove this installation-specific association; entire-installation backups retain it.

Staff may also save an opaque external event reference, title, and start-time snapshot. Carpool uses narrow authorized meeting-reference projections, not another module's private tables. Participants may be linked to an active Core roster identity or kept as ad hoc people. A roster link is helpful for consistent identity, but it is not required.

For each participant, record outbound and return details independently:

- whether the person can drive, needs a ride, already arranged a ride, uses other transit, or needs review;
- the address and coordinates for that direction;
- available passenger seats when the person can drive.

People shows both trip summaries in one searchable list. Filter drivers, ride requests, unassigned riders, or people needing attention, and open **Edit** to review identity, contact, notes, and both trips. Address and seat fields appear when relevant.

Return travel can reuse the outbound location. Saved addresses are located automatically in small batches when lookup is configured. Pending lookups appear separately from people needing manual review. Unmatched addresses, missing addresses, and incomplete transportation responses remain visible for staff review. A provider failure pauses automatic lookup until **Retry location lookup** or an address change; refreshing the page does not repeatedly call the provider. Manual pins and valid saved matches are retained.

Use **Locate address** to preview an automatically matched address, or place a manual pin using the map or advanced coordinates. Lookup and pin changes in the editor remain drafts until **Save participant**. Changing an address clears the old pin. Closing the editor keeps unsaved changes while the plan is open; **Cancel changes** discards them. Failed saves preserve edits, and conflicts expose the newer saved values for review before retrying. Automatic saved-address lookup retains these local drafts as well.

## Build and review groups

In Groups, review **Needs attention** first. A single board shows drivers, assigned riders, locks, and one compact open-seat target per car. Search drivers, contacts, labels, riders, or addresses, and filter cars with space, full cars, or the selected car. Staff can save a group label and color independently for each direction. Color always appears with a text label.

Choose **Preview groups** for the current direction or both planned directions. The review shows new, moved, removed, and unchanged assignments, locked assignments preserved, proposed exceptions, and the exact grouping distances. **Apply proposed groups** checks the reviewed plan revision and proposal again. Suggestions maximize rider coverage before minimizing straight-line geographic distance. They do not calculate road routes, order stops, or invent meeting points.

**Show map** adds geographic review beside the board on desktop and below it on mobile. Drivers and riders are visible by default. The selected car stays distinct, and the map can show only its group or include independent travelers.

Assign, move, swap, lock, and unassign riders through keyboard-accessible controls. Dragging an unlocked rider between cars remains available; dropping on a passenger swaps when the destination is full. A ready unassigned rider can also be dropped into an open car. Lock car applies to all current assignments in that car, and each rider can be unlocked separately. Conflicting locked assignments stop a rebuild before either direction changes.

**Undo rebuild** restores the previous assignments, exceptions, locks, manual flags, and grouping distances together. It remains available until another change is saved. Undo for the most recent individual assignment action is also revision checked. Failed previews and saves preserve editable values and offer refreshed saved data for review.

## CSV import and export

In People, choose **Import CSV** or download the header-only template. Review suggested column matches, with optional mappings under a disclosure. Select both directions or a one-way import explicitly. Correct highlighted invalid values, then use the row filter to revisit corrected or ready rows. Original values stay visible beside corrections, and **Download corrected CSV** saves a working copy without changing the selected file.

**Preview import changes** shows normalized values, the numbers of new, updated and unchanged participants, staff edits retained, unmatched roster IDs, and assignments that will need review. **Apply import** checks the reviewed plan and import preview again. Reimport matches stable source identities and merges source values while preserving manual staff edits. A one-way reimport preserves independent details for the other trip. Omitted participants remain saved; changed travel details clear affected assignments for review.

Duplicate identities, stale mappings, oversized fields, and malformed CSV are rejected before writes. In Share, download a formula-safe CSV matching the selected saved preview.

## Sharing and trip times

Set **Trip time zone**, **To-event departure**, and **From-event departure** in Event settings. These optional Carpool times do not change an associated Attendance meeting. All times use the selected zone; changing the zone keeps existing times at the same instant. A time skipped when the clock moves forward is rejected. For a repeated time when the clock moves back, choose the earlier or later occurrence explicitly. Shared previews show the UTC offset for a repeated time, and CSV includes the exact UTC departure instant.

In **Share**, choose a coordinator preview with all cars and current exceptions, or one driver's preview with only that car and its assigned riders. Review pickup and drop-off addresses, contacts, notes, passenger capacity, and departure time. Empty cars remain visible. This is a practical roster; it does not calculate a driving route or stop order.

**Download saved CSV** and **Print saved preview** use the selected preview, including its saved version, generated time, time zone, and incomplete-plan warnings. Unsaved edits are excluded and called out. A stale saved version is rejected; **Refresh preview** reloads saved data while retaining local drafts for review. Give drivers only their individual views and protect files containing addresses and contacts.

## Location lookup

Administrators configure the Geoapify API key in **Settings > Modules > Carpool**. The key is stored encrypted and is excluded from portable backups. The Carpool plugin does not read the former `CARPOOL_GEOAPIFY_KEY` Worker variable, because plugins never receive the Worker environment; save the key in settings, then remove the variable. This page also sets the default preferred radius (4 miles) and maximum radius (12 miles) for new plans; staff can change both within each plan. The address needed for a lookup is sent to Geoapify. For a street-only address, the request also includes an event-level median proximity point derived from complete addresses in the same plan. This reduces distant matches without excluding legitimate outliers. Staff can explicitly re-resolve short addresses after enabling a provider or reviewing questionable pins. Successful and no-match results are cached to avoid repeated requests. Manual coordinates are the complete fallback and do not require a provider. The map uses OpenStreetMap tiles with provider attribution and does not calculate driving routes.

## Backup and removal

An entire-installation backup includes Carpool plans, participants, assignments, settings, and the location cache in the Carpool plugin's section and is the primary disaster-recovery artifact. Backups made while Carpool was part of Core restore through the plugin; see [backup and restore](BACKUP-RESTORE.md#carpool-moved-into-a-plugin). Under **Share > Advanced: portable event backup**, staff can download a portable plan backup containing assignments, group labels and colors, unresolved reasons, locks, trip times and time zone, and validated import metadata. The Carpool workspace does not offer event-backup restore. Provider credentials and temporary lookup execution state are excluded from backups.

In Event settings, **Archive event** removes a saved plan from the active list without deleting it. Choose **Archived events** or **All events** in **Show events**, select the plan, and use **Restore event** to return it to the active list. Event settings also lets staff delete one reviewed plan and its people and assignments while retaining the installation-wide location cache. Disabling Carpool follows the normal delayed module-cleanup lifecycle. Its owned plans, people, assignments, import profiles, and location cache are removed only when the reviewed cleanup runs. Core roster members and other modules are never changed.

## Privacy

Addresses, coordinates, contact details, and ride assignments are sensitive operational data. Grant Carpool access only to staff who need it, avoid putting this data in logs or screenshots, protect exported files, and delete copies when they are no longer needed. See [Privacy](PRIVACY.md), [Security](SECURITY.md), and [Data backup and restore](BACKUP-RESTORE.md).
