# Security model

LancerLogin is designed for a private adopter-owned deployment. Public source, releases, and documentation are separate from each installation's private repository, Cloudflare account, credentials, backups, and attendance data.

## Access and sessions

Administrators manage authenticated accounts in **Settings → Access**. Roster membership never grants an account. Local passwords use a unique-salt, memory-hard scrypt hash and are not recoverable. Failed local sign-ins are rate limited per account without collecting an IP address. Sessions are signed, expiry-bound, Secure, HTTP-only, and SameSite=Strict; every protected request rechecks the active account and current role.

Google OAuth uses signed, expiring state and validates issuer, audience, verified email, account activity, and explicit enablement. Google cannot be disabled when no active Administrator can sign in with a local password.

## Data and integrations

Integration credentials are encrypted with an installation-specific Worker secret and never returned in API responses. Saved but unverified or disabled integrations cannot send operational messages. Verification, credential changes, access changes, exports, and attendance changes are audited.

Google Calendar sends meeting titles, notes as event descriptions, and meeting times. Restrict the connected calendar to the intended audience. Discord signed interactions are verified before processing. Discord operations are limited to the configured server, LancerLogin-tracked message or event identifiers, and roles explicitly associated with active member labels. A manual role sync enumerates that server's members and changes only its selected mapped role after an Admin reviews a full preview. The adopter must restrict any staff-only Discord channel it chooses. LancerLogin does not moderate or delete unrelated Discord content.

CSV export prefixes formula-like values as text before quoting. This prevents roster or meeting data from being interpreted as a spreadsheet formula.

## Kiosk identity boundary

Fingerprint, RFID badge, NFC badge, member ID, and QR code input all resolve to a member ID on the kiosk before the shared attendance pipeline runs. Fingerprint templates remain in the R503 unless Admin-enabled cloud storage is enabled. RFID, NFC, and QR readers are treated as bounded keyboard-wedge inputs: the kiosk transforms each value with HMAC-SHA256 and an owner-only local secret, then stores only the keyed digest and member mapping. Raw badge and QR values, local digests, and the local transform secret are excluded from Worker requests, D1, logs, fixtures, and portable dashboard backups.

Member ID entry is explicit touch or keyboard input and succeeds only for a member in the kiosk's current active-roster cache. Stored badge and QR mappings also fail closed when the mapped member is no longer active. Local authentication maintenance is loopback-only and requires the rate-limited local settings PIN. Separately, an Administrator can authorize a kiosk-scoped dashboard fingerprint enrollment session lasting at most five minutes. It grants no general maintenance unlock, requires physical name confirmation, uses verified free slots only and rechecks current server authority before confirmation and reader storage. Cancellation, expiry, changed pairing, disabled Attendance or lost administrator authority prevents further enrollment. Unknown credentials do not fall back to another method. Only an Administrator can change a selected active kiosk's configured method. Both configuration endpoints deliver that device's own method, and a heartbeat updates only its reported state. Changing one kiosk or the retained historical installation setting cannot change another kiosk's selection.

Disabling Attendance or retiring a kiosk revokes server-side authority, but it cannot erase an R503 template or a local badge or QR mapping from a disconnected Pi. Before repurposing or decommissioning a kiosk, unlock **Authentication maintenance** on that device and remove local mappings. LancerLogin intentionally provides no remote destructive wipe.

### Retired peer fingerprint sharing

Cloud storage is the only supported fingerprint synchronization path. Peer enablement, approval, registration and transfer endpoints are retired. Older clients receive disabled peer metadata; transfer requests are rejected. Upgrading does not enable cloud storage automatically or delete reader templates, local mappings, historical keys, encrypted outboxes or import journals. Preserve this protected historical state for recovery. Previously retained relay ciphertext and backups are not erased by this software change; any historical cleanup requires a separately reviewed procedure.

### Optional server-managed fingerprint storage

Cloud storage is off by default. An Admin must explicitly confirm its biometric-storage boundary. Enabling it authorizes automatic upload of identity-verified mapped enrollments and automatic download to every currently authorized paired R503 kiosk. Existing source kiosks need not remain online after upload. There is no additional local peer-approval requirement for this option.

The Worker receives a template over authenticated HTTPS, encrypts it for durable storage, and can decrypt it for an authorized kiosk. This is not end-to-end encryption against the server. A separate 32-byte `FINGERPRINT_VAULT_KEY` root secret derives distinct AES-256-GCM and HMAC-SHA256 keys using HKDF-SHA256. Each ciphertext uses a fresh 12-byte nonce. Authenticated context binds the installation, vault generation, key identity, immutable roster row, fingerprint identity and keyed digest, source pairing, enrollment and creation time. D1 contains ciphertext and operational metadata, never plaintext templates or the root secret. Browser/Admin routes expose settings and counts only, not templates or a valid-ID catalog.

Uploads require both the external member ID and immutable roster ID. New online enrollments retain this identity in protected local mappings, and downloaded copies preserve it. Older or offline mappings without a verified immutable identity require re-enrollment before sharing. Retired review approvals cannot supply that authority, and their cloud copies are revoked without removing independent fresh enrollments. Neither current ID equality nor a recycled external ID silently authorizes old-template backfill. Unknown reader slots are never read for backfill. A download may reuse only an authenticated byte-identical occupied slot already bound to that same immutable member; otherwise it uses a verified free slot and never overwrites.

Every cloud operation checks Attendance enablement, active immutable member binding, vault generation/key identity and the current kiosk credential/pairing. The Worker rechecks authority after encryption or decryption. Retiring or replacing a source kiosk revokes its future requests but does not erase an otherwise valid member's retained fingerprints. Member deactivation or ID change clears that member's cloud templates. Storage disablement, Attendance disablement or portable installation restore removes vault authority and cloud ciphertext. Completed local journals prevent a removed mapping being silently recreated. Existing local copies remain and require individual device review.

The runtime processes at most two source captures and eight missing templates per poll. Compatible clients fetch a revision-bound complete catalog (up to 10,000 entries) when it changes and batch only missing templates; stale revisions or authority changes reject the response. Older clients retain paginated manifests. The runtime bounds HTTPS requests and replies, and uses the shared sensor lock and owner-only metadata journal for idempotent recovery. Plaintext exists briefly in Worker and kiosk memory, not intentionally in D1, files or logs. A compromised server, authorized kiosk, owner-level Pi account or memory dump can expose it. Missing or changed keys fail closed; preserve ciphertext and recover the original separate key. An Admin can still disable storage to delete cloud copies when the key is unavailable. See [PRIVACY.md](PRIVACY.md) and [BACKUP-RESTORE.md](BACKUP-RESTORE.md).

### Fingerprint re-enrollment and mapping reset

Legacy mappings cannot acquire immutable identity from a current external-ID lookup alone. Staff must re-enroll the member while the kiosk is online, using PIN-protected Authentication maintenance or a dashboard enrollment session with physical name confirmation and a verified free slot. There is no mapped-slot approval screen, biometric proof snapshot or member-lookup approval route. Retired approval identifiers remain denied so removing old provenance fields cannot revive their cloud authority. Historical review data is not a portable source of trust.

Updating software does not automatically clear local mappings or reader templates. A deliberate reset can start re-enrollment from clean associations. Preserve protected kiosk state first and wait for every active kiosk's reset acknowledgement. Reader templates remain and require deliberate replacement of known slots; unknown occupied slots are never automatically overwritten.

An audited mappings-only reset atomically removes cloud authority and live ciphertext, rotates/disables peer relay authority, clears queued transfers, and queues commands for each current active pairing. Fingerprint uploads and transfers remain blocked for a pending pairing until its durable local acknowledgement. Command polling stays available while sharing is off. Local reset quiesces sharing and clears only fingerprint identity associations under the sensor lock; it does not erase reader templates, attendance queues, roster, pairing or other authentication mappings. Offline kiosks can still use old local mappings until reconnect, so the dashboard reports per-pair pending status rather than instantaneous global removal.

## Updates and recovery

Kiosk unpairing is a loopback-only, same-origin, PIN-authorized and explicitly confirmed local operation. It drains in-flight installation work and blocks when attendance is pending. A durable owner-only journal archives installation-bound files before the service restarts, preventing cached credentials, roster, mappings, queue history and fingerprint trust from carrying into a new pairing. Interrupted archival blocks scanning and pairing until locally authorized recovery finishes; malformed or unsafe filesystem state fails closed. The local PIN and NetworkManager connections are retained, and no reader template is erased. This is not remote credential revocation: retire the old dashboard device separately and protect the archive as credential-bearing biometric-related material.

Web updates require current Administrator authorization, an exact dashboard origin, a pinned official release allowed by the server-owned track, an entire-installation backup, and a durable request. Stable is the default; Beta requires explicit audited consent. The browser cannot choose deployment resources, tags or commits. Refreshing status never redispatches. Recovery retains a deployment lock until explicit review confirms the next action and API/Pages health.

Tracks never install or downgrade software. Started web updates and recent pending kiosk updates lock the track. Beta preparation requires the reviewed private controller; a kiosk needs its installed channel-aware root helper. Execution independently checks release flags, complete assets, exact tag/commit and immutable beta metadata. See [UPDATE-TRACKS.md](UPDATE-TRACKS.md).

Physical kiosk updates are separate from web updates. Do not treat a simulator or dashboard state as proof of a physical update. The completed 1.0.2 kiosk update was run with the terminal updater through Raspberry Pi Connect remote shell; dashboard kiosk release lookup acceptance remains unproven. See [KIOSK.md](KIOSK.md) and [WEB-UPDATES.md](WEB-UPDATES.md).

## Report a concern

For a responsible security or privacy concern, contact robolancers@gmail.com without sending credentials, attendance records, fingerprints, or backup contents.
