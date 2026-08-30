# Architecture

## Components

```text
Admin browser ── Pages dashboard ── Worker API ── D1
                                      │   │
                                      │   └─ encrypted integration credentials
                                      └──── Resend / Discord / Google OAuth

Raspberry Pi kiosk ── local service ── R503 fingerprint sensor
       │                       │
       └── pairing code / HTTPS┴── Worker API
```

The dashboard is a static Pages application. The Worker owns authorization, onboarding state, data validation, encrypted secret handling, exports, and integration calls. D1 contains all organization-level data but no fingerprint templates. The Pi service owns sensor I/O, encrypted local pairing material, local slot-to-member mappings, offline scan queue, and kiosk display state.

Worker persistence adapters scope every query and write to an installation ID. Their test double captures bound parameters so cross-installation access is rejected by contract before a real D1 binding is used.

## Data boundaries

| Location | May store | Must not store |
| --- | --- | --- |
| R503 sensor | fingerprint templates | cloud credentials |
| Pi local storage | slot/member mapping, queued attendance, pairing material | fingerprint templates copied from sensor |
| D1 | roster, meetings, attendance, settings, audit records, encrypted integration secrets | fingerprint templates, raw biometric scans, raw IP |
| Telemetry endpoint | approved aggregate fields | roster, attendance, organization, biometrics, raw IP |

## Security controls

- Pairing codes are single-use, time-limited, hashed at rest, and bound to one installation.
- Worker session tokens use secure, HTTP-only cookies for local auth; OAuth ID tokens are verified server-side.
- Every permission-sensitive API path checks Admin or Operator capability explicitly.
- Destructive actions require an explicit confirmation phrase and immutable audit record.
- Secret encryption uses AES-GCM with per-record random IVs and an installation-specific Worker secret.
- Integration test actions use least-privilege operations and do not reveal credentials.
