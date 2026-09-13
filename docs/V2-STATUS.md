# V2 preservation status

This is an unfinished, sanitized snapshot of canonical Modular source (private source commit `9a781c2adaa6d844b6f7e5effb4895e00acc465b`), imported onto public Community commit `96d75d34119be3a11cd4099f1d04915b35785416`. Private Git ancestry and operational configuration were not imported. Community V1 remains on `main`. V2 is not ready for production.

## Scope and unfinished work

The initial V2 profile provides Attendance and optional Hours. Activity Documentation is unavailable to enable; its unfinished source, tests and historical records are preserved for later work. Document-compute feasibility exceeded the reviewed Free-plan CPU budget. Documentation and packet work remain deferred; consolidation does not authorize billing changes.

Independent updater, recovery and release-trust prototypes remain unfinished. Hosted adoption, supervisor isolation, signing-key custody, validated database targeting, real provider recovery, signed self-update and hardware acceptance still need architecture and security review. Local prototypes do not prove hosted recovery.

## Verification baseline

Node 24.10 or later is required for SQLite authorizer validation. Fresh verification of the unchanged private Windows checkout passed all 49 migrations and type checks, then failed its JavaScript gate: six local Miniflare tests encountered fetch failures or port collisions. The separate TypeScript baseline passed. Historical Hours publication scheduler failures also remain unresolved; absence in this run does not establish their repair.

The first sanitized LF snapshot passed migrations and type checks, then reported 472 JavaScript tests: 443 passed, 26 failed and 3 skipped. Two documentation assertions described retired telemetry or a different documentation-site version and have been updated to the retained documentation. Most updater failures reject migration artifacts: the signed fixture catalog hashes match the private Windows checkout's CRLF files, while all 49 tracked migration blobs use LF. The import preserves those tracked blobs. Intermediate snapshot tests also failed to observe pending state. Preserve these fail-closed checks; do not re-sign fixtures, rewrite applied migrations or disable validation to claim readiness. Baseline logs and hash evidence are protected privately. The snapshot build, 41 focused documentation/scheduler/isolation checks and 140 TypeScript checks passed after retirement corrections. Browser baselines each passed 441 of 451 tests, with ten failures in different cases on canonical and imported source, including local address-in-use and missing initial page state. These inconsistent failures remain unresolved; targeted comparisons are required before claiming a consolidation regression or repair. A serial focused setup/settings/updater browser run passed all 43 checks. Exact public Verify run 34740851718 on snapshot 8273be294deba9582abde8583f9c6e73ffb11451 passed its audit and actionlint jobs; its verification job failed with 472 JavaScript tests: 445 passed, 26 failed, 1 skipped. Migration-artifact rejections reproduced the documented LF catalog mismatch. Ordinary CI remains enabled; these failures are not a release gate bypass. Browser CI completion is recorded in protected progress evidence.

## Community compatibility gaps

The migration chains diverge. Community has `0029_web_updates.sql`; Modular instead has `0029_platform_modules.sql` and continues through 49 migrations. Community's supported web-update implementation is absent from this snapshot. The V2 API and installed kiosk release selectors still accept only `v0.n.n`, and the privileged shell helper rejects `1.x` versions. Community's V1 kiosk release selection and installer compatibility fixes therefore have not survived the snapshot and require explicit later reconciliation. No V1-to-V2 upgrade, migration reconciliation or Community installer release is supported.

Importing a snapshot atop Community does not prove Community fixes survived. Canonical files replace Community files, and later merges will not automatically recover overwritten changes. Telemetry retirement and legacy disabled privacy compatibility were reapplied explicitly. Review all other Community fixes, including updater, release, security and dashboard changes, before any V2 release; their survival is unverified.

## Isolation and privacy

Only ordinary CI is active. Release, production deployment and production documentation publishing are disabled. Checked-in deployment defaults contain no real account or database bindings. The existing private hosted V2 testing environment is retained independently; this snapshot has not been deployed to it. Use synthetic data. Community telemetry is retired; historical telemetry fields remain inert. General attendance, biometric sensor, backup and security boundaries still apply.
