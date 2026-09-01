# Architecture

## Components

```text
Admin browser ── Pages dashboard + /api proxy ── Worker API ── D1
                                                    │   │
                                                    │   └─ encrypted integration credentials
                                                    └──── Resend / Discord / Google OAuth

Raspberry Pi kiosk ── local service ── R503 fingerprint sensor
       │                       │
       └── pairing code / HTTPS┴── Worker API
```

The dashboard is a static Pages application with an advanced-mode `_worker.js` proxy for `/api/*`. Browser sessions therefore remain first-party on the adopter's Pages origin while API work is forwarded to the separate Worker. The Worker owns authorization, onboarding state, non-overlapping meeting-window validation, scan-time meeting resolution, data validation, encrypted secret handling, exports, and integration calls. D1 contains all organization-level data but no fingerprint templates. The Pi service owns sensor I/O, owner-only local pairing material, local slot-to-member mappings, offline scan queue, kiosk display state, and PIN-protected local network/fingerprint tools.

An optional community telemetry collector is a separate maintainer service and never shares adopter resources. The adopter Worker sends only the consent-gated allowlist to its public ingestion route. The collector HMAC-hashes the opaque install ID, stores one bounded daily row, and exposes only authenticated aggregates; it never receives roster, attendance, biometric, organization, credential, or raw-IP fields.

Worker persistence adapters scope every query and write to an installation ID. Their test double captures bound parameters so cross-installation access is rejected by contract before a real D1 binding is used.

The Worker request boundary allows unauthenticated health and CORS preflight only. Every administrative route authenticates a principal and maps the request to an approved role capability before it invokes a repository or integration.

## Data boundaries

| Location | May store | Must not store |
| --- | --- | --- |
| R503 sensor | fingerprint templates | cloud credentials |
| Pi local storage | slot/member mapping, queued attendance, pairing material | fingerprint templates copied from sensor |
| D1 | roster, meetings, attendance, settings, audit records, encrypted integration secrets | fingerprint templates, raw biometric scans, raw IP |
| Telemetry endpoint | approved aggregate fields | roster, attendance, organization, biometrics, raw IP |

## Security controls

- Pairing codes are single-use, time-limited, hashed at rest, and bound to one installation.
- Dashboard-to-Pi recovery accepts four short-lived enumerated commands only; it provides no remote shell or arbitrary arguments.
- Network and fingerprint controls are loopback-only, protected by a locally salted/rate-limited PIN, and backed by narrow Polkit permissions.
- Worker session tokens use Secure, HTTP-only, SameSite=Strict cookies through the same-origin Pages proxy; OAuth ID tokens are verified server-side.
- Every permission-sensitive API path reloads the active user and current role from D1 before checking Admin or Operator capability.
- Destructive actions require an explicit confirmation phrase and immutable audit record.
- Secret encryption uses AES-GCM with per-record random IVs and an installation-specific Worker secret.
- Integration test actions use least-privilege operations and do not reveal credentials.
- CSV export neutralizes leading spreadsheet formula markers before quoting cells.
