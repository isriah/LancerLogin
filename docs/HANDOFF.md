# Handoff

## Delivered

- Fresh public Apache-2.0 repository: `https://github.com/isriah/LancerLogin`; no source, credentials, configuration, resources, commits, or history from the reference installation were copied.
- Runnable Cloudflare Worker/D1 API, Vite/React dashboard, Raspberry Pi service, shared domain package, CI, release workflow, and public documentation site.
- Guarded adopter-owned Cloudflare provisioning verifies an account-owned token against the selected `CLOUDFLARE_ACCOUNT_ID`, refuses Create collisions, supports explicit Resume including interrupted secret setup, generates installation secrets, migrates D1, and deploys Worker/Pages. It has not been run by this project.
- Local salted-scrypt and Google OAuth authentication; JSON/CORS-protected first-Admin bootstrap; immediate active-user/current-role session revalidation; Admin/Operator enforcement; user administration; Google-only lockout prevention; interactive local recovery.
- Shared onboarding, explicit themed/light/dark branding, roster, explicit one-kiosk replacement, retained heartbeat/reader/release health, R503 in-sensor enrollment and slot-only matching, an 800×480 touch UI, atomic offline queue, meetings, attendance, reasoned corrections/excuses, formula-safe CSV, typed-confirmation deletion, and D1 backup/restore.
- Encrypted Google/Resend/Discord administration plus mocked/tested provider workflows. The single Discord kiosk-status message updates automatically from authenticated heartbeat state and a five-minute offline reconciliation without blocking kiosk operation. Consent-gated telemetry allowlists its payload and never reads raw IP into it. A separate collector-only deployment uses HMAC install identifiers, daily deduplication, edge limits, authenticated aggregates, k-anonymous metros, and scheduled retention; its live workflow passed health and synthetic report/aggregate/deletion checks.
- Accessible, task-first static documentation with browser-verified annotated dashboard, GitHub, Cloudflare, OAuth, kiosk, and integration visuals plus the community support contact.

## Verification boundary

All current automated tests, workspace typechecks, sanitizer checks, dependency audit, and production builds pass locally. CI and tagged releases run `npm run verify:migrations`, which applies and inspects the complete migration chain on a fresh isolated local D1 database without credentials or remote access. Browser verification covered the no-cloud setup preview, explicit themed branding plus a temporary dark override, retained kiosk health, public documentation, and the local kiosk at the Waveshare-sized 800×480 viewport. Provider calls use mocked responses in tests. The R503 protocol uses an injected mock transport. The community collector alone was deployed to a fresh collector-only target and live-tested; no adopter provisioning or physical Pi/sensor run has occurred. `docs/COMPLETION-AUDIT.md` is the durable requirement-to-evidence matrix.

## Remaining acceptance

1. When a user explicitly supplies a separate fresh LancerLogin-only adopter Cloudflare target and Raspberry Pi, run Create provisioning and the hardware smoke checklist. Never use the existing attendance installation, the collector-only account, or either account's resources for the other purpose.
