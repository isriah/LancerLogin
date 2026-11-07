# Kiosk reference

This is the technical reference for the Raspberry Pi kiosk. Step-by-step instructions are on the documentation site: [Set up and run kiosks](https://isriah.github.io/LancerLogin/kiosk.html) covers hardware, the printed enclosure, [R503 wiring](https://isriah.github.io/LancerLogin/kiosk.html#wiring), installation, pairing and daily use, and [Troubleshoot](https://isriah.github.io/LancerLogin/troubleshooting.html#kiosk) covers common problems.

Supported hardware is a Raspberry Pi 3B+, 4, or 5 with at least 1 GB RAM, a Waveshare 7-inch DSI LCD (E), and Wi-Fi or Ethernet. An installation can pair any number of uniquely named kiosks, and each kiosk has its own authentication method: fingerprint (R503 reader), RFID badge, NFC badge, QR code (keyboard-wedge readers), or member ID entry (touch screen or keyboard).

## Installer

The **Add kiosk** dialog gives an installer command pinned to the installation's release. `install-lancerlogin.sh --dry-run` previews and `--install` proceeds; both run with `sudo`. It requires Raspberry Pi OS with desktop, Node.js 18 or newer at `/usr/bin/node`, and NetworkManager. Fingerprint mode also requires an enabled UART exposed as `/dev/serial0`.

Without an R503, add `--no-fingerprint-reader` as the second argument. The installer records the disabled sensor in a systemd drop-in and skips serial setup, and later upgrades keep that choice. `--fingerprint-reader` enables an R503 again. Installations without either choice default to `/dev/serial0` and fingerprint authentication. `LANCERLOGIN_SENSOR_PATH` remains available for a different `/dev` path.

The installer verifies the Pi model, memory, CPU architecture, artifact digest, serial prerequisite and service health. It uses a dedicated `lancerlogin` account, installs code under `/opt/lancerlogin`, keeps owner-only state under `/var/lib/lancerlogin`, configures the serial port before every systemd start, and opens Chromium in kiosk mode at desktop login. When Chromium is installed it adds a **LancerLogin Kiosk** desktop shortcut. An upgrade keeps pairing, branding, pending events, authentication mappings, the active-roster cache and the local settings PIN. The installer never takes port 8788 from another program; if another service holds it, the installer names the process and exits.

### Release directories and automatic rollback

Each release is installed into its own directory under `/opt/lancerlogin/releases/`. `/opt/lancerlogin/current` links to the active release and `/opt/lancerlogin/previous` to the last healthy one; `/opt/lancerlogin/src` stays a stable link to `current/src`. The installer extracts and checks the new release (syntax, and an import as an unprivileged account with isolated state) while the running release keeps serving scans. Only then does it stop the service, switch `current` with an atomic rename, install the release's systemd units, update the helper and polkit rules, and wait up to about 90 seconds for a stable `/health` response.

If the new release does not become healthy, the installer switches `current` back, restores the previous units, helper, polkit rules and `lancerlogin-kiosk.service.d` drop-ins (including `10-version.conf`), restarts the previous release, removes the failed release directory and exits with an error. After a healthy install it keeps only the active and previous releases. Pairing, mappings, the offline queue and other state under `/var/lib/lancerlogin` are never part of a release directory and are not touched by a switch or rollback.

The first update from an older in-place install moves the existing code into `releases/legacy_<version>` and uses it as the rollback target. The installer refuses to continue when `/opt/lancerlogin` holds unexpected files or links. A power loss during the switch leaves either the old or the new release active, never a mix; automatic rollback applies only while the installer is running.

### Attendance screen and browser profile

The service runs as `lancerlogin-kiosk.service`; the browser opens at desktop login through `/etc/xdg/autostart/lancerlogin-kiosk.desktop`. A headless boot starts no browser. From the desktop account, open **LancerLogin Kiosk** or run `/usr/local/bin/lancerlogin-open-kiosk` without `sudo`. A short service restart preserves live page sessions; after a crash or an expired session, use **Retry attendance**.

If the screen does not open, check `systemctl status lancerlogin-kiosk.service --no-pager`, `journalctl -u lancerlogin-kiosk.service -n 30 --no-pager` and `http://127.0.0.1:8788/health` on the Pi before troubleshooting Chromium. A healthy service does not prove that queued scans have reached the dashboard.

Changing the Pi's hostname changes its `.local` address, not its pairing or dashboard name. Chromium can then refuse its old profile as in use. The kiosk uses only the desktop account's `~/.local/share/lancerlogin/chromium` profile: close the kiosk browser, confirm no Chromium process uses that profile, move it to a private backup folder beside it, and reopen **LancerLogin Kiosk** to create a fresh one. This preserves the service-owned pairing, mappings, queue and PIN.

## Pairing

A fresh install starts an unpaired local page at `http://<hostname>.local:8788/` and prints a LAN IP fallback. The dashboard's one-time pairing key, valid for ten minutes, combines the installation's API address, the chosen kiosk name and a single-use code. The Pi sends it directly to the installation's Worker, discards it, and stores only the returned kiosk credential with owner-only permissions. D1 stores only hashes of the pairing code and the kiosk credential.

LAN clients can reach setup assets, minimal health state (`ok`, `paired` and setup state only), and first pairing with the six-digit setup code shown on the kiosk's own screen. Pairing on the kiosk itself needs no setup code. Five wrong codes replace the code and pause LAN pairing for a minute. Attendance, identity input, network, mapping and maintenance controls require a request from the Pi itself, addressed by its own name or address. Once paired, the pairing endpoint refuses another key.

Every pairing gives the kiosk a pairing identity. New scans capture it when they enter the local queue, so a scan queued by one kiosk can never attach to another kiosk's pairing; the Worker rejects it and the originating kiosk keeps it in **Review rejected scans**. Pairing another device leaves existing kiosks unchanged. Retiring a kiosk revokes only its credential. A portable entire-installation restore invalidates every kiosk credential, so each kiosk must be paired again.

### Unpair and move to another installation

**Authentication maintenance > Unpair kiosk** refuses to continue while attendance scans are pending, enrollment is active, or a restart or update is underway. It archives the old pairing credential, attendance history, roster cache, authentication mappings and fingerprint sharing state under `/var/lib/lancerlogin/reassociation/<archive-id>/`, keeps Wi-Fi connections and the local settings PIN, and never erases reader templates. The service restarts at the pairing screen.

Unpairing is local, not server-side retirement: retire the old device in the original dashboard once the new pairing works. Archives are deleted when the kiosk is paired again and 30 days after unpairing (checked only while the kiosk clock is confirmed). Deletion removes files but cannot guarantee that flash blocks are physically erased; wipe the card when a device leaves the organization. An interrupted archive blocks scanning and pairing until **Unpair kiosk** is chosen again to finish it. A damaged journal, unsafe permissions or symbolic links require an owner-reviewed recovery.

## Authentication methods

An Administrator selects a kiosk on **Kiosks**, opens **Manage kiosk > Identification**, and saves its method. With **Member ID entry**, the kiosk can also use **Member search** instead: members search the roster by name, member ID or the start of their email, see only names and member IDs, and confirm before anything is recorded. Without a PIN, anyone can sign in someone else with either one; use a fingerprint kiosk where that matters. Existing kiosks keep their effective configured method during an upgrade; new pairings start with fingerprint. Each device receives only its own configured method on its normal sync, and the dashboard separately shows the method the kiosk last reported. When they differ, the change is pending.

RFID, NFC and QR support expects a keyboard-wedge reader that submits one complete token followed by Enter. LancerLogin adds no camera, vendor SDK or device driver for these methods. Validate reader models, key layouts, prefixes, suffixes and USB behavior on the installation's own hardware.

For RFID, NFC or QR, **Authentication maintenance** links a credential to an active roster member. The kiosk transforms the value with HMAC-SHA256 and an owner-only kiosk secret and keeps only the keyed digest, the member mapping, the method and an optional label. The raw value is cleared after success, failure, lock or reload. The digest and secret are on the same Pi, so this prevents routine disclosure and cloud propagation but not an attacker with owner-level access to the Pi. Member ID entry needs no mapping.

A Raspberry Pi kiosk with **Member ID entry** works like a web kiosk, so it can run without its fingerprint reader. It shows a large keypad when every member ID is a number, otherwise the on-screen keyboard, then **Is this you?** with the member's name and ID: **Confirm** records the visit, **Not me** (or **Back to search**) goes back, and the step returns to the start after 15 seconds. It can use **Member search** too, and **Require PIN** on **Manage kiosk** adds the PIN step after **Confirm**, with setup approved by an Operator on the dashboard or set from **Authentication maintenance** (**Set member PIN** and **Reset member PIN**, which need the network). It checks PINs as described under PINs in [Web kiosks](#web-kiosks). Offline, the Pi checks a PIN against the hash cached in its owner-only roster cache, counts wrong tries in its state folder and reports them when it reconnects. It keeps the hashes only while **Require PIN** is on, and removes them when it is turned off or the kiosk is unpaired. In these modes an unplugged fingerprint reader doesn't stop attendance or show **Reader offline**.

Member ID entry and stored credential mappings are checked against the owner-only active-roster cache. A deactivated or unknown member fails closed locally, even when an older badge mapping remains. After one roster sync, the cache supports offline identity resolution.

## Scanning, queue and clock

The kiosk resolves each input to an active member locally, then applies the shared debounce, pairing capture, offline queue, retry and rejection handling. The Worker selects the one eligible meeting from the original timestamp; meeting attendance windows cannot overlap. An eight-second member debounce prevents one held finger or duplicate wedge read from producing two scans. The footer shows the kiosk name, release, reader status, queue count and uptime.

Each saved scan is one fsynced append to an owner-only journal, folded back into the queue files periodically and on an orderly stop. Only a recognized Worker rejection (for example an inactive member, no eligible meeting, attendance already complete or a pairing mismatch) is final. Any other client error keeps the scan queued and retries with backoff of up to 15 minutes. Rejections move to an owner-only local review record. Offline scans show **Saved for sync** under **Welcome** or **Goodbye**; that direction is a display estimate, and the Worker decides the outcome from the timestamp.

If the kiosk starts without a verified clock, attendance pauses and **Open maintenance** lets an operator confirm the date and time with the local PIN. The kiosk stores a protected time reference bound to the Linux boot identity; network time establishes it automatically. Scans from a boot without a time reference move to local review instead of receiving a guessed date. Do not downgrade to kiosk code that ignores clock evidence while unverified scans are queued.

**Review rejected scans** in maintenance shows each rejected scan's time, member ID, event ID and safe reason. **Mark reviewed** never changes attendance. Compatible kiosks also send retained rejection records to the dashboard's **Rejected scans** list during their heartbeat; the record contains no template or raw credential. Once the dashboard has acknowledged a record, the kiosk removes it locally after 30 days, or earlier beyond 1,000 acknowledged records. Unacknowledged records are never removed. Local `/health` reports saved, pending, accepted, duplicate, rejected, needs-review and clock-pending counts.

## Local tools

The protected tools are available only on the kiosk's own screen. Holding the network dot for three seconds opens Wi-Fi settings; holding the organization name or logo opens **Authentication maintenance**. Both use the same 6 to 12 digit local settings PIN. Five wrong PINs lock entry for 30 seconds, doubling with each further lockout up to one hour; the counter survives a service restart. An unlocked session lasts five minutes. Wi-Fi passwords are passed to NetworkManager and never saved or displayed by LancerLogin. Captive portals are not handled automatically.

Attendance capture pauses while maintenance is open; queued scans keep syncing. **Exit to desktop** closes only the dedicated kiosk browser, while the service and queue delivery continue.

### Fingerprint enrollment

An Administrator can start enrollment for one member from a fingerprint kiosk's **Manage kiosk** page. The kiosk asks the member to confirm their name before listening. The session lasts at most five minutes, permits enrollment only, uses a verified free reader slot, and cannot replace an occupied slot. Local PIN-protected maintenance also supports enrollment, with explicitly confirmed replacement of an occupied slot.

Enrollment requires a successful current online roster check with a verified member identity. The member presents the same finger twice; the R503 creates and stores the template. Slot suggestions check the reader's occupied slots as well as local mappings, and enrollment checks occupancy again before capture. The owner-only mapping records the slot, roster member ID, enrollment identifier and immutable roster identity. Removing a mapping does not delete the reader template; **Erase unlinked fingerprints** in the dashboard removes templates that no member is linked to.

### Fingerprint cloud storage on kiosks

When an Admin turns on **Fingerprint cloud storage**, kiosks upload identity-verified enrollments and download verified active-member templates into free slots automatically. The privacy and retention boundary is in [privacy](PRIVACY.md#optional-fingerprint-cloud-storage) and the cryptography in [security](SECURITY.md#optional-server-managed-fingerprint-storage). Kiosk behavior:

- Uploads use a stable source enrollment identity, so a restart or lost response does not create another copy.
- Kiosks refresh the full enrollment catalog on startup or when its revision changes, then request missing templates in batches of up to eight. Each import is byte-verified before it completes.
- Existing occupied slots, completed imports and deliberate local removals are never overwritten. Slot numbers may differ between kiosks.
- Removing a mapping on one kiosk suppresses automatic restoration there and keeps the reader template. **Retire everywhere** in the dashboard deletes one cloud enrollment and tells compatible kiosks to remove matching mappings when they next sync.
- A mappings reset from **Settings > Modules > Attendance > Fingerprint recovery** clears fingerprint mappings on each paired kiosk as it reconnects and acknowledges. Reader templates, pairing, queues, the PIN and badge or QR mappings are unchanged.

Fingerprint state uses owner-only lock directories with Linux kernel locks (`/usr/bin/flock`). Their presence on disk is normal. Do not delete locks, edit journals, reset identity files or overwrite unknown slots to clear a diagnostic warning; preserve state and use a reviewed recovery.

## Dashboard management and recovery

Operators can open **Manage kiosk > Diagnostics** for any active kiosk. Admins can also change its authentication method, rename or retire it, and send one of six fixed commands:

| Command | Effect |
| --- | --- |
| `reload_display` (**Reload display**) | Reloads the local attendance page. |
| `restart_service` (**Restart software**) | Restarts the sandboxed systemd service. |
| `reboot` (**Reboot Pi**) | Reboots the device after confirmation. |
| `reset_network_pin` (**Reset network PIN**) | Removes the local salted PIN record after confirmation. |
| `install_latest` (**Update kiosk**) | Starts the fixed root-owned update unit for a server-pinned release. |
| `erase_unlinked_fingerprints` (**Erase unlinked fingerprints**) | Erases reader templates that no member mapping references, after confirmation. Linked templates are kept. |

The kiosk polls for commands every five seconds; commands expire from polling after 15 minutes. The API accepts no shell text or arbitrary arguments, and the service account receives only narrow NetworkManager, reboot and one-unit update permissions. There is no remote command that erases mappings, the queue or the Pi's other state; before repurposing a kiosk, remove its mappings in **Authentication maintenance** and wipe its card.

## Web kiosks

A web kiosk is any touchscreen laptop or tablet that opens the kiosk page of the dashboard site, `/kiosk`, instead of a Raspberry Pi. Members identify themselves with **Member ID** (a large keypad when every member ID is a number, otherwise an on-screen keyboard) or **Member search**, and confirm their name before anything is recorded.

1. In the dashboard, open **Kiosks**, choose **Add kiosk** and then **Web kiosk**, enter a name, and choose **Create pairing code**. Only Administrators can do this.
2. On the device, scan the QR code, or open the link shown and enter the 8-character code. The code works once and expires after 10 minutes.
3. On the device, choose a 6 to 12 digit settings PIN. Holding the organization name for 3 seconds and entering it opens the kiosk's maintenance menu, which can unpair the device.

The pairing lasts until the device is unpaired or the kiosk is retired on **Kiosks**; retire a lost device to revoke it at once. The device keeps its pairing in the browser's storage, so don't use a private window, and don't clear the site's data. If a kiosk with the same name stopped checking in more than 10 minutes ago, **Add kiosk** offers **Retire and replace**, which keeps its attendance history. A web kiosk takes only **Reload display** and **Reset settings PIN** from **Manage kiosk**.

### Offline

A web kiosk keeps working when the network drops. Each confirmed scan is saved on the device first and then sent; when the server can't be reached, the member sees **Welcome** or **Goodbye** with **Saved for sync**. Saved scans are sent in the order they were taken, one at a time, as soon as the network returns, and again on every heartbeat, waiting longer between failed tries (up to 5 minutes). Each scan keeps its own ID, so one that is sent twice is still recorded once. A scan the server refuses, for example because no meeting was accepting scans, is listed for review on the dashboard as for a Pi kiosk. The footer shows whether the kiosk is online and how many scans are waiting, for example **Offline · 2 waiting**, and the maintenance menu shows both counts. Unpairing a kiosk with scans still waiting loses them, so reconnect it first.

The kiosk keeps its last settings and roster, so it also starts with no network once it has loaded them, and it stamps scans with the server's time rather than the device's: each heartbeat measures how far the device clock is off, and the kiosk keeps that correction offline.

### PINs

Without a PIN, anyone can sign anyone in. Turn on **Require PIN** under **Identification** on **Manage kiosk** (with **Member ID** or **Member search**), and members enter a 4 to 6 digit PIN after **Confirm**. A member without a PIN taps **Ask for approval** and chooses one, typed twice, once an Operator approves: from **PIN requests** on **Manage kiosk**, or at the kiosk with **Set member PIN** in its maintenance menu (opened with its settings PIN). Admins and Operators reset a PIN, or unlock it, from the **Kiosk PIN** card on the member's roster page; **Reset member PIN** in kiosk maintenance resets one too. An Admin can lock a PIN after repeated wrong tries with **Kiosk PIN lockout** on **Settings > Modules > Attendance > Meeting configuration** (off by default). Whether or not lockout is on, PINs checked online are throttled per member: after 5 wrong PINs in a row, the member waits 30 seconds before the next try, then 1 minute, then 5 minutes for each try after that, and the kiosk says when to try again. A correct PIN, or an unlock from the **Kiosk PIN** card, ends the wait. Offline checks aren't throttled. Offline, the kiosk checks the PIN against a hash of it cached on the device, and counts wrong tries there until it syncs. Those cached hashes are kept only while Require PIN is on, and are wiped on unpair, but a hash of a short PIN can be cracked from a stolen device, so retire a lost kiosk on **Kiosks** at once.

### Install the kiosk page as an app

Install the page after pairing, so it runs full screen and the browser keeps its storage. Don't use a private window, and don't clear the site's data: either one forgets the pairing and any scans still waiting.

- **Chrome or Edge on Windows, and Chrome on ChromeOS:** open the browser menu (or the install icon at the end of the address bar) and choose **Install app** (in Edge, **Apps** > **Install this site as an app**).
- **iPad or iPhone:** in Safari, tap **Share** > **Add to Home Screen**, then open the kiosk from the Home Screen. This is required: Safari clears the storage of a page not added to the Home Screen after about 7 days without use, which would unpair the kiosk.
- **Android:** in Chrome, open the menu and choose **Add to Home screen** or **Install app**.

## Update a physical kiosk

A kiosk update changes the Pi software only. It does not back up or deploy the dashboard. The procedure is [Update kiosks](https://isriah.github.io/LancerLogin/updates.html#kiosk-updates); update the dashboard first.

**Update kiosk** starts a fixed, root-owned update unit. The server pins a newer complete official release and exact commit allowed by the installation track. The track-aware helper independently verifies that target, its consent proof and expiry, that the release is immutable, and that the installer and archive match GitHub's recorded asset digests; a `.sha256` file from the same release is not trusted on its own. It accepts no Administrator-provided URL, tag, shell command or argument. The update request is valid for 15 minutes from when the kiosk receives it, measured on the kiosk's own clock, and the server creation time must be within seven days of the kiosk clock. Each command ID is accepted once; the root resolver records consumed IDs in `/var/lib/lancerlogin-update/`. The unit has a 20-minute start limit and download timeouts.

A release that fails verification before the switch is never activated. A release that fails its health check after the switch is rolled back automatically (see [above](#release-directories-and-automatic-rollback)) and the dashboard reports the failure. An operator with access to the Pi can start the no-argument `lancerlogin-update.service`, which installs the official stable release when no server-pinned target exists; Beta always requires a fresh command from the dashboard.

Before any manual recovery, preserve a private copy of the local state directory, which includes pairing credentials, mappings and their transform secret, the roster cache, PIN state, pending attendance and retained scan outcomes. Do not copy it into source control, chat or a support ticket. Do not delete local state, re-pair, recreate resources, restore D1 or restore an old queue automatically: a historical queue can duplicate or discard attendance.

### Development builds

The footer reports the local service version, including any development suffix, and the dashboard receives it through the heartbeat. A recognized development build may be replaced with a verified official release on the selected track at the same or a newer base version, after confirmation. Unknown versions and older base releases remain blocked. The installer archives obsolete development version assignments from systemd drop-ins under `/var/backups/lancerlogin-version-overrides-*`.

## Trying kiosks without a Pi

A web kiosk on any touchscreen laptop or tablet pairs from **Kiosks > Add kiosk > Web kiosk**. With Debug mode on, an Admin can also choose **Open web kiosk on this device** under **Debug tools** on the Kiosks page: it creates a web kiosk code named `Debug kiosk <device id>` after the browser and opens the kiosk page with it in a new tab. A debug kiosk from the same browser that stopped checking in is retired and replaced. Check-ins from a web kiosk are real attendance, so use synthetic test members. A web kiosk does not test a reader, the Pi, Chromium kiosk mode or the Pi's queue.

The browser simulator that earlier releases had is gone (migration `0092_remove_simulator.sql`). Attendance setup's **Verified attendance input** step now completes once a paired kiosk, Pi or web, has checked in. A kiosk can pair and check in while Attendance setup is still running; it takes attendance once setup is finished.

## Testing kiosk changes without a kiosk

Developers can run the real kiosk service on their own computer with a virtual fingerprint reader, network and system, paired to a local preview: `npm run kiosk:virtual`. Every release runs its scenarios in **Verify**. See "Virtual kiosk" in [DEVELOPMENT.md](DEVELOPMENT.md). It doesn't replace testing changes to the reader driver, installer or system services on a real kiosk.

## Legacy fingerprint import

If an older kiosk used the same physical R503, its templates can stay in place. Export the old roster to CSV and the slot mapping to JSON, then run:

```bash
node apps/kiosk/scripts/prepare-legacy-fingerprint-import.mjs --roster old-roster.csv --mappings old-mappings.json --out-dir ./legacy-import
```

The helper writes `lancerlogin-roster-import.csv`, `slot-mappings.json` and `import-report.json` listing mappings whose member IDs were not found. It reads exported files only and does not extract biometric templates. Mappings imported this way lack an immutable identity, so they need re-enrollment before cloud sharing.

For LancerLogin 1 kiosks, see [Upgrade Community to Modular](COMMUNITY-UPGRADE.md). For backups of kiosk state, see [backup and restore](BACKUP-RESTORE.md).
