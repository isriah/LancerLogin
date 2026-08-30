# Guided kiosk setup

Supported hardware: Raspberry Pi 3B+, 4, or 5 with at least 1 GB RAM; Waveshare 7-inch DSI LCD (E); R503 fingerprint reader; Wi-Fi or Ethernet.

The public release installer is launched from the dashboard and will guide a local operator through OS prerequisites, display/UART checks, sensor test, and kiosk pairing. It does not require a Git clone or manual source changes. The dashboard creates a time-limited, one-time pairing code; the Pi presents it only to the operator at setup. Pairing code hashes are the only code representation stored remotely.

Only an Admin can generate a pairing code. Generating a new one supersedes the prior code; expiration and successful redemption both make it unusable. The API exposes code status but never returns a code after the creation response.

Normal operation is offline-first: the Pi writes scans to a local queue and retries in order. The reader adapter exposes only online status and slot match results, never templates. Captive portals are manual Wi-Fi/offline-first operation; advanced compatibility is documented but unsupported.
