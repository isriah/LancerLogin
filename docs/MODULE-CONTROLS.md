# Admin module settings (WU-091)

Dependencies: WU-088 module registry/configuration/grant routes and WU-089 true Staff identity. This is the Admin control surface for those contracts, not completion of the Hour Tracking or Activity Documentation workspaces.

Settings → Configuration now includes a separate Modules form. It loads the server registry and revision, supports core only, hours only, or both modules, and submits the full selected list with that revision. Documentation alone disables Save and explains the dependency. Unchecking hours does not silently uncheck documentation: the Admin must explicitly choose both changes. Module changes do not call provider, deletion, or schema endpoints.

Settings → Access exposes a per-account Module access disclosure for active Staff and Operator accounts. Each management grant is independently assignable, including documentation without hours management authority. Grants remain visible and editable while their modules are disabled. The UI distinguishes saved grants from whether the corresponding module is currently enabled. Admin access is implicit and has no misleading grant editor. Inactive accounts retain historical grants, but the existing API requires an active target to read or change them; the UI explains this limitation.

Both forms retain an explicitly labeled **Last loaded** server state while editing. A successful write must also pass a fresh read before the UI reports a verified save. Any write or readback failure requires an explicit reload before another save; it never automatically reapplies a stale draft. A write may have succeeded when a later read fails, so the error asks the Admin to review current server state instead of asserting rollback or rejection. Configuration 409 handling uses the existing optimistic revision contract. Grant writes have no revision contract in this API and remain last-writer-wins across different Admin sessions; this unit does not claim concurrent grant-edit conflict detection. Disclosure, inputs, and save/reload actions are disabled during grant requests to avoid overlapping local reads.

The existing Admin route boundary controls visibility. Staff and Operators cannot open these settings or obtain an editor through direct navigation. All actual authorization still belongs to the server, which reloads active identity and permissions for each operation. No new module navigation, placeholder feature pages, provider clients, migrations, dependencies, or deployment resources are introduced.

## Visual review

The controls reuse settings panels, native fieldsets/checkboxes, primary/quiet actions, semantic status and focus treatment. Typography uses body/display roles; spacing uses `--space-*`; controls and panels use `--control-min-block-size`, `--radius-control`, `--radius-card`, and `--ui-*` colors. No design-standard exception or new semantic token is needed.

Browser checks and rendered screenshots cover 1280×900 and 390×844, light and dark themes, custom primary and secondary branding, one page h1, visible keyboard focus, Space activation, 44px checkbox labels, responsive wrapping, and no horizontal page overflow. Module/grant rows align labels with controls and each form has one primary action. Screenshots contain synthetic accounts only and remain in ignored `test-results/`. Unrelated legacy presentation (including narrow Staff role selects in existing desktop account rows and global skip-link behavior in full-page captures) was not expanded into this unit.

## Verification

- `npm run verify:dashboard`: 34 dashboard tests, 7 TypeScript behavior tests, and dashboard typecheck passed.
- `npm run test:browser -- module-controls.spec.ts --workers=1`: 16 focused browser tests passed, covering all valid configurations, invalid dependencies, 409/403/500 responses, rejected reads, successful write/failed readback, grants retained while disabled, independent documentation grants, full revocation, disclosure request serialization, unauthorized roles, and visual/keyboard checks.
- Existing `staff-identity.spec.ts` and `settings-conformance.spec.ts`: all 30 regression cases passed in the combined 45-case run. That run had one environmental `net::ERR_NO_BUFFER_SPACE` failure navigating to the local fixture before the retained-grants test reached the application. The subsequent serial 16-case focused suite passed, including that test; no assertion was weakened.

These are local browser/API-mock and typecheck results. This work unit performed no external mutation, development deployment, live provider test, or production operation. Integration and hosted development UI acceptance remain the maintainer's responsibility.
