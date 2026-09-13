# Hours catalog workspace (WU-100)

The `/hours` workspace manages categories, supported teams and dated activities. Navigation consumes the platform module descriptor and current `hours.manage` capability. Enabled Admins, granted Operators and granted Staff use the same workspace. Staff retain their separate shell and cannot reach core attendance or access administration through this navigation. Activity Documentation is not presented as a functional workspace by this unit.

## Editing and recovery

Lists and selectors use bounded pages with explicit next-page controls. Catalog filters include archive status; activities also support service-date range, mode, category and supported team. Service dates are inclusive calendar dates. Attendance-source date filters instead resolve organization-local midnight to inclusive/exclusive UTC bounds through the shared civil-time helper. Applied filters are snapshotted: editing filter fields does not change paging or mutation refreshes until Apply filters succeeds. Stable identifier pagination is not chronological ordering.

Create and edit forms use named category, team, responsible-staff and attendance-source selectors. Team numbers remain text. Categories show the mode/impact-default distinction; changing a default does not rewrite existing records. Archive and reopen retain history. Supported-team and task/service grouping identities remain immutable after creation. No hard deletion is offered.

Each update sends its loaded revision. A successful write must be followed by a valid detail read with the expected revision and an updated list read before the workspace confirms it. Failure, conflict, malformed status or uncertain read-back locks further mutations until explicit reload. Reload never retries a write, and a new draft is replaced with a fresh draft using the current organization zone. New drafts send `expectedTimeZone`; the API rejects stale organization zones and atomically fences configuration changes during creation. Saved activities retain their own planning zone. No form draft, identifier cache or credential is persisted to browser storage by these components.

Responsible-staff choices use roster names or local usernames, never emails. An active account lacking either identity is shown as unavailable for new selection; an Admin must add a roster link or local username in Access settings. Existing inactive or unnamed references remain retainable. A saved staff reference beyond the current page uses a generic retained-selection label until its page is loaded. Categories and teams resolve retained names through bounded detail reads. No opaque identifier is a normal input field.

## Planning dates and attendance references

Planning uses local date/time controls and an explicit saved organization zone, with shared `resolveCivilTime`, `selectCivilTime`, `instantToCivil` and `addCalendarDays` functions. Repeated clocks require an explicit first/second occurrence; gaps cannot be submitted. The next-local-midnight option preserves 23/25-hour day boundaries. Planning precision is retained; these values are not recorded volunteer duration.

Attendance reuse copies only planning title/date/times and retains the source snapshot. Changed or unavailable sources are shown without rewriting the saved copy. A multi-day source requires explicit per-day times or explicit removal of planning times. Explicit `startsAt:null` and `endsAt:null` override source defaults; omitted values still copy them. Clearing a source or changing category removes source-specific validation while preserving the copied editable fields. Attendance data is never changed by this flow.

## UI review and candidate evidence

The touched workspace uses the existing card, spacing, typography, semantic color, focus, native-select arrow and control-size tokens. Forms are inline with one page heading and an editor heading; opening an editor and successful read-back focus that heading. Closing returns focus to the opener; failures focus the recovery notice. Desktop actions use their label width and mobile forms stack. There are no UI-STANDARDS exceptions.

Local verification:

- `npm run verify:dashboard`: 34 JavaScript and 7 TypeScript tests plus dashboard typecheck passed.
- `npm run test:browser -- hours-catalogs.spec.ts --workers=4`: 15 real Chromium tests with mocked API responses passed, covering catalog operations, source copy/detach, DST gap/fold, explicit untimed choice, paging, malformed/conflicting/uncertain results, zone reload, role capability revocation and keyboard focus.
- Companion `staff-identity.spec.ts` and `module-controls.spec.ts`: 21 tests passed in the affected browser run.
- Four synthetic screenshots were inspected at 1280×900 and 390×844 in light and dark modes with custom reference branding. Navigation, native controls, focus outlines and 44px targets remain contained without horizontal overflow. Screenshots remain ignored test artifacts.
- The separate API prerequisite ran actual local D1 catalog/selector privacy and bounds checks. The explicit-null follow-up passed both local D1 suites and API typecheck, including a multi-day source with null planning fields and intact source snapshot.

These are local/mock candidate checks, not successful development-deployment acceptance or live provider tests. Public submissions, volunteer entries, provider publishing and Activity Documentation are outside this unit. Combined integration checks and isolated deployment acceptance belong to the maintainer.
