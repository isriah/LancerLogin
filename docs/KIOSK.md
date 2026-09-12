# Physical kiosk

Supported hardware: Raspberry Pi 3B+, 4, or 5 with at least 1 GB RAM; Waveshare 7-inch DSI LCD (E); R503 fingerprint reader; Wi-Fi or Ethernet. Fingerprint templates remain exclusively inside the R503.

The dashboard's Kiosks page keeps physical heartbeat, reader, network, queue, sync, and release health together. When Discord is enabled and verified, the same physical-health card lets an Admin or Operator manually refresh the persistent kiosk-status message; automatic heartbeat and five-minute reconciliation remain best-effort and never block kiosk operation.

## Install or upgrade the Pi

The Kiosks page links the guided installer from the latest immutable GitHub release. Run it with `--dry-run` to preview or `--install` with `sudo` to proceed. It requires Raspberry Pi OS, Node.js 18 or newer at `/usr/bin/node`, NetworkManager, and an enabled UART exposed as `/dev/serial0`.

The installer verifies the Pi model, memory, CPU architecture, artifact checksum, serial prerequisites, and local service health. It uses a dedicated `lancerlogin` account, installs code under `/opt/lancerlogin`, keeps owner-only state under `/var/lib/lancerlogin`, configures the serial port before every systemd start, and opens local Chromium in kiosk mode at desktop login. When Chromium is installed, it also adds a **LancerLogin Kiosk** desktop shortcut for reopening the local attendance screen full-screen if the Pi is sitting at the desktop. An upgrade retains pairing, branding, pending events, slot mappings, and the local settings PIN.

LancerLogin never takes port 8788 from another program. If a pre-community or other kiosk service still uses the port, the installer prints the owning process and exits. Stop or uninstall that service intentionally, then rerun the installer. On a failed health check it prints the current systemd status and recent journal entries.

## Pair without typing deployment details on the Pi

A fresh install starts an unpaired local page and prints both `http://<hostname>.local:8788/` and the Pi's LAN IP fallback. On a phone or laptop connected to the same network:

1. Open dashboard **Kiosks** and choose **Add kiosk**.
2. Name the device and create the ten-minute one-time pairing key.
3. Open the Pi address printed by the installer.
4. Paste the single combined key and choose **Pair kiosk**.
5. Return to Kiosks and refresh status.

The combined key contains public routing information, the chosen kiosk name, and a single-use code. The Pi sends it directly to the adopter-owned Worker, clears the field, discards the combined key, and stores only the returned kiosk credential with owner-only permissions. D1 stores only hashes of the pairing code and device credential.

LAN clients can reach setup assets, safe health state, and first pairing. Attendance, reader, network, fingerprint, mapping, and maintenance controls require a request from the Pi itself. Once paired, the pairing endpoint refuses another key.

LancerLogin currently permits one active physical kiosk. Creating a replacement key requires explicit Admin confirmation; the current kiosk keeps working until the replacement redeems it. Successful replacement disables the old credential and retains the old device in Kiosks history.

## Everyday scanning

The local service continuously polls the R503. A member places an enrolled finger on the reader; there is no meeting selector, roster entry, or administrator control on the normal screen. The Pi queues a non-biometric event locally, and the Worker selects the one eligible meeting from the scan timestamp. Meeting attendance windows cannot overlap, including the shared late-scan allowance.

The first accepted scan welcomes the member and records arrival. The second says goodbye and records departure. The screen and R503 aura light provide ready, processing, welcome, goodbye, unknown-finger, rejected, reader-offline, and cloud-offline feedback. An eight-second device debounce prevents one held finger from producing both scans.

Organization name, subtitle, logo, logo contrast treatment, and colors are cached locally. A transparent logo uses the configured adaptive backdrop. If cloud delivery fails, the atomic local queue retains events in order and retries; expected attendance rejections are shown and removed so they do not block later scans. When the reader is online, the footer shows the running LancerLogin release (or a development fallback); a reader failure replaces it with the offline warning. Queue count and uptime remain beside it.

Offline queued scans keep **Welcome** or **Goodbye** as the headline, with exactly **Saved for sync | Welcome** or **Saved for sync | Goodbye** beneath it. This is a display estimate, not confirmation: the Worker still resolves attendance from the original timestamp, and queued events contain no inferred direction. Each member's currently pending sequence starts with Welcome and alternates; all fingers mapped to that member share the sequence. Other members, unknown fingers and debounced scans do not advance it. A failed local save shows a rejection instead of claiming the scan was saved.

No extra direction history, member labels or biometric data are persisted. After a service restart, the existing durable queue supplies the pending sequence. Confirmed, duplicate and rejected events stop contributing when replay removes them; subsequent scans recalculate from the remaining queue, including after partial replay or background sync. When a member has no pending events, the next offline sequence starts at Welcome regardless of earlier confirmed attendance. This conservative reset can differ from the final Worker outcome. Reconnection never changes an already displayed estimate into cloud confirmation; directly acknowledged scans keep the normal authoritative feedback. Outside a scan, the network indicator continues to show connection/cloud availability.

## Touch Wi-Fi settings

Press and hold the network dot for three seconds. If the Pi is offline, the network page opens automatically. On first use, create a 6–12 digit local settings PIN; later visits require that PIN and five failed attempts lock entry for 30 seconds. An authorized session lasts five minutes.

The page shows NetworkManager connection state and visible Wi-Fi networks, including signal and lock indicators. Select a network and use the on-screen keyboard. The password is passed to NetworkManager for connection and is never saved or displayed by LancerLogin. Ethernet continues to work without configuration.

Captive-portal automation is unsupported. Complete a portal outside LancerLogin or use Ethernet/offline-first scanning until normal connectivity is available.

## Fingerprint maintenance

Press and hold the organization logo or name for three seconds, then enter the same local settings PIN. There is no visible fingerprint shortcut on the attendance screen. Before unlock, the maintenance page shows PIN entry and a return-to-kiosk link. Maintenance is deliberately available only on the physical kiosk.

The page can test the reader, load active roster labels through the paired Worker, suggest the next open slot, and guide enrollment. Choose a member from the touch-friendly roster picker, choose a fixed finger label, and enter a slot from 0–199 with the on-screen number pad. Search the roster with the in-app QWERTY keyboard (including digits, hyphen, apostrophe and period). Use **Hide keyboard** to give the complete roster the full list width; **Show keyboard** or tapping search brings the keyboard back. Swipe from user rows or blank space inside the list to reach every member; a swipe never selects a member, while a tap does. Finger choices also use an in-page touch picker. Swipe inside cards, mapping tables and picker sheets to reach overflowing content at 800×480, 1024×600 and short 800×360 landscape sizes; no OS keyboard or scrollbar dragging is required. Slot edits are applied only with **Use slot**, and closing the keypad retains the previous slot.

Confirm or cancel the enrollment summary before reader listening begins; occupied-slot replacement still requires the explicit replacement checkbox and confirmation. Mapping removal has an in-page confirmation and retains the sensor template. Return to kiosk closes the local PIN session; expiration hides the workspace, open pickers and search keyboard, then requires unlock again. Cancellation at the summary starts no sensor operation; after confirmation the existing two-scan sensor operation runs to success or reader failure.

The member presents the same finger twice; the R503 creates and stores the template internally. Replacing an occupied slot requires explicit confirmation. Reader errors are shown as plain recovery guidance rather than protocol codes.

The owner-only local mapping records only the sensor slot, roster member ID, and finger label. Removing a mapping does not delete the sensor template. LancerLogin never reads, serializes, logs, syncs, backs up, or stores a fingerprint template outside the R503.

## File-based roster and slot-mapping import

If an older kiosk used the same physical R503 sensor, its stored fingerprint templates can stay in place. Export the old roster to CSV and the old slot mapping to JSON, then run:

```bash
node apps/kiosk/scripts/prepare-legacy-fingerprint-import.mjs --roster old-roster.csv --mappings old-mappings.json --out-dir ./legacy-import
```

The helper writes `lancerlogin-roster-import.csv` for the dashboard roster importer, `slot-mappings.json` for the Pi's local mapping store, and `import-report.json` listing mappings whose member IDs were not found in the roster export. Review that report before copying mappings onto a Pi. The helper reads exported files only; it does not connect to an older deployment, modify Cloudflare resources, or extract biometric templates.

## Dashboard management and recovery

Operators can monitor the active kiosk's online state, reader state, pending scan count, last successful sync, installed release, heartbeat, pairing time, and scrubbed issue category. Admins can also add/replace, rename, retire, view history, and queue fixed recovery actions:

- **Reload display** asks the local browser page to reload.
- **Restart software** restarts the sandboxed systemd service.
- **Reboot Pi** requests a device reboot after explicit confirmation.
- **Reset network PIN** removes only the local salted PIN record after explicit confirmation; the next local visit creates a new one.
- **Update to latest stable** starts a fixed, root-owned update unit. It resolves the official latest release once, accepts strict stable `vMAJOR.MINOR.PATCH` versions across majors, rejects draft/prerelease releases and missing installer/archive/checksum assets, verifies the installer checksum and kiosk archive checksum, then restarts the kiosk service. It does not accept an administrator-provided URL, tag, shell command, or argument.

The paired kiosk polls for these commands every five seconds. Commands expire from polling after 15 minutes. The API accepts no shell text or arbitrary arguments, and the service account receives only narrow NetworkManager, reboot, and one-unit update permissions. The first kiosk update must use a release that includes this updater; install that release once through the existing guided installer, then future Latest stable updates can be queued from **Kiosks** or **Settings → Updates**.

### v0 to v1 bridge and exact-v0.24.0 recovery

Install v0.24.0 while it is still the official latest release, then verify the actual `/usr/local/sbin/lancerlogin-install-release` helper before V1.0.0 becomes latest. Updating packaged source alone does not update a Pi. Earlier helpers reject v1; if the bridge was missed, an authorized operator must bootstrap the exact official v0.24.0 installer through the Pi terminal. This is a manual recovery action, not a new dashboard argument or helper override. Do not run it until v0.24.0 and its verified assets are published and the installation update is explicitly authorized.

Before either path, preserve a private recovery copy of `/var/lib/lancerlogin`, `/opt/lancerlogin`, the kiosk/update units, version drop-in and installed helper on operator-controlled storage outside source control. The state directory contains pairing credentials, mappings, PIN state and pending attendance: never paste, log, commit or share its contents. Pause scans and stop the kiosk for a consistent local checkpoint; coordinate the downtime so no attendance is lost. Retain the installation's web backup and Worker encryption/session secrets through secure provider interfaces. Do not delete local state, re-pair, recreate resources or restore D1 automatically.

After taking the checkpoint, run this fixed bootstrap in a new Bash subshell on the Pi (not as an unattended remote command):

```bash
(
  set -euo pipefail
  temporary="$(mktemp -d)"
  trap 'rm -rf -- "$temporary"' EXIT
  readonly release_root="https://github.com/isriah/LancerLogin/releases/download/v0.24.0"
  curl --fail --location --proto '=https' --tlsv1.2 "$release_root/install-lancerlogin.sh" --output "$temporary/install-lancerlogin.sh"
  curl --fail --location --proto '=https' --tlsv1.2 "$release_root/install-lancerlogin.sh.sha256" --output "$temporary/install-lancerlogin.sh.sha256"
  (cd "$temporary" && sha256sum --check install-lancerlogin.sh.sha256)
  sudo env LANCERLOGIN_VERSION=0.24.0 /usr/bin/bash "$temporary/install-lancerlogin.sh" --install
)
```

The installer verifies the exact-v0.24.0 architecture archive checksum and preserves `/var/lib/lancerlogin`. Confirm installed helper replacement without printing credentials:

```bash
sudo cmp --silent /opt/lancerlogin/scripts/lancerlogin-install-release.sh /usr/local/sbin/lancerlogin-install-release
sudo stat -c '%U:%G:%a' /usr/local/sbin/lancerlogin-install-release
sudo systemctl is-active lancerlogin-kiosk.service
sudo systemctl cat lancerlogin-update.service
curl --fail --silent --show-error http://127.0.0.1:8788/display-state | /usr/bin/node -e 'let data="";process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>{if(JSON.parse(data).releaseVersion!=="0.24.0")process.exit(1);console.log("Installed release: 0.24.0");});'
```

Require `cmp` success, `root:root:755`, an active kiosk, and an update unit whose `ExecStart` is exactly `/usr/local/sbin/lancerlogin-install-release` with no arguments. The verified packaged helper must include the stable-major validator. Confirm retained pairing, mappings and pending queue by their operational status, then normal/offline scanning and controlled queue replay, reader/enrollment, restart and reboot recovery. Record operator evidence separately from mocked/Linux tests. Only then authorize and exercise the app-driven V1 update, requiring the reported installed version rather than command acceptance alone.

If a checksum, helper verification or health check fails, stop the transition and retain the checkpoint. The update helper attempts to restart a previously active kiosk after failure; it does not restore previous code bytes. Have an authorized operator inspect scrubbed service status and choose exact-release reinstall or checkpoint code/unit recovery compatible with the current installation. Preserve current pending state; restoring an older queue can duplicate or discard events. Never restore D1 or pairing/encryption material as an automatic rollback.

## Browser simulator boundary

The existing guided-setup simulator is Admin-only and credential-separated. It can submit simulated attendance to an Admin-selected active meeting without claiming fingerprint, UART, Pi, Chromium, or physical queue acceptance.

The expanded 1:1 browser simulator is deferred. When implemented, it must render the same kiosk screen and reuse the same state transitions and attendance behavior, replacing only R503 input with a browser member-event adapter and marking resulting events as simulated.
