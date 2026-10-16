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

Fingerprint, RFID badge, NFC badge, member ID, and QR code input all resolve to a member ID on the kiosk before the shared attendance pipeline runs. Fingerprint templates remain in the R503 unless optional peer-approved sync or Admin-enabled cloud storage is enabled. RFID, NFC, and QR readers are treated as bounded keyboard-wedge inputs: the kiosk transforms each value with HMAC-SHA256 and an owner-only local secret, then stores only the keyed digest and member mapping. Raw badge and QR values, local digests, and the local transform secret are excluded from Worker requests, D1, logs, fixtures, and portable dashboard backups.

Member ID entry is explicit touch or keyboard input and succeeds only for a member in the kiosk's current active-roster cache. Stored badge and QR mappings also fail closed when the mapped member is no longer active. Authentication maintenance is loopback-only and requires the rate-limited local settings PIN. Unknown credentials do not fall back to another method.

Disabling Attendance or retiring a kiosk revokes server-side authority, but it cannot erase an R503 template or a local badge or QR mapping from a disconnected Pi. Before repurposing or decommissioning a kiosk, unlock **Authentication maintenance** on that device and remove local mappings. LancerLogin intentionally provides no remote destructive wipe.

### Fingerprint sync trust boundary

Peer-sync installation opt-in does not approve devices. Each participating kiosk creates local encryption and signing keys, registers only its public identity, and requires a PIN-authorized comparison of the full peer fingerprint shown on the other device. A changed key or pairing cannot silently replace approved trust. Compare fingerprints through an independent trusted channel when the devices are on different networks. Never approve solely because a relay-provided device name looks familiar.

Templates use a fresh AES-256-GCM key and nonce per message, with the key wrapped for the recipient using RSA-3072 OAEP/SHA-256 and the envelope signed with Ed25519. Authenticated context binds the installation sync identity, both devices and pairings, both key identities, member, enrollment, transfer, revision, and expiry. Private keys remain in owner-only Pi files. End-to-end encryption protects template contents from the relay, not traffic metadata, compromised kiosk software, or an attacker with owner-level Pi access.

The relay checks current pairing, active membership, installation enablement, and registered keys when accepting and serving messages. Recipient authorization also requires locally approved trust and a freshly fetched or revision-revalidated active roster. Conditional roster responses and combined polling responses require a current authorized request and the current roster revision. A failed revalidation discards cached roster authority, and sharing a response between peer and cloud sync never extends its original freshness deadline. The receiver checks actual sensor occupancy and existing mappings, reserves a nonconflicting local slot, and verifies stored bytes before completing the mapping and acknowledgement. An interrupted transfer resumes only when the journal and reader contents agree. A conflicting or ambiguous slot fails closed; sync does not overwrite or delete existing templates.

Transfers are separate from attendance delivery. No same-LAN discovery, inbound Pi port, or port forwarding is needed. Loss of the relay pauses new transfers; already enrolled local fingerprints can still use normal offline attendance behavior. Disabling or revoking sync is not remote erasure. Local mapping removal does not retract copies already queued at the relay or stored elsewhere. See [privacy and retention](PRIVACY.md) and [kiosk recovery](KIOSK.md).

### Optional server-managed fingerprint storage

Cloud storage is independent of peer sync and off by default. An Admin must explicitly confirm its biometric-storage boundary. Enabling it authorizes automatic upload of identity-verified mapped enrollments and automatic download to every currently authorized paired R503 kiosk. Existing source kiosks need not remain online after upload. There is no additional local peer-approval requirement for this option.

The Worker receives a template over authenticated HTTPS, encrypts it for durable storage, and can decrypt it for an authorized kiosk. This is not end-to-end encryption against the server. A separate 32-byte `FINGERPRINT_VAULT_KEY` root secret derives distinct AES-256-GCM and HMAC-SHA256 keys using HKDF-SHA256. Each ciphertext uses a fresh 12-byte nonce. Authenticated context binds the installation, vault generation, key identity, immutable roster row, fingerprint identity and keyed digest, source pairing, enrollment and creation time. D1 contains ciphertext and operational metadata, never plaintext templates or the root secret. Browser/Admin routes expose settings and counts only, not templates or a valid-ID catalog.

Uploads require both the external member ID and immutable roster ID. New online enrollments retain this identity in protected local mappings, and downloaded copies preserve it. Older or offline mappings without a verified immutable identity require re-enrollment before sharing. Retired review approvals cannot supply that authority, and their cloud copies are revoked without removing independent fresh enrollments. Neither current ID equality nor a recycled external ID silently authorizes old-template backfill. Unknown reader slots are never read for backfill. A download may reuse only an authenticated byte-identical occupied slot already bound to that same immutable member; otherwise it uses a verified free slot and never overwrites.

Every cloud operation checks Attendance enablement, active immutable member binding, vault generation/key identity and the current kiosk credential/pairing. The Worker rechecks authority after encryption or decryption. Retiring or replacing a source kiosk revokes its future requests but does not erase an otherwise valid member's retained fingerprints. Member deactivation or ID change clears that member's cloud templates. Storage disablement, Attendance disablement or portable installation restore removes vault authority and cloud ciphertext. Completed local journals prevent a removed mapping being silently recreated. Existing local copies remain and require individual device review.

The runtime processes at most two source captures and an eight-item download manifest per poll, bounds HTTPS requests and replies, and uses the shared sensor lock and owner-only metadata journal for idempotent recovery. Plaintext exists briefly in Worker and kiosk memory, not intentionally in D1, files or logs. A compromised server, authorized kiosk, owner-level Pi account or memory dump can expose it. Missing or changed keys fail closed; preserve ciphertext and recover the original separate key. An Admin can still disable storage to delete cloud copies when the key is unavailable. See [PRIVACY.md](PRIVACY.md) and [BACKUP-RESTORE.md](BACKUP-RESTORE.md).

### Fingerprint re-enrollment and mapping reset

Legacy mappings cannot acquire immutable identity from a current external-ID lookup alone. Staff must re-enroll the member through PIN-protected Authentication maintenance while the kiosk is online. There is no mapped-slot approval screen, biometric proof snapshot or member-lookup approval route. Retired approval identifiers remain denied so removing old provenance fields cannot revive their cloud authority. Historical review data is not a portable source of trust.

Updating software does not automatically clear local mappings or reader templates. A deliberate reset can start re-enrollment from clean associations. Preserve protected kiosk state first and wait for every active kiosk's reset acknowledgement. Reader templates remain and require deliberate replacement of known slots; unknown occupied slots are never automatically overwritten.

An audited mappings-only reset atomically removes cloud authority and live ciphertext, rotates/disables peer relay authority, clears queued transfers, and queues commands for each current active pairing. Fingerprint uploads and transfers remain blocked for a pending pairing until its durable local acknowledgement. Command polling stays available while sharing is off. Local reset quiesces sharing and clears only fingerprint identity associations under the sensor lock; it does not erase reader templates, attendance queues, roster, pairing or other authentication mappings. Offline kiosks can still use old local mappings until reconnect, so the dashboard reports per-pair pending status rather than instantaneous global removal.

## Updates and recovery

Kiosk unpairing is a loopback-only, same-origin, PIN-authorized and explicitly confirmed local operation. It drains in-flight installation work and blocks when attendance is pending. A durable owner-only journal archives installation-bound files before the service restarts, preventing cached credentials, roster, mappings, queue history and fingerprint trust from carrying into a new pairing. Interrupted archival blocks scanning and pairing until locally authorized recovery finishes; malformed or unsafe filesystem state fails closed. The local PIN and NetworkManager connections are retained, and no reader template is erased. This is not remote credential revocation: retire the old dashboard device separately and protect the archive as credential-bearing biometric-related material.

Web updates require current Administrator authorization, an exact dashboard origin, a pinned official release allowed by the server-owned track, an entire-installation backup, and a durable request. Stable is the default; Beta requires explicit audited consent. The browser cannot choose deployment resources, tags or commits. Refreshing status never redispatches. Recovery retains a deployment lock until explicit review confirms the next action and API/Pages health.

Tracks never install or downgrade software. Started web updates and recent pending kiosk updates lock the track. Beta preparation requires the reviewed private controller; a kiosk needs its installed channel-aware root helper. Execution independently checks release flags, complete assets, exact tag/commit and immutable beta metadata. See [UPDATE-TRACKS.md](UPDATE-TRACKS.md).

Physical kiosk updates are separate from web updates. Do not treat a simulator or dashboard state as proof of a physical update. The completed 1.0.2 kiosk update was run with the terminal updater through Raspberry Pi Connect remote shell; dashboard kiosk release lookup acceptance remains unproven. See [KIOSK.md](KIOSK.md) and [WEB-UPDATES.md](WEB-UPDATES.md).

## Report a concern

For a responsible security or privacy concern, contact robolancers@gmail.com without sending credentials, attendance records, fingerprints, or backup contents.
