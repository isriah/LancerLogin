# Privacy notice

LancerLogin stores organization configuration, roster, meeting, attendance, audit, plugin, and optional integration information in the adopter's Cloudflare account until an Administrator exports or deletes it. The organization operating an installation is responsible for its own retention and access decisions. A plain-language summary is on the documentation site: [Privacy boundaries](https://isriah.github.io/LancerLogin/privacy.html). This page is the detailed reference.

## Kiosk identity and attendance data

Retained rejected scans also synchronize to the kiosk's existing paired installation for Administrator review. This includes member and event IDs, recorded time, rejection reason, optional meeting/pairing references, and clock-verification evidence. It does not include biometric data or raw credentials. The kiosk keeps its original protected records until the dashboard has acknowledged them, then removes them locally after 30 days (or earlier, oldest first, beyond 1,000 acknowledged records); dashboard review adds an audit entry and synchronizes reviewed status back to the device. Recorded device time can be unverified and is not silently converted into attendance.

Fingerprint templates remain in the attached R503 sensor by default. Optional cloud storage changes this boundary as described below. LancerLogin does not capture or upload raw fingerprint images. RFID, NFC, and QR values are transformed by HMAC-SHA256 with a kiosk-local owner-only secret; only the keyed digest and member mapping are retained locally. Raw badge and QR values, local digests, and the transform secret are not sent to the Worker, stored in D1, logged, placed in fixtures, or included in portable dashboard backups.

Member ID entry is checked against an owner-only local active-roster cache. Badge and QR mappings also require the mapped member to remain active. The kiosk sends only the resolved member ID and operational attendance fields through the existing queue. Local queued attendance events are retained until they can be delivered or handled through the documented recovery process.

Server-side retirement or Attendance disablement does not remotely erase local mappings or sensor templates. Authorized staff must use the kiosk's PIN-protected **Authentication maintenance** page to remove local mappings before a device is repurposed or decommissioned.

Unpairing archives the previous installation's local state (credential, roster cache, mappings, attendance history and fingerprint sharing state) in owner-only storage on the kiosk. The kiosk deletes those archives when it is paired again and 30 days after unpairing. Reader templates are not part of the archive and stay on the sensor. File deletion on flash storage does not guarantee physical erasure of the card.

### Web kiosks, member search, member PINs and Discord codes

A web kiosk is a browser page on a laptop or tablet, paired like a Raspberry Pi kiosk. It keeps its kiosk credential, its last settings, the active roster and any scans waiting to be sent in that browser's storage (IndexedDB) on the device. Unpairing removes them; clearing the site's data or retiring the kiosk on **Kiosks** ends the pairing.

Every paired kiosk receives the active roster: each member's roster identity, member ID, first name and last name. A kiosk set to **Member search** also receives each member's email address, because search can match the start of an email; the kiosk never displays it. No other kiosk receives emails. Search results show names and member IDs only, to whoever is standing at the kiosk.

A member PIN is 4 to 6 digits. The server stores only a salted PBKDF2-SHA256 hash, never the PIN, with when and at which kiosk it was set, its wrong tries and any lock. A kiosk with **Require PIN** on, Pi or web, also receives each member's PIN hash, salt and lock state so that it can check PINs while offline; a Pi keeps them in its owner-only roster cache and a web kiosk in the browser's storage. They are sent only while **Require PIN** is on and are removed from the kiosk when it is turned off or the kiosk is unpaired. A hash of a PIN this short can be guessed by someone who copies it from a stolen or compromised device, so treat a member PIN as a deterrent against signing in for a friend, not as a password, and retire a lost kiosk at once. PIN hashes are part of entire-installation backups; see [backup and restore](BACKUP-RESTORE.md). A member's request to set a first PIN (**Ask for approval**) records the member, the kiosk, when it was made and who decided it, and is deleted 30 days after it expires.

A Discord kiosk code (`/code`) is random, works once and expires after two minutes. The server stores only a SHA-256 hash of it with the member it belongs to, and removes used and expired codes. Codes are checked online only: a kiosk never stores one, never queues one and never sends one twice, and codes are not backed up. Discord itself sees that the member ran the command, as for any command.

### Retired peer fingerprint sharing

Cloud storage is the only supported fingerprint synchronization path. Peer enablement, approval, registration and transfer endpoints are retired. Older clients receive disabled peer metadata; transfer requests are rejected. Upgrading does not enable cloud storage automatically or delete reader templates, local mappings, historical keys, encrypted outboxes or import journals. Preserve this protected historical state for recovery. Previously retained relay ciphertext and backups are not erased by this software change; any historical cleanup requires a separately reviewed procedure.

## Optional fingerprint cloud storage

Cloud storage is separately Admin-controlled and off by default. Enabling it authorizes the installation server to store encrypted fingerprint templates and automatically provision currently authorized paired R503 kiosks, including new kiosks while every previous kiosk is offline. Obtain the organization's permission for this biometric storage before enabling it. There is no peer approval step; peer transfer is retired.

The server manages a separate encryption secret and can decrypt these templates. It receives plaintext briefly over authenticated HTTPS and retains only authenticated ciphertext in D1. This is not end-to-end private from the server. The server also sees immutable member associations, source device/pairing, enrollment identity, keyed content digest and timestamps. No template route is available to dashboard browsers. Plaintext is not intentionally persisted in Pi files, D1, logs, fixtures or portable backups, but compromised servers or kiosks and memory dumps can expose it.

New online enrollments and cloud-imported copies carry immutable roster identity in protected local mappings. Backfill reads only occupied slots whose persisted identity matches a fresh active roster. Older or offline mappings without that binding require re-enrollment before sharing; unknown slots are untouched. Legacy review approvals are retired and cannot authorize template uploads or downloads. Automatic receiving checks the same immutable identity and never overwrites an occupied slot. Only a byte-identical same-member copy can be reused.

Cloud templates have no seven-day expiry. A verified template remains associated with its active immutable member until that member is deactivated or their external ID changes, cloud storage is disabled, Attendance is disabled, or the installation is restored. Up to 20 distinct templates per member and 20,000 per installation are accepted; capacity failure does not replace old records. Retiring the source kiosk does not erase valid enrollment data. Removing a mapping or replacing a finger locally does not delete older cloud fingerprints or copies on other readers. Deactivate the member or disable cloud storage when withdrawing the retained cloud authorization, and review every affected reader. This is not remote erasure.

Portable backups exclude vault enablement, identity, ciphertext and keys. Entire-installation restore clears cloud authority and leaves storage off; enabling it again requires renewed consent and valid fresh enrollment identities. Raw infrastructure exports may retain ciphertext after live deletion. Protect the separate key independently, and do not combine data/key backups casually. Owner-only kiosk journals retain slot/member/retry metadata, not plaintext templates. See [backup and restore](BACKUP-RESTORE.md).

## Fingerprint re-enrollment and reset

Members re-enroll through the kiosk's PIN-protected Authentication maintenance page after upgrading. There is no legacy identity-review workflow and no member-ID lookup that can approve an existing fingerprint. Review-derived cloud copies are revoked; independent fresh enrollments remain. A small nonportable denylist retains retired approval identifiers to prevent their reuse as new enrollment authority. Historical infrastructure and protected kiosk backups may still contain retired review metadata; protect it and do not restore it as active authority.

Resetting all fingerprint mappings deletes live cloud copies, disables sharing, and requests removal of fingerprint member-to-slot associations on all currently active paired kiosks. It retains reader templates and unrelated roster, attendance, pairing and authentication data. Offline devices retain their old associations until reconnect and acknowledgement. The dashboard lists this pending state. Reset by itself is not sensor erasure and does not remove copies from historical backups.

After a reset, every template is still stored on each reader. A scan of one no longer identifies a member, and a kiosk uploads only templates that have a current member mapping, so these templates are not sent anywhere. The kiosk's protected local import journal still records the member ID and reader slot of each template that kiosk had saved to or received from cloud storage or the earlier kiosk-to-kiosk sharing.

**Erase unlinked fingerprints** erases a reader template only when no member mapping references its slot and no such journal record still holds the slot. A reset clears the mappings but leaves those journal records in place. Once the kiosk has finished a reset, a record of a template it had completely saved to or received from cloud storage or the earlier sharing no longer holds its slot, so the command erases those templates along with the ones that were never shared. It still skips a template whose import was unfinished or awaiting review when the reset happened, and one recorded under an earlier pairing of the kiosk. A skipped template stays in that reader's own storage. One is overwritten when an operator enrolls a new finger into its slot with **Replace occupied slot** in **Authentication maintenance**.

Removing one mapping in **Authentication maintenance**, or replacing its slot, does release that slot, so **Erase unlinked fingerprints** then erases that template. To erase particular templates, remove their mappings there instead of resetting.

## Dashboard and integrations

To slow password and setup-code guessing, local sign-in, first-Admin setup and kiosk pairing count attempts per client network address. D1 stores only a keyed hash of the route and address, a window start and a count, never the address itself, and the scheduled pass deletes these rows after a day.

### Public Outreach forms

Members can enter a roster ID to submit participation or ask Staff to review an activity. These forms do not authenticate the member; Staff should treat identity as self-asserted. Correction requests do not expose a member's submission history or alter counted hours without an audited Staff decision.

Public member-ID validation defaults to **Off**. An Admin can instead enable **Validate ID only** or **Validate ID and show name** in Outreach settings. Both enabled modes reveal whether an entered ID belongs to an active member; the name mode additionally reveals that member's name. Use either only when appropriate for the audience and the organization's privacy requirements.

Validation uses a bounded, exact server lookup after leaving the ID field. No roster or valid-ID list is downloaded to the public browser. Off returns no validation result, and ID-only responses contain no name. The server rechecks privacy mode and module authority before returning the result. Responses are noncacheable and the form does not save lookup results in browser storage or log member information. Previously disclosed information cannot be withdrawn from someone who already saw or recorded it.

The installation allows up to 60 public ID checks per minute across all visitors. The temporary limiter stores only an installation identifier, minute window, and count, not entered IDs or network addresses. When the limit or network prevents checking, the form does not label the ID invalid; submissions can still be verified normally. Throttling reduces casual enumeration but is not proof against a determined visitor. Disabling live checks does not turn the public submission form into member authentication.

### FIRST team lookup

The optional **FIRST** connection looks up a team's name from its number. LancerLogin sends FIRST the team number, the program and season it is asking about and, for FRC and FTC, the Events API username and token an Admin saved. It sends no roster, member, guest or attendance information. FIRST's answers are cached in D1 (a team for seven days, "no such team" for one day). The token is stored encrypted like other integration credentials.

### Notion

The optional **Notion** connection lets a module read and write the Notion databases an Admin chose for it. LancerLogin sends Notion the integration token an Admin saved and whatever that module writes, for example a part request's fields. What a module sends is described with that module. Core itself sends no roster, member or attendance information. Notion user names can reach a module that reads workspace users or rows that name people. Email addresses reach only a module that declared it needs them: for every other module Core removes them from the users it lists and from every person named in the rows, pages and databases it returns, including who created or last edited a row. The token is stored encrypted like other integration credentials, and logs record only the module, the kind of operation and the result.

The dashboard stores local-password hashes, encrypted optional-integration credentials, roster and attendance records, and audit history. Saved integration values are not displayed in the browser. An entire-installation backup can contain password hashes, member PIN hashes, encrypted integration ciphertext, kiosk credential hashes, and audit history. Protect it like an Administrator credential.

## No usage reporting

LancerLogin sends no usage reporting or analytics to the LancerLogin project or any other party. Attendance, backup, and security data stays within the installation. Database fields left from an earlier, retired reporting feature are unused and kept only so older backups still restore.
