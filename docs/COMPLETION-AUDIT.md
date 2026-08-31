# Community release completion audit

This audit maps every approved product decision to current authoritative evidence. “Verified locally” does not claim a real adopter deployment or physical hardware result. Those two boundaries are deliberately called out instead of being inferred from mocks.

| Requirement | Implementation evidence | Verification evidence | Result |
| --- | --- | --- | --- |
| Standalone Apache-2.0 LancerLogin repository; no legacy connection or migration | `LICENSE`, `README.md`, `docs/DECISIONS.md`; provisioning names only adopter-selected resources | sanitizer and foundation tests; clean standalone Git history | Complete |
| Clubs, classrooms, teams, and arts groups; one kiosk only | shared product contract, partial unique D1 index, explicit replacement pairing flow | policy, pairing, and dashboard tests | Complete |
| Pi 3B+/4/5, at least 1 GB, Waveshare DSI LCD (E), R503, Wi-Fi/Ethernet | guided installer and `docs/KIOSK.md` | installer dry-run tests and 800×480 browser rendering | Locally complete; physical acceptance pending |
| Fingerprint templates exclusively inside the R503 | R503 commands create/search/store in the sensor; Pi stores only slot/member mapping | packet, enrollment, mapping, sanitizer, and request-payload tests | Complete with injected serial transport; physical acceptance pending |
| Browser-led GitHub template setup and adopter-owned Cloudflare linking | guarded manual workflow, token-scoped account discovery, D1/Worker/Pages creation, same-origin proxy | resource-collision, account-neutral config, proxy, and sanitizer tests | Complete without executing a real target |
| Guided Pi installer, no clone/manual source edits, one-time pairing | release-linked installer, ten-minute hashed code, owner-only kiosk credential | installer archive/checksum and pairing tests | Complete without physical target |
| Google, local, or both authentication; modern local hashes and local recovery | first-Admin choice, salted scrypt, Google ID-token validation, interactive reset tool | runtime-security, Worker auth, recovery, lockout, and immediate session-revocation tests | Complete |
| Fixed Admin and Operator roles | route-level role checks with current D1 role revalidation | policy and protected-route tests | Complete |
| Resumable cross-Admin non-modal onboarding | D1 setup progress for all six required tasks; optional integrations separate | setup-progress, live dashboard, and browser tests | Complete |
| Organization branding with optional subtitle/logo and themed/light/dark modes | D1 settings, local data-image storage, explicit organization-colors mode, temporary light/dark override | branding validation, migration, typecheck, and browser interaction | Complete |
| Retain until Admin export/deletion; CSV and D1 backup/restore only | attendance CSV, scoped destructive routes, token-only maintenance helper | CSV quoting/formula safety, deletion ordering, backup/restore tests | Complete |
| Google, Resend, and full Discord administration/workflows | encrypted configure/status/test/rotate/remove; mail, linking, pings/contests, calendar, persistent status | provider mocks, idempotency, secret-redaction, and Google-only lockout-prevention tests | Complete with mocked providers |
| Manual captive portals and offline-first behavior | documented manual networking; atomic Pi queue | restart/order/retry queue tests | Complete within supported boundary |
| Consent-gated five-field telemetry and plain privacy notice | adopter sender plus isolated HMAC collector, aggregate authentication, k-anonymous metros, retention | adversarial sender/collector tests and local D1 collector migration | Runtime complete; public operator/endpoint policy pending |
| Task-first accessible public documentation with annotated visuals | static GitHub Pages site and six sanitized annotated assets | structural tests plus local/live browser verification | Complete; WCAG 2.2 A target |
| Community support without SLA | public docs and README list `robolancers@gmail.com` with no SLA | documentation tests | Complete |

## External acceptance boundary

No existing attendance installation, Cloudflare resource, Raspberry Pi, credential, database, or repository was used. A real Create workflow run and Pi/R503 smoke test require targets explicitly supplied for LancerLogin only. The community telemetry endpoint also remains unset until its public operator, HTTPS URL, retention, aggregate-access, and incident/deletion policy are approved. Accepted telemetry is therefore a safe no-op in the published adopter template.
