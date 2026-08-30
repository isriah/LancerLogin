# Handoff

## Delivered

- Fresh public Apache-2.0 repository: `https://github.com/isriah/LancerLogin`; no source, credentials, configuration, resources, commits, or history from the reference installation were copied.
- Runnable Cloudflare Worker/D1 API, Vite/React dashboard, Raspberry Pi service, shared domain package, CI, release workflow, and public documentation site.
- Guarded adopter-owned Cloudflare provisioning discovers the account from `CLOUDFLARE_API_TOKEN`, refuses Create collisions, supports explicit Resume, generates installation secrets, migrates D1, and deploys Worker/Pages. It has not been run by this project.
- Local salted-scrypt and Google OAuth authentication; Admin/Operator enforcement; user administration; interactive local recovery.
- Shared onboarding, branding, roster, one-kiosk pairing, R503 slot-only scan protocol, atomic offline queue, meetings, attendance, reasoned corrections/excuses, CSV, typed-confirmation deletion, and D1 backup/restore.
- Encrypted Google/Resend/Discord administration plus mocked/tested provider workflows. Consent-gated telemetry allowlists its payload and never reads raw IP into it.
- Accessible, task-first static documentation with an annotated, browser-verified dashboard screenshot and community support contact.

## Verification boundary

All current automated tests, workspace typechecks, sanitizer checks, and production builds pass locally. Browser verification covered the no-cloud setup preview and public documentation. Provider calls use mocked responses in tests. The R503 protocol uses an injected mock transport; no physical Pi, sensor, GitHub provisioning run, or Cloudflare deployment was touched.

## Remaining acceptance

1. Decide and security-review the community telemetry collector URL, retention, access controls, and public operator. Until `TELEMETRY_ENDPOINT` is configured in the release template, accepted telemetry is safely a no-op.
2. When a user explicitly supplies a fresh LancerLogin-only Cloudflare target and Raspberry Pi, run Create provisioning and the hardware smoke checklist. Never use the existing attendance installation or its resources.
