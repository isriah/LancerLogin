# Architecture

## Components

```text
Admin browser ── Pages dashboard + /api proxy ── Worker API ── D1
                                                    │   │
                                                    │   └─ encrypted integration credentials
                                                    └──── Resend / Discord / Google OAuth / Google Calendar

Raspberry Pi kiosks ── local identity adapters ── R503, keyboard-wedge reader, or touch entry
       │                       │
       └── pairing code / HTTPS┴── Worker API
```

The dashboard is a static Pages application with an advanced-mode `_worker.js` proxy for `/api/*`. Browser sessions therefore remain first-party on the adopter's Pages origin while API work is forwarded to the separate Worker. The Worker owns authorization, onboarding state, non-overlapping meeting-window validation, scan-time meeting resolution, data validation, encrypted secret handling, exports, and integration calls. Optional Google Calendar and Discord scheduled-event delivery each keep installation-scoped meeting mappings and durable retry operations in D1. Discord label role associations and manual full-server sync jobs are installation-scoped D1 state. Google Calendar keeps separate encrypted authorization and meeting titles, notes and times; Discord keeps its verified bot configuration and provider-specific event fields. LancerLogin remains authoritative and never imports provider changes. D1 contains organization-level data and, with optional cloud storage enabled, durable server-encrypted vault copies. Historical peer-encrypted deliveries and public identities may remain after peer sharing is retired. D1 stores no plaintext templates, raw fingerprint images, or raw badge and QR credentials. The Worker can decrypt the optional vault, but not peer-encrypted messages. Each Pi service owns its device's identity I/O, owner-only local pairing material, local identity mappings and active-roster cache, offline scan queue, kiosk display state, and PIN-protected local network and authentication tools.

The kiosk normalizes every supported method to one member identity before it enters the existing debounce, pairing capture, offline queue, Worker attendance resolution, and Welcome or Goodbye feedback path. Fingerprint is the default for newly paired kiosks. Migration 0073 preserves each existing kiosk's effective installation-configured method in its own configured field. The historical global field remains for older backup compatibility and cannot override per-kiosk choices. The dashboard stores each kiosk's configured method while each kiosk heartbeat reports the method actually applied, so a disconnected kiosk is shown as pending rather than relabeled from stale health data.

Modules contribute Worker routes, dashboard pages, settings, setup steps, jobs and tables to this structure. Attendance is a first-party module; plugins are composed into the dashboard and Worker at build time. See [module authoring](MODULE-AUTHORING.md) and [module plugins](MODULE-PLUGINS.md).

Worker persistence adapters scope every query and write to an installation ID. Their test double captures bound parameters so cross-installation access is rejected by contract before a real D1 binding is used.

The Worker request boundary allows unauthenticated health and CORS preflight only. Every administrative route authenticates a principal and maps the request to an approved role capability before it invokes a repository or integration.

## Data boundaries

Web updates use Admin-only prepare/start/status control and an installation-scoped D1 request/executor lock. A fixed private GitHub Actions controller owns exact-release deployment, preserved-resource checks and recovery checkpoints. Worker dispatch credentials are secrets, excluded from D1/API/backups. Maintenance returns retryable kiosk errors while queued scans remain local. See [WEB-UPDATES.md](WEB-UPDATES.md).

Server-owned update-track consent lives in a separate operational table with revision-based atomic changes and audit records. Stable is the default. Web requests and kiosk commands retain the selected track, official tag and exact commit. Discovery and browser hint caches are partitioned by track. The canonical release policy is packaged with the kiosk resolver so it does not depend on a source checkout. See [UPDATE-TRACKS.md](UPDATE-TRACKS.md).

| Location | May store | Must not store |
| --- | --- | --- |
| R503 sensor | fingerprint templates | cloud credentials |
| Pi local storage | slot/member mapping with optional immutable roster identity, keyed credential digests, local credential secret, active-roster cache, queued attendance, pairing material; optional sync private keys, trust, encrypted outbox and receiver journal; vault slot/retry metadata | plaintext fingerprint templates, raw badge or QR values at rest |
| D1 | roster, meetings, attendance, configured and reported authentication methods, settings, audit records, encrypted integration secrets; historical peer-sync public identities/deliveries; optional vault ciphertext and immutable enrollment metadata | plaintext fingerprint templates, raw biometric scans, vault root secret, kiosk private decryption keys, raw badge or QR values, local credential digests or secret, raw IP |

Fingerprint sharing is Attendance-owned operational state, excluded from portable backups, and optional cloud storage is its only active transport (peer transfer routes are retired). Cloud storage uses a server-managed `FINGERPRINT_VAULT_KEY` to derive distinct authenticated-encryption and keyed-digest keys; its tables hold generation and key identity, immutable roster binding and ciphertext. `/kiosk/roster` projects the immutable identity additively. Kiosk polling backfills at most two verified source slots per pass and requests up to eight missing templates per batch after a catalog revision change. Attendance queues contain no template data. See [SECURITY.md](SECURITY.md#optional-server-managed-fingerprint-storage) and [PRIVACY.md](PRIVACY.md#optional-fingerprint-cloud-storage) for trust, retention and revocation.

Compatible kiosks combine background reads through `/kiosk/poll`: commands every five seconds, fingerprint metadata every fifteen seconds and configuration every minute. Each response checks current kiosk and module authority. Revision-validated roster and vault metadata can be reused locally, while transfers retain their own authorization and recovery checks. Heartbeats remain separate writes. Older clients keep their existing endpoints; newer clients use those endpoints only when the combined route is explicitly unsupported.

## Security controls

- Pairing codes are single-use, time-limited, hashed at rest, and bound to one installation.
- Dashboard-to-Pi maintenance accepts six short-lived enumerated commands only (`reload_display`, `restart_service`, `reboot`, `reset_network_pin`, `install_latest`, `erase_unlinked_fingerprints`); it provides no remote shell or arbitrary arguments.
- Network and authentication maintenance controls are loopback-only, protected by a locally salted and rate-limited PIN, and backed by narrow Polkit permissions.
- An Admin can start a five-minute fingerprint enrollment session for one online kiosk from the dashboard. The kiosk confirms the member locally and uses a free reader slot for two scans. This session grants enrollment only, not general maintenance access. Every delivery checks current pairing, creator and member authority; sessions are operational state excluded from portable backups.
- Worker session tokens use Secure, HTTP-only, SameSite=Strict cookies through the same-origin Pages proxy; OAuth ID tokens are verified server-side.
- Every permission-sensitive API path reloads the active user and current role from D1 before checking Admin or Operator capability.
- Destructive actions require an explicit confirmation phrase and immutable audit record.
- Secret encryption uses AES-GCM with per-record random IVs and an installation-specific Worker secret.
- Integration test actions use least-privilege operations and do not reveal credentials.
- CSV export neutralizes leading spreadsheet formula markers before quoting cells.
- The Worker owns the versioned saved-report definition and curated column registry. `/reports/query` and both report CSV endpoints validate the same definition, resolve organization-local periods, and use the canonical attendance evaluator. Page and page-size state stay outside saved definitions.
