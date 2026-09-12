# LancerLogin

Open-source, self-hosted, standalone attendance for clubs, classrooms, teams, and arts groups. LancerLogin pairs one Raspberry Pi fingerprint kiosk with a web dashboard that your organization runs in its own Cloudflare account.

## What it offers

- Branded touch-screen kiosk attendance with fingerprint check-in and check-out.
- Roster management, CSV import, member search, active-member filtering, and optional Discord account links.
- One-time and recurring meetings, attendance windows, manual corrections, excuses, and an immediate undo for meeting deletion.
- Attendance history, CSV export, attendance rates with and without excused meetings, reports, and contest review.
- Optional Discord calendar sync, absence notices, and member-contestable attendance notices.
- Admin and Operator dashboard roles, local-password or Google sign-in, audit history, and scoped data backup, restore, and deletion.
- Organization branding, light/dark appearance controls, a mobile dashboard, kiosk health, remote fixed recovery actions, and latest-stable kiosk updates.
- Local offline scan queueing so the kiosk can retain attendance events until its connection returns.

## Supported hardware

One physical kiosk is supported per installation:

- Raspberry Pi 3B+, 4, or 5 with at least 1 GB RAM.
- Waveshare 7-inch DSI LCD (E), designed for an 800x480 touch display.
- R503 fingerprint reader connected to the Pi.
- Wi-Fi or Ethernet.

Fingerprint templates stay inside the R503 sensor. LancerLogin stores slot-to-member mappings locally on the kiosk and never uploads fingerprint templates or raw scans.

## Install

1. Create a **private** repository from this template in your GitHub account.
2. Follow the [step-by-step installation guide](https://isriah.github.io/LancerLogin/setup.html) to create a narrowly scoped Cloudflare token and configure the private repository secrets.
3. Run **Install or upgrade LancerLogin** in the private repository with `create`, `Latest stable`, your lowercase installation slug, and `CREATE <slug>`.
4. Open the resulting dashboard URL, enter the one-time setup code, and create the first Admin account.
5. Complete guided setup: organization branding, roster, kiosk pairing, kiosk input test, and attendance confirmation.
6. On the Raspberry Pi, use the dashboard pairing flow and the guided kiosk installer. The kiosk then starts in full-screen attendance mode.

For upgrades, use **Settings > Updates** to download an entire-installation backup and open the private workflow. Select `upgrade`, keep `Latest stable`, and enter `UPGRADE <slug>`.

## Documentation

- [Installation and upgrade guide](docs/BOOTSTRAPPING.md)
- [Kiosk setup and operations](docs/KIOSK.md)
- [Dashboard guide](docs/DASHBOARD.md)
- [Data backup and restore](docs/BACKUP-RESTORE.md)
- [Security model](docs/SECURITY.md)
- [Privacy notice](docs/PRIVACY.md)
- [Release notes](docs/releases/README.md)
- [Local development and verification](docs/DEVELOPMENT.md)

## Support

Community support: robolancers@gmail.com (no SLA).

LancerLogin is licensed under Apache-2.0. Bundled font attributions and licenses are listed in [Third-party notices](THIRD_PARTY_NOTICES.md).
