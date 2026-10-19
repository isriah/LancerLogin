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

Community telemetry has been retired. Historical database columns remain inert for backup compatibility.

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

Fingerprint sync is Attendance-owned operational state, excluded from portable backups. Cloud storage is its only active transport. Peer registration and transfer routes are retired and combined polling returns disabled peer metadata for older clients. Historical relay tables, local encrypted outboxes and journals are retained for recovery; this change does not erase existing fingerprints. Attendance queues contain no template data.

Optional cloud storage is Attendance-owned and non-portable. It uses a server-managed `FINGERPRINT_VAULT_KEY` to derive distinct authenticated-encryption and keyed-digest keys. The Worker can decrypt these durable copies for current paired kiosks; this is not the peer relay's end-to-end trust boundary. Its settings and templates tables contain generation/key identity, immutable roster binding and ciphertext. API upload accepts external and immutable roster IDs together; `/kiosk/roster` projects the immutable identity additively. New online enrollments and imports retain it in local mappings, while unbound legacy and review-derived mappings require re-enrollment before sharing. Kiosk polling backfills at most two verified source slots per pass. Compatible clients fetch the complete enrollment catalog when its revision changes, then request up to eight missing templates per batch. Unchanged revisions reuse metadata only after a fresh authorized poll. Older clients retain eight-item manifest pagination. Shared sensor locking and metadata-only journals preserve occupied slots and exact retries. Source retirement preserves valid member enrollments; member revocation, vault/Attendance disablement and portable restore remove applicable cloud authority. See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) for trust, retention, and revocation limits.

Compatible kiosks combine background reads through `/kiosk/poll`: commands every five seconds, fingerprint metadata every fifteen seconds and configuration every minute. Each response checks current kiosk and module authority. Revision-validated roster and vault metadata can be reused locally, while transfers retain their own authorization and recovery checks. Heartbeats remain separate writes. Older clients keep their existing endpoints; newer clients use those endpoints only when the combined route is explicitly unsupported.

## Security controls

- Pairing codes are single-use, time-limited, hashed at rest, and bound to one installation.
- Dashboard-to-Pi recovery accepts four short-lived enumerated commands only; it provides no remote shell or arbitrary arguments.
- Network and authentication maintenance controls are loopback-only, protected by a locally salted and rate-limited PIN, and backed by narrow Polkit permissions.
- Worker session tokens use Secure, HTTP-only, SameSite=Strict cookies through the same-origin Pages proxy; OAuth ID tokens are verified server-side.
- Every permission-sensitive API path reloads the active user and current role from D1 before checking Admin or Operator capability.
- Destructive actions require an explicit confirmation phrase and immutable audit record.
- Secret encryption uses AES-GCM with per-record random IVs and an installation-specific Worker secret.
- Integration test actions use least-privilege operations and do not reveal credentials.
- CSV export neutralizes leading spreadsheet formula markers before quoting cells.
- The Worker owns the versioned saved-report definition and curated column registry. `/reports/query` and both report CSV endpoints validate the same definition, resolve organization-local periods, and use the canonical attendance evaluator. Page and page-size state stay outside saved definitions.
