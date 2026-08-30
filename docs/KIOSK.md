# Guided kiosk setup

Supported hardware: Raspberry Pi 3B+, 4, or 5 with at least 1 GB RAM; Waveshare 7-inch DSI LCD (E); R503 fingerprint reader; Wi-Fi or Ethernet.

The public release installer is launched from the dashboard and guides a local operator through OS prerequisites, display/UART checks, sensor test, and kiosk pairing. It downloads a fixed-version GitHub release artifact, verifies its SHA-256 checksum, and does not require a repository checkout or manual source changes. Run it with `--dry-run` first to preview every operation. `--install` requires root because it creates a dedicated `lancerlogin` system account, installs into `/opt/lancerlogin`, writes pairing state under `/var/lib/lancerlogin`, and enables the sandboxed systemd service.

The Pi needs a 32-bit or 64-bit Raspberry Pi OS environment with Node.js 18 or newer available as `/usr/bin/node`. The release publishes separate `armv7` and `arm64` artifact names, though the JavaScript service payload is architecture-neutral. The installer does not configure a captive portal; connect Wi-Fi or Ethernet manually before setup.

The dashboard creates a time-limited, one-time pairing code. The installer sends it directly to the adopter-owned Worker API and then discards it. The returned kiosk bearer credential is stored with owner-only permissions; D1 stores only its SHA-256 hash. Pairing code hashes are likewise the only code representation stored remotely.

Only an Admin can generate a pairing code. Generating a new one supersedes the prior code; expiration and successful redemption both make it unusable. The API exposes code status but never returns a code after the creation response.

LancerLogin deliberately supports one active kiosk. When a kiosk is already paired, the dashboard requires an Admin to explicitly confirm replacement before it will issue another code. The existing kiosk continues working while the code is pending; successful redemption disables its credential before activating the replacement.

The local service listens only on `127.0.0.1:8788`. Its `/health` response reports pairing, reader, and cloud connectivity without exposing credentials or biometric data. Once per minute it sends the Worker only operational status and the release version. R503 templates and raw scans remain exclusively within the sensor; the kiosk service handles slot numbers and member mappings only.

Normal operation is offline-first: the Pi writes scans to a local queue and retries in order. The reader adapter exposes only online status and slot match results, never templates. Captive portals are manual Wi-Fi/offline-first operation; advanced compatibility is documented but unsupported.
