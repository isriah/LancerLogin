# Security model

LancerLogin is designed for a private adopter-owned deployment. Public source, releases, and documentation are separate from each installation's private repository, Cloudflare account, credentials, backups, and attendance data.

## Access and sessions

Administrators manage authenticated accounts in **Settings → Access**. Roster membership never grants an account. Local passwords use a unique-salt, memory-hard scrypt hash and are not recoverable. Failed local sign-ins are rate limited per account without collecting an IP address. Sessions are signed, expiry-bound, Secure, HTTP-only, and SameSite=Strict; every protected request rechecks the active account and current role.

Google OAuth uses signed, expiring state and validates issuer, audience, verified email, account activity, and explicit enablement. Google cannot be disabled when no active Administrator can sign in with a local password.

## Data and integrations

Integration credentials are encrypted with an installation-specific Worker secret and never returned in API responses. Saved but unverified or disabled integrations cannot send operational messages. Verification, credential changes, access changes, exports, and attendance changes are audited.

Google Calendar sends only a generic event name and meeting times. Discord signed interactions are verified before processing. Discord operations are limited to the configured server and LancerLogin-tracked message or event identifiers. The adopter must restrict any staff-only Discord channel it chooses. LancerLogin does not enumerate, moderate, or delete unrelated Discord content.

CSV export prefixes formula-like values as text before quoting. This prevents roster or meeting data from being interpreted as a spreadsheet formula.

## Updates and recovery

Web updates require current Administrator authorization, an exact dashboard origin, a pinned official stable release, an entire-installation backup, and a durable update request. The browser cannot choose deployment resources. Refreshing update status does not dispatch another update. Recovery retains a deployment lock until an explicit review confirms the next action and API/Pages health.

Physical kiosk updates are separate from web updates. Do not treat a simulator or dashboard state as proof of a physical update. The completed 1.0.2 kiosk update was run with the terminal updater through Raspberry Pi Connect remote shell; dashboard kiosk release lookup acceptance remains unproven. See [KIOSK.md](KIOSK.md) and [WEB-UPDATES.md](WEB-UPDATES.md).

## Report a concern

For a responsible security or privacy concern, contact robolancers@gmail.com without sending credentials, attendance records, fingerprints, or backup contents.
