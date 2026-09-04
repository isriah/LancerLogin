# Physical kiosk

Supported hardware: Raspberry Pi 3B+, 4, or 5 with at least 1 GB RAM; Waveshare 7-inch DSI LCD (E); R503 fingerprint reader; Wi-Fi or Ethernet. Fingerprint templates remain exclusively inside the R503.

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

## Touch Wi-Fi settings

Press and hold the network dot for three seconds. If the Pi is offline, the network page opens automatically. On first use, create a 6–12 digit local settings PIN; later visits require that PIN and five failed attempts lock entry for 30 seconds. An authorized session lasts five minutes.

The page shows NetworkManager connection state and visible Wi-Fi networks, including signal and lock indicators. Select a network and use the on-screen keyboard. The password is passed to NetworkManager for connection and is never saved or displayed by LancerLogin. Ethernet continues to work without configuration.

Captive-portal automation is unsupported. Complete a portal outside LancerLogin or use Ethernet/offline-first scanning until normal connectivity is available.

## Fingerprint maintenance

Press and hold the organization logo or name for three seconds, then enter the same local settings PIN. There is no visible fingerprint shortcut on the attendance screen. Before unlock, the maintenance page shows only PIN entry. Maintenance is deliberately available only on the physical kiosk.

The page can test the reader, load active roster labels through the paired Worker, suggest the next open slot, and guide enrollment. Choose a member from the touch-friendly roster picker, choose a fixed finger label, and enter a slot from 0–199 with the on-screen number pad. The member presents the same finger twice; the R503 creates and stores the template internally. Replacing an occupied slot requires explicit confirmation. Reader errors are shown as plain recovery guidance rather than protocol codes.

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
- **Update to latest stable** starts a fixed, root-owned update unit. It downloads only the official latest `v0.n.n` GitHub release, verifies the installer checksum and kiosk archive checksum, then restarts the kiosk service. It does not accept an administrator-provided URL, tag, shell command, or argument.

The paired kiosk polls for these commands every five seconds. Commands expire from polling after 15 minutes. The API accepts no shell text or arbitrary arguments, and the service account receives only narrow NetworkManager, reboot, and one-unit update permissions. The first kiosk update must use a release that includes this updater; install that release once through the existing guided installer, then future Latest stable updates can be queued from **Kiosks** or **Settings → Updates**.

## Browser simulator boundary

The existing guided-setup simulator is Admin-only and credential-separated. It can submit simulated attendance to an Admin-selected active meeting without claiming fingerprint, UART, Pi, Chromium, or physical queue acceptance.

The expanded 1:1 browser simulator is deferred. When implemented, it must render the same kiosk screen and reuse the same state transitions and attendance behavior, replacing only R503 input with a browser member-event adapter and marking resulting events as simulated.
