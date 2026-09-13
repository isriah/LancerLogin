# Proposed production migration and cutover

This is an operational proposal, not authorization to access or change production. Dependencies: completion of plan.md P1–P6, integrated development acceptance, a reviewed release, and the owner's explicit production destinations and cutover approval. Do not execute this procedure while those gates remain open. Exact production commands and release identifiers must be added to the final reviewed change record after the updater exists and is tested.

September 11 revised initial-release scope: the owner defers the entire Activity Documentation module (P4/P5 features), retaining attendance, optional Hour Tracking and shared infrastructure. Documentation-only file/PDF/compute/publication acceptance is excluded from this release. Preserve its existing schema/data in migrations and backups, and verify that the release profile cannot enable or execute excluded features. P6 and retained P7 release gates still apply. This supersedes the earlier P5-only deferral.

## Acceptance required before scheduling

- Prove core-only and core-plus-Hours operation. Reject excluded Documentation, including stale enablement, while preserving module records and grants. Verify Hours disable/re-enable retention and no unexpected publication backfill.
- Complete Hour Tracking member-form and Discord equivalence in the isolated development installation. Documentation file/packet feature acceptance is deferred; shared final-schema/data recovery remains required.
- Demonstrate the independent updater upgrading between two signed development releases, with bad-signature, interrupted-job, failed-migration and restore drills. Local signature verification alone is insufficient.
- Exercise the Google transition with incremental and declined consent, refresh-token retention/replacement, revocation and local Admin recovery. Existing successful sign-in does not prove these cases.
- Restore the final schema into disposable recovery resources and verify application behavior, record/history preservation and provider-side reconciliation. A successful SQL import or an older-schema drill alone is insufficient.
- Record the exact release digest, verification results, measured file/job limits, known limitations and kiosk compatibility. Distinguish software simulator checks from physical device acceptance.

## Prepare a concrete production change record

Read the then-current production version and approved resource inventory without copying real records into development fixtures. Resolve the repository, Cloudflare account, API, Pages, D1, updater/state/backup resources, domains and provider destinations with the owner. Compare production schema and configuration with the actual supported migration path; do not assume the development baseline still matches.

Account for members and their identifiers, attendance and corrections, staff identities and grants, password and kiosk credential hashes, encrypted providers, organization settings, audit history and every new module table. Preserve leading-zero identifiers and existing record identities. New modules default disabled for an existing installation.

Plan secure handling of installation encryption secrets separately from data exports. Encrypted provider values cannot be assumed usable with different secrets. Never copy development accounts, synthetic data, test provider destinations, proof authority or bootstrap credentials into production. Establish local Admin recovery before changing Google sign-in.

Review the independent updater's exact installation/source/resource/trust binding and token permissions. Account-wide provider permissions do not imply permission for the updater to mutate arbitrary resources. Define ownership and recovery access for its state and backup resources. Retire the old workflow handoff only after the new path has passed its required development drills and the production operator has approved the transition.

## Proposed maintenance sequence

1. Agree on a maintenance window and stopping conditions. Identify every writer: dashboard, public form, Discord, scheduler, publication/file jobs and kiosk traffic. Define how each is paused or rejected and how uncertain provider operations are reconciled. Do not rely on hiding a button to stop writes.
2. Record existing deployment versions, schema, provider ownership and pending operations. Take protected logical and raw backups with timestamps and integrity digests. Keep secrets outside logs. Verify a recoverable copy and the tested restore path before mutation.
3. Under separately approved Pi access, record kiosk version and queued work without discarding it. Select the proven compatible sequence for API and kiosk changes. Do not update a live Pi merely because a software simulator passed.
4. Apply the reviewed signed release through the completed in-app updater and its migration lock. Preserve the old deployment identifiers and backup. Check durable status after any uncertain response; never start a second migration because a browser timed out.
5. Verify local Admin recovery, production record counts and invariants, attendance behavior, staff access and provider configuration. Keep the new modules disabled until core behavior is accepted. Reconcile external operations before resuming dispatch; a database restore does not undo Calendar, Discord or Drive writes.
6. Resume authorized writers in a controlled order. Reconcile kiosk offline queues and verify idempotent ingestion using the tested compatibility path. Enable new modules and configure provider capabilities only when the owner selects them; retain existing attendance operation.
7. Monitor the agreed acceptance interval, record the deployed release and results, and retain recovery material under the installation's retention policy. Remove obsolete workflow authority only through the approved transition procedure.

## Stop and recover

Stop on signature/resource mismatch, incomplete backup, unexpected schema or data loss, unreconciled external writes, migration failure, lost Admin recovery or incompatible kiosk behavior. Keep writers paused while determining authoritative job and provider state.

Application rollback and database rollback are separate decisions. Do not put an older application over a newer incompatible schema. Use the release's proven recovery procedure: restore the approved backup when required, deploy a compatible application, verify its records and secrets, reconcile external ownership and only then resume writers. Preserve the failed job's evidence without recording credentials or personal payloads. Do not automatically repeat uncertain provider operations.

## Current evidence boundary

This proposal remains pending retained-scope P7 acceptance. Development has local and selected hosted evidence, while final retained-provider and hosted updater acceptance remain open. Activity Documentation feature acceptance is deferred; its preserved data remains part of schema/recovery checks. The durable [development progress record](PLANS/modular-development-progress.md) identifies exact commits and completed checks. Its local schema/recovery checks must not be represented as final-schema hosted recovery or production cutover evidence.
