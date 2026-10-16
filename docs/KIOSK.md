# Physical kiosk

This guide is for Operators who run attendance and Administrators who pair, monitor, or recover a Raspberry Pi kiosk. Supported hardware is a Raspberry Pi 3B+, 4, or 5 with at least 1 GB RAM, a Waveshare 7-inch DSI LCD (E), and Wi-Fi or Ethernet. Administrators can select fingerprint, RFID badge, NFC badge, member ID, or QR code authentication. Fingerprint mode uses an R503 reader; RFID, NFC, and QR mode accept bounded keyboard-wedge input; member ID mode uses the touch display or an attached keyboard.

The dashboard's Kiosks page keeps each physical device's heartbeat, reader, network, queue, sync, and release health together. When Discord is enabled and verified, the same physical-health card lets an Admin or Operator manually refresh the persistent all-kiosk status message; automatic heartbeat and five-minute reconciliation remain best-effort and never block kiosk operation.

## Assemble the enclosure

The enclosure CAD is available in [Onshape](https://cad.onshape.com/documents/255122503ddb0de539e7c548/w/e84888f58700fc04a13850fb/e/b577b6bf33e1b0cef5140c36). Print one case, one case back, and two screen brackets with no support material.

Before opening the electronics packaging, gather:

- Eight M3 heat-set inserts and eight matching M3 × 6 socket-cap screws.
- A Raspberry Pi 3B+, 4, or 5 and a Waveshare 7-inch DSI LCD (E). Add an R503 reader for fingerprint mode or a compatible keyboard-wedge reader for RFID, NFC, or QR mode.
- The display's own Pi mounting hardware and DSI ribbon cable.

Install all eight heat-set inserts in the case before beginning assembly. Use the temperature appropriate for the printed material, press each insert straight into its pocket until flush, and let the plastic cool before threading a screw. The M3 × 6 screws close the printed enclosure at the insert locations. Use the display's supplied mounting hardware for the Pi-to-display connection unless the display documentation specifies otherwise.

1. Put the display face down on a clean, nonconductive surface. Attach the Raspberry Pi to the display with its mounting screws or standoffs. Do not over-tighten the display board.
2. Connect the DSI ribbon cable between the display and Pi. Fully seat both ends, close their retaining tabs, and check the cable orientation against the marks on the boards.
3. For fingerprint mode, press the included reader nut into the matching pocket in the front case. Thread the R503 reader into that nut from the outside of the case. Tighten it only enough to prevent movement and leave the cable free of twists.
4. Lower the Pi-and-display assembly into the case with the display facing the front opening. Keep the DSI cable inside its intended path and do not trap it under a standoff or case edge.
5. For fingerprint mode, connect the R503 lead to the Pi UART using the pinout below. Confirm the reader's printed pin labels before applying power. Do not rely on wire color alone. Connect a keyboard-wedge reader according to its manufacturer's instructions and verify that it emits the complete credential followed by Enter.
6. Fit the two screen brackets, then secure the display assembly using the prepared M3 × 6 screws. Confirm that the screen sits squarely and that no cable is pinched.
7. Place the case back over the assembly, arrange the remaining cable slack away from screw posts, and fasten it with the remaining M3 × 6 screws. Stop if a screw does not start cleanly in its insert.

### R503 UART pinout

![R503 fingerprint reader to Raspberry Pi UART wiring](../docs-site/assets/r503-uart-pinout.svg)

Power the reader from the Pi's 3.3 V rail. Confirm the reader's printed pin labels and included wiring diagram before connecting power. LancerLogin uses only the UART connection at the /dev/serial0 device; an optional reader touch or wake lead is not connected.

| R503 label | Raspberry Pi physical header pin | Raspberry Pi signal |
| --- | --- | --- |
| VCC | 1 | 3.3 V |
| GND | 6 | Ground |
| TXD | 10 | GPIO 15 / RXD |
| RXD | 8 | GPIO 14 / TXD |

The transmit and receive lines cross: reader TXD goes to Pi RXD, and reader RXD goes to Pi TXD. If the reader label, voltage requirement, or harness differs from this table, stop and use the reader's supplied wiring documentation before powering the kiosk.

## Install or upgrade the Pi

The Kiosks page links the guided installer from the latest immutable GitHub release. Run it with `--dry-run` to preview or `--install` with `sudo` to proceed. It requires Raspberry Pi OS, Node.js 18 or newer at `/usr/bin/node`, and NetworkManager. Fingerprint mode also requires an enabled UART exposed as `/dev/serial0`.

For an installation without an R503, run `install-lancerlogin.sh --install --no-fingerprint-reader`. The preview prints this choice before making changes. The installer records the disabled sensor setting in a systemd drop-in and skips serial setup. Later no-argument upgrades preserve that local choice. Use `--fingerprint-reader` when intentionally enabling an R503 again. Existing and upgraded installations without either explicit choice continue to default to `/dev/serial0` and fingerprint authentication. `LANCERLOGIN_SENSOR_PATH` remains available for an authorized operator who needs a different `/dev` path.

The installer verifies the Pi model, memory, CPU architecture, artifact checksum, selected serial prerequisite, and local service health. It uses a dedicated `lancerlogin` account, installs code under `/opt/lancerlogin`, keeps owner-only state under `/var/lib/lancerlogin`, configures an enabled serial port before every systemd start, and opens local Chromium in kiosk mode at desktop login. When Chromium is installed, it also adds a **LancerLogin Kiosk** desktop shortcut for reopening the local attendance screen full-screen if the Pi is sitting at the desktop. An ordinary upgrade retains pairing, branding, pending events, authentication mappings, the local active-roster cache, and the local settings PIN.

LancerLogin never takes port 8788 from another program. If a pre-community or other kiosk service still uses the port, the installer prints the owning process and exits. Stop or uninstall that service intentionally, then rerun the installer. On a failed health check it prints the current systemd status and recent journal entries.

## Pair without typing deployment details on the Pi

A fresh install starts an unpaired local page and prints both `http://<hostname>.local:8788/` and the Pi's LAN IP fallback. On a phone or laptop connected to the same network:

1. Open dashboard **Kiosks** and choose **Add kiosk**.
2. Name the device and create the ten-minute one-time pairing key.
3. Open the Pi address printed by the installer.
4. Paste the single combined key and choose **Pair kiosk**.
5. Return to Kiosks and refresh status.

The combined key contains public routing information, the chosen kiosk name, and a single-use code. The Pi sends it directly to the adopter-owned Worker, clears the field, discards the combined key, and stores only the returned kiosk credential with owner-only permissions. D1 stores only hashes of the pairing code and device credential.

LAN clients can reach setup assets, safe health state, and first pairing. Attendance, identity input, network, mapping, and maintenance controls require a request from the Pi itself. Once paired, the pairing endpoint refuses another key.

### Unpair and move to another installation

On the kiosk itself, open **Authentication maintenance**, unlock with the local settings PIN, and choose **Unpair kiosk**. The confirmation identifies the current installation. Read the state-retention notice, select its acknowledgement, then confirm. This local control works even when the roster or old installation is unavailable, provided no attendance scans remain pending.

Unpairing stops installation work and refuses to continue while saved attendance scans are pending, enrollment is active, or a restart/update is underway. Reconnect and let pending scans sync first. It archives the old pairing credential, attendance history, roster cache, authentication mappings and fingerprint sharing state in owner-only storage under `/var/lib/lancerlogin/reassociation/<archive-id>/`. Wi-Fi connections and the local settings PIN remain unchanged. It never erases reader fingerprints or automatically restores archived state.

The service restarts and returns to the pairing screen. Create a fresh one-time key in the destination dashboard, then follow the pairing steps above. The new installation starts without the old roster, slot/badge/QR mappings or peer trust. Re-enroll members or use the destination's separately authorized fingerprint storage; an occupied reader slot is not proof of a member's identity. Do not copy archived mappings, credentials, queues or keys into the new pairing.

Unpairing is local, not server-side retirement. Once the replacement pairing is verified, an Administrator should retire the old device entry in the original dashboard. Until retirement, its archived credential is still sensitive and may remain server-valid. Keep the archive private, just like a kiosk backup.

If power or file access interrupts archival, scanning, pairing and installation mutations stay blocked. Unlock maintenance and choose **Unpair kiosk** again to finish that same archive transaction. A damaged journal, unsafe permissions, symbolic links or state paths outside the standard state directory require an owner-reviewed recovery; do not delete the journal or restore old state to bypass the boundary. A custom installation must keep all installation state directly in or beneath its pairing directory and keep the PIN file directly in that directory.

## Choose the authentication method

An Administrator chooses the installation-wide method on dashboard **Kiosks**. Fingerprint remains the default for an existing installation and after an upgrade. The configured method is delivered to every active kiosk on its normal sync. The dashboard separately shows the method most recently reported by the selected kiosk. When those values differ, the change is pending or unconfirmed; stale reader health is not relabeled as proof that the new method is active.

RFID, NFC, and QR support expects a reader that behaves like a keyboard and submits one complete token with Enter. LancerLogin does not add a camera, vendor SDK, or direct device driver for those methods. Reader models, key layouts, prefixes, suffixes, USB behavior, and physical placement must be validated on the installation's hardware. This software acceptance does not claim live RFID, NFC, QR camera, R503, or Pi validation.

LancerLogin permits multiple active physical kiosks. Each active kiosk has a unique device name, credential, pairing identity, heartbeat, command queue, and owner-only local state. Pairing another device leaves all existing kiosk credentials active. Retire only the specific kiosk that should stop working; its history remains visible and every other active kiosk continues normally.

Every new pairing gives that kiosk a pairing identity. New scans capture that identity when they enter the local queue, and replay sends the captured value. A scan queued by one kiosk can never attach to another kiosk's pairing. The Worker rejects it, and the originating kiosk retains it in **Review rejected scans** with a pairing-mismatch explanation. Do not copy a queue between devices or into a newly paired installation.

An existing Community kiosk upgraded in place remains compatible with queue entries created before pairing identities existed. That legacy acceptance applies only to the retained pre-upgrade credential. Retirement, portable dashboard restore, or re-pairing that device ends it. A portable entire-installation restore invalidates every restored kiosk credential and pairing code, so each physical kiosk must be paired again after the restore.

## Everyday scanning

The local service captures one identity using the configured method. A member presents an enrolled finger, badge, NFC credential, or QR code, or explicitly enters a member ID. There is no meeting selector or administrator control on the normal screen. The kiosk resolves the input to an active member locally, then the shared pipeline applies the same debounce, pairing capture, offline queue, retry, and rejection behavior. The Worker selects the one eligible meeting from the original timestamp. Meeting attendance windows cannot overlap, including the shared late-scan allowance.

The first accepted scan welcomes the member and records arrival. The second says goodbye and records departure. The screen provides ready, processing, welcome, goodbye, unknown-identity, rejected, input-unavailable, and cloud-offline feedback. In fingerprint mode, the R503 aura light mirrors the applicable states. An eight-second member debounce prevents one held finger or duplicate wedge read from producing both scans.

Member ID entry and stored credential mappings are checked against the owner-only active-roster cache. A deactivated or unknown member fails closed locally, even when an older badge mapping remains. After the kiosk has completed one roster sync, that cache supports offline identity resolution. Attendance delivery remains in the same durable offline queue for every method.

Organization name, subtitle, logo, logo contrast treatment, and colors are cached locally. A transparent logo uses the configured adaptive backdrop. If cloud delivery fails, the atomic local queue retains events in order and retries. Server rejections move out of the pending list so later valid scans can proceed, but remain in an owner-only local review record with a safe reason code. The footer keeps the dashboard-configured kiosk name, running release, reader status, queue count and uptime on one line. A dashboard rename is retained for an offline restart. Very long names are shortened visually while their full accessible text remains available.

Offline queued scans keep **Welcome** or **Goodbye** as the headline, with exactly **Saved for sync | Welcome** or **Saved for sync | Goodbye** beneath it. This is a display estimate, not confirmation: the Worker still resolves attendance from the original timestamp, and queued events contain no inferred direction. Each member's currently pending sequence starts with Welcome and alternates; all fingers mapped to that member share the sequence. Other members, unknown fingers and debounced scans do not advance it. A failed local save shows a rejection instead of claiming the scan was saved.

If a network replay takes more than one second, the scanner shows the saved-for-sync estimate and resumes reading fingers while delivery continues. A later replay result does not change that earlier screen message. The operator review record captures later server rejections.

No extra direction history, member labels or biometric data are persisted. After a service restart, the existing durable queue supplies the pending sequence. Confirmed, duplicate and rejected events stop contributing when replay removes them; subsequent scans recalculate from the remaining queue, including after partial replay or background sync. When a member has no pending events, the next offline sequence starts at Welcome regardless of earlier confirmed attendance. This conservative reset can differ from the final Worker outcome. Reconnection never changes an already displayed estimate into cloud confirmation; directly acknowledged scans keep the normal authoritative feedback. Outside a scan, the network indicator continues to show connection/cloud availability.

After unlocking the local settings PIN in maintenance, choose **Review rejected scans**. The local page shows the original scan time, roster member ID, event ID, and a safe rejection reason. Check the meeting, roster, and attendance in the dashboard before using its audited correction workflow. **Mark reviewed** only records that the local item was examined; it never creates or changes attendance. An owner-only outcomes file retains the rejected item after review. The pending queue remains in its release 1.0.6 array format. Local `/health` reports saved, pending, accepted, duplicate, and rejected counts since outcome recording began. These are kiosk-observed outcomes: an acknowledgement lost during power interruption can appear as a duplicate on retry even when the Worker had accepted the first attempt. An upgraded queue marks earlier history as incomplete, and running older kiosk code again can leave a gap in these counts. The counts do not include scans that were never saved locally.

## Fingerprint storage locks on Linux

Fingerprint reset, identity, upload and import state uses owner-only persistent
lock directories with Linux kernel locks. The kernel releases ownership when a process
exits, including a forced stop. The `.lock` directories remain on disk normally;
their presence alone does not mean synchronization is blocked. Do not remove them
while the service is running. The kiosk requires `/usr/bin/flock` from util-linux.

Regular lock files left by older versions still require local recovery.
Stop the service, verify no writer remains and validate the protected state before
archiving an abandoned legacy lock. Never reset mappings or discard a pending reset
to bypass a lock error. When downgrading to a version using exclusive-create locks,
stop all writers and archive the lock directories before starting the older code.
State validation, pairing checks and unfinished reset recovery remain mandatory.

## Touch Wi-Fi settings

Press and hold the network dot for three seconds. Small finger movement during the hold is allowed; releasing early or moving too far cancels it. On first use, create a 6–12 digit local settings PIN; later visits require that PIN and five failed attempts lock entry for 30 seconds. An authorized session lasts five minutes.

The page shows NetworkManager connection state and visible Wi-Fi networks, including signal and lock indicators. Select a network and use the on-screen keyboard. The password is passed to NetworkManager for connection and is never saved or displayed by LancerLogin. Ethernet continues to work without configuration.

Captive-portal automation is unsupported. Complete a portal outside LancerLogin or use Ethernet/offline-first scanning until normal connectivity is available.

## Authentication maintenance

Press and hold the organization logo or name for three seconds, then enter the same local settings PIN. There is no visible maintenance shortcut on the attendance screen. Small finger movement during the hold is allowed. Before unlock, the maintenance page shows PIN entry and a return-to-kiosk link. Maintenance is deliberately available only on the physical kiosk.

Attendance capture pauses while maintenance or its network, fingerprint-sync and review tools are open, including while the PIN is locked or expires. Earlier queued scans continue syncing. Use Return to kiosk to resume attendance. If a local page session is lost, reopen or retry the attendance screen; a cloud outage alone does not stop offline capture. In fingerprint mode, lift any finger from the reader before placing it for the next attendance scan.

For RFID, NFC, or QR, choose an active roster member, optionally add a local label, then present or enter the credential. LancerLogin transforms the value with HMAC-SHA256 and an owner-only kiosk secret. Only the keyed digest, member mapping, method, and label remain after submission. The raw value is cleared after both success and failure, and is also cleared when maintenance locks or reloads. The digest and secret are co-located on the kiosk, so this boundary prevents routine disclosure and cloud propagation but does not protect against an attacker who already has owner-level access to the Pi.

The credential list never displays raw values. Mapping removal is local and confirmed in the page. Member ID mode needs no mapping; the maintenance page explains that it uses the active-roster cache. Switching methods does not copy a credential between methods.

### Fingerprint enrollment

Opening authorized fingerprint maintenance automatically tests the reader and displays the result. Use Test to retry a failed check. Hardware testing does not require a successful roster refresh.

Choose a member with the nearly full-screen search view. Its mobile-style keyboard supports letters, digits, spaces and punctuation, with Shift, Backspace and a numbers/symbols toggle. Hide the keyboard to give the roster more space. Swipe the list to reach every member; tapping selects a member while swiping does not. Enter a slot from 0-199 with the number pad. Controls remain reachable on the supported landscape displays.

Enrollment requires a successful current online roster check with a verified member identity. If the connection fails, times out or cannot verify the selected member, retry after restoring connectivity. The failed check does not write a new reader template or remove the previous replacement mapping. Existing offline attendance continues normally.

Review the large centered enrollment summary, then confirm or cancel before reader listening begins. Replacing an occupied slot still requires explicit confirmation. Cancellation starts no sensor operation. After successful enrollment, the member search and selection clear automatically. A failed enrollment keeps the selection for retry. Finger labels are no longer requested or shown in the mapping list; historical mapping labels remain compatible.

Mapping removal retains the sensor template. Return to kiosk closes the local PIN session. Expiration hides the workspace and open pickers, and requires unlock again; it does not resume attendance behind maintenance.

The member presents the same finger twice; the R503 creates and stores the template internally. Lift the finger when prompted after the first capture, then place the same finger again. After enrollment is saved, lift the finger again before returning to attendance. A finger left on the reader must not become an attendance scan. If the reader disconnects after storage, enrollment may already be saved; resolve the reader/removal warning rather than immediately replacing the occupied slot. Slot suggestions check the reader's occupied slots as well as local mappings, so a fresh SD card cannot make existing fingerprints appear available for replacement. Enrollment checks occupancy again before capturing a finger and refuses to proceed if that check fails. Replacing an occupied slot requires explicit confirmation even when its local mapping is missing. Reader errors are shown as plain recovery guidance rather than protocol codes.

The owner-only local mapping records the sensor slot and roster member ID, retaining legacy fields for compatibility. New verified enrollments record an enrollment identifier, time and immutable roster identity for optional sharing. Historical local-only or legacy mappings without this identity require fresh online enrollment before sharing. Review-derived mappings are not fresh enrollments. Removing a mapping does not delete the sensor template. With both sharing options off, templates stay inside the R503. With approved peer sync or cloud storage enabled, eligible templates are read briefly into memory; raw templates are not intentionally written to files or logs.

Badge and QR raw values, keyed digests, and the kiosk secret are never included in Worker requests, D1, logs, fixtures, or portable dashboard backups. Portable restore, Attendance disablement, and kiosk retirement revoke server-side records but cannot remotely erase local mappings or R503 templates. Before repurposing or decommissioning a Pi, open **Authentication maintenance** on that device and remove its local mappings. LancerLogin intentionally provides no remote destructive wipe.

### Return to the desktop

In unlocked maintenance, choose **Exit to desktop** to close the dedicated kiosk browser. The local kiosk service and delivery of queued scans continue running. Attendance capture remains paused until the kiosk attendance screen is reopened. Use the **LancerLogin Kiosk** desktop shortcut to relaunch it.

Exit is available only when the installed dedicated launcher is connected. An ordinary browser window or older launcher may report that desktop exit is unavailable. LancerLogin does not close unrelated browser windows or use a general process-kill command.

### Diagnose fingerprint synchronization

The authenticated fingerprint-sync tools show separate reset, peer-sharing and cloud-storage status, with the latest attempt, historical success and actionable reasons where available. Attendance cloud connectivity alone does not establish that fingerprint sharing is ready.

Disabled sharing, an unavailable reader or roster, rejected cloud authentication, pending reset recovery and protected-state problems need different remedies. Follow the displayed guidance. An earlier successful poll is historical evidence, not confirmation that a later transfer succeeded. A count of enrollments without verified roster identity means those members need fresh online enrollment; it is not permission to infer identities or delete mappings.

Do not delete state locks, rewrite journals, overwrite unknown slots or wipe the reader to clear a diagnostic warning. Differing mapping counts between devices do not prove duplicate fingerprint templates.

### Provision new kiosks from encrypted cloud copies

**Kiosks → Fingerprint cloud storage** is a separate Admin opt-in, off by default. Its server-managed key allows a newly paired R503 kiosk to receive retained verified fingerprints while every other kiosk is offline. Confirm organizational permission for this biometric storage and preserve the separate installation key. The server can decrypt the stored copies; this is not peer-only end-to-end encryption.

1. As an Admin, enable cloud storage and accept its explicit confirmation.
2. Leave a source kiosk online while identity-verified mapped fingerprints upload. Existing mappings without immutable identity require re-enrollment while the kiosk is online. Unknown reader slots are untouched.
3. Pair a new compatible kiosk normally. While online in fingerprint mode, it automatically imports verified active-member templates into safe free slots. Source kiosks do not need to be online after their upload completes. Slot numbers may differ between kiosks.
4. Present a known enrolled finger to confirm recognition and use a valid active meeting when checking attendance. Cloud or browser tests alone do not establish physical reader acceptance.

Polling handles two source captures and an eight-item manifest per pass, so large enrollments take multiple polls. An unavailable server, expired roster check, retired credential, full reader, changed immutable member identity or ambiguous journal stops the affected transfer. Existing attendance queues and reader contents remain intact. Completed metadata prevents a removed local mapping being silently recreated after restart. Do not overwrite unknown occupied slots or re-enroll to bypass a recovery mismatch. Do not edit journals or delete locks to bypass recovery.

Cloud storage retains distinct verified models while the member is active, up to 20 per member and 20,000 per installation. Removing a local mapping or replacing a local enrollment does not retract older cloud templates or copies on other readers. Member deactivation or ID change removes their live cloud templates. Disabling cloud storage, disabling Attendance or restoring the installation removes cloud authority and ciphertext. Source retirement does not erase an otherwise valid member enrollment. No option remotely wipes readers. See [PRIVACY.md](PRIVACY.md) and [BACKUP-RESTORE.md](BACKUP-RESTORE.md).

Legacy identity review has been removed. A roster lookup cannot establish who owns an existing sensor template. Re-enroll the member through PIN-protected Authentication maintenance while the kiosk is online to obtain a fresh immutable identity. Retired review grants and imported descendants cannot become fresh upload sources. Updating software does not automatically reset mappings or erase the reader.

A mappings-only reset clears cloud copies and fingerprint mappings on each currently paired kiosk as it reconnects. Offline kiosks remain pending until they durably clear mappings and acknowledge the command. Local enrollment and mapping edits pause during an interrupted reset, and a lost server acknowledgement retries without clearing a later enrollment. Pairing, attendance queues, local settings PIN and alternative credential mappings remain unchanged. Previous sharing keys and journals remain in a non-active reset namespace, so re-enabling sharing needs fresh local enablement and peer approvals.

This reset does not erase reader templates or free reader slots. Existing enrolled fingers may trigger the reader's duplicate-fingerprint check. Use an available slot for a genuinely new finger, or the existing explicitly confirmed occupied-slot replacement workflow when replacing a known enrollment. Do not overwrite unknown slots, edit private proof state or remove recovery locks to bypass a pending reset. Removing a local mapping retains its reader bytes and is not template erasure. Physical reader acceptance and duplicate handling still require device testing.

### Share new fingerprints between kiosks

Fingerprint sync is optional and off by default. It works between compatible R503 kiosks paired to the same installation, including kiosks on different Wi-Fi or Ethernet networks. Both need outbound access to the installation service; no port forwarding is required. Obtain the organization's permission to share biometric templates before enabling it.

1. As an Admin, open dashboard **Kiosks → Fingerprint sync** and enable installation sync.
2. On each participating kiosk, unlock **Authentication maintenance**, choose **Sync**, and choose **Enable on this kiosk**.
3. Refresh the peer list. Compare a peer's complete device fingerprint with **This kiosk device fingerprint** shown on that physical kiosk, using a trusted channel if it is elsewhere. Choose **Compare and approve** only when every group matches. Repeat in the other direction.
4. Enroll the member on one kiosk. Leave both kiosks online while the encrypted transfer completes, then test the same finger on the other kiosk. The destination chooses a free slot; it need not use the source's slot number.

Only recent enrollments created by the local enrollment workflow are eligible, for seven days from enrollment. Existing unidentified reader slots, imported legacy mappings, and received copies are not automatically exported. Enabling sync is not a bulk reader migration. A destination with no safe free slot or conflicting retry state stops that transfer without overwriting another fingerprint.

**Disable on this kiosk** works from retained local state even if the relay is unavailable. It stops local transfers and clears pending local ciphertext; remote registration revocation is best-effort while offline. **Revoke trust** stops locally authorized transfers with that peer. Dashboard disablement removes relay registrations and deliveries. These controls retain private device identities and do not erase templates or mappings already stored on any reader. Removing a source mapping does not retract a copy already queued at the relay or imported elsewhere. Review affected devices individually when removing access.

### Sync recovery boundary

Check network access, the current active roster, installation enablement, local enablement, peer approvals, and reader health when sync needs attention. Normal offline attendance remains separate from template transfer. Do not repeatedly re-enroll or choose occupied slots to work around an unresolved transfer.

Sync stores keys, trust, encrypted outbox messages, and a receiver journal in the owner-only local state directory. A mismatched pairing or installation identity, corrupt file, unsafe permissions, or existing write lock fails closed. A lock may be left by an interrupted process, but its presence alone is not proof that it is stale. Do not automatically delete locks, edit journals, or reset identity files. Stop for authorized recovery: preserve current state securely, verify no writer is running, and reconcile reader occupancy, local mappings, pending attendance, and transfer state before any reviewed repair. Re-pairing or restoring a portable backup does not make old sync state safe to reuse.

See [privacy](PRIVACY.md) for retention and [backup and restore](BACKUP-RESTORE.md) for the distinction between portable dashboard backups and sensitive infrastructure or Pi backups.

## File-based roster and slot-mapping import

If an older kiosk used the same physical R503 sensor, its stored fingerprint templates can stay in place. Export the old roster to CSV and the old slot mapping to JSON, then run:

```bash
node apps/kiosk/scripts/prepare-legacy-fingerprint-import.mjs --roster old-roster.csv --mappings old-mappings.json --out-dir ./legacy-import
```

The helper writes `lancerlogin-roster-import.csv` for the dashboard roster importer, `slot-mappings.json` for the Pi's local mapping store, and `import-report.json` listing mappings whose member IDs were not found in the roster export. Review that report before copying mappings onto a Pi. The helper reads exported files only; it does not connect to an older deployment, modify Cloudflare resources, or extract biometric templates.

## Dashboard management and recovery

Operators can select any active kiosk and monitor its online state, reported authentication method and input state, pending scan count, last successful sync, installed release, heartbeat, pairing time, and scrubbed issue category. Admins can also configure the shared authentication method, add devices, rename or retire one device, view history, and queue device-specific recovery actions:

- **Reload display** asks the local browser page to reload.
- **Restart software** restarts the sandboxed systemd service.
- **Reboot Pi** requests a device reboot after explicit confirmation.
- **Reset network PIN** removes only the local salted PIN record after explicit confirmation; the next local visit creates a new one.
- **Update kiosk** starts a fixed, root-owned update unit. The server pins a newer complete official release and exact commit allowed by the installation track. The channel-aware helper independently verifies that target, consent proof and expiry, immutable beta metadata, and installer/archive checksums before restarting. It accepts no Administrator-provided URL, tag, shell command or argument. An older kiosk must install the stable bridge before Beta.

The paired kiosk polls for these commands every five seconds. Commands expire from polling after 15 minutes. The API accepts no shell text or arbitrary arguments, and the service account receives only narrow NetworkManager, reboot, and one-unit update permissions.

## Update a physical kiosk

The kiosk update is separate from a web update. It changes the Raspberry Pi software only. It does not create a dashboard backup, deploy the web installation, or repair a failed web update.

1. As an Administrator, open **Kiosks** or **Settings → Updates**. Select the intended physical kiosk, confirm it is online, and confirm that a newer compatible release on the selected installation track is shown.
2. Choose **Update to latest on Beta** or **Update to latest stable**, according to the selected track, for that device. It normally receives the fixed command within five seconds, then its update card reports the result and the kiosk returns online with its installed release. Other kiosks continue working independently.
3. If the release lookup is unavailable or the card does not show a successful installed version, do not assume an update was queued or completed. Check the kiosk status and use the approved on-device recovery path instead of repeatedly submitting the command.

Use the Administrator's available access method for an approved on-device recovery procedure. Raspberry Pi Connect remote shell, SSH, and direct local access are all compatible with LancerLogin when the installation permits them. An authorized operator can start the existing no-argument `lancerlogin-update.service` when an operational recovery procedure calls for it. The unit invokes only the installed verified helper, which defaults to the official stable release when no authenticated target proof exists and accepts no user-supplied arguments. Beta requires a fresh server-pinned command; starting the unit manually cannot opt in.

Before manual recovery, preserve a private checkpoint of the local state and retain the installation's web backup through approved secure storage. The local state directory includes pairing credentials, mappings and their local transform secret, active-roster cache, PIN state, pending attendance, and retained scan outcomes. When fingerprint sync has been enabled it also includes private device keys, approved peers, encrypted outbox messages, and receiver slot/retry metadata. Do not copy it into source control, chat, or a support ticket. Do not delete local state, re-pair, recreate resources, restore D1, or restore an old queue automatically. Restoring a historical queue can duplicate or discard attendance.

If checksum, helper, or health verification fails, stop and keep the checkpoint. The updater attempts to restart a kiosk that was active before its failure, but it does not restore earlier code bytes. An authorized operator should inspect scrubbed service status through their available access method and choose a reviewed recovery action that preserves the current queue and pairing state.

### Historical V1 migration context

For the current carry-over checklist and web-first update order, see [Upgrade Community to Modular](COMMUNITY-UPGRADE.md).

v1.2.6 is the required Community update-channel bridge. See [UPDATE-TRACKS.md](UPDATE-TRACKS.md) before opting in to Modular Beta. Update the existing web installation before updating its kiosks in place. Keep each kiosk's existing pairing and protected local state; a multi-kiosk software update does not require re-imaging or clearing the reader. The fingerprint upgrade path now uses re-enrollment while a kiosk is online, rather than legacy member-slot review. An explicit mappings reset is separate from updating software and retains sensor templates. New kiosks still require their own pairing and mappings or explicitly approved fingerprint sync. The earlier v0.24.0 bridge and its exact-release bootstrap were historical migration procedures, not current update instructions. A dashboard release lookup can be unavailable, so treat a missing completion status as unconfirmed and use an approved recovery procedure rather than guessing the cause.

An isolated rehearsal can retain a stale reload card after a manual version change. Simulator, source, and rehearsal results do not establish physical kiosk acceptance for an installation.

## Browser simulator boundary

The existing guided-setup simulator is Admin-only and credential-separated. It can submit simulated attendance to an Admin-selected active meeting without claiming fingerprint, badge, NFC, QR, UART, Pi, Chromium, or physical queue acceptance.

The browser simulator reuses the physical kiosk display styles and state transitions in a scaled 800 by 480 preview, including organization branding, scan feedback and the footer. It omits physical network and maintenance controls. The themed member and meeting selectors replace reader input, and resulting attendance remains marked as simulated.
