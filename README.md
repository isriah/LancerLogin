# LancerLogin

LancerLogin is standalone, open-source, self-hosted attendance software for clubs, classrooms, teams, and arts groups. Each installation can use multiple Raspberry Pi attendance kiosks with one dashboard in the organization's own Cloudflare account.

The current stable public release is **1.2.6**. The public repository contains source, reviewed releases, and public documentation. Create a separate **private** repository from the template for an installation. That private repository holds deployment history and secrets.

This source is **2.0.0-beta.7**, an opt-in Modular beta. Stable remains the default update track. Follow the Community bridge prerequisites below before opting in.

## What it does

- Records kiosk check-in and check-out using fingerprint, RFID badge, NFC badge, member ID, or QR code identity input.
- Lets Administrators and Operators manage meetings, attendance, reports, and roster information within their assigned permissions.
- Keeps fingerprint templates in the optional R503 sensor by default. Admin-enabled cloud storage uses server-managed encryption so new kiosks can receive verified enrollments while other kiosks are offline. Raw fingerprint images, badge values, and QR values are not uploaded. See the [privacy boundary](docs/PRIVACY.md).
- Queues kiosk scans locally while the network is unavailable, then retries them safely when the connection returns.
- Provides backup-first web updates and a separately managed physical-kiosk update path.

## Supported kiosk

Each physical kiosk can use a Raspberry Pi 3B+, 4, or 5 with at least 1 GB RAM, a Waveshare 7-inch DSI LCD (E), and Wi-Fi or Ethernet. An installation may pair multiple uniquely named kiosks. Fingerprint mode uses an R503 reader. RFID, NFC, and QR mode accept bounded keyboard-wedge reader input. Member ID mode uses the touch screen or an attached keyboard.

## Install

1. Select **Use this template** in the [public repository](https://github.com/isriah/LancerLogin) and create a **private** repository in your GitHub account.
2. Follow the [public setup guide](https://isriah.github.io/LancerLogin/setup.html) to create the required Cloudflare account token and private repository secrets.
3. In the private repository, run **Install or upgrade LancerLogin** with `create`, **Latest stable**, and a lowercase installation slug.
4. Open the dashboard URL from the workflow summary, enter the one-time setup code, and create the first Admin account.
5. Complete Guided Setup, then pair the physical kiosk or use the browser simulator for a software-only check.

For a routine web update, an Admin opens **Settings → Updates**, reviews the pinned release, downloads an entire-installation backup, and uses **Start update** only after confirming the backup was saved. Physical-kiosk updating is separate. See [web updates](docs/WEB-UPDATES.md) and [kiosk operations](docs/KIOSK.md).

Stable is the default update track. Admins can explicitly opt in to Beta without starting an update. Install the Community bridge and update the private controller and kiosks first. See [Stable and Beta update tracks](docs/UPDATE-TRACKS.md).

## Documentation

- [Installation and Cloudflare setup](docs/BOOTSTRAPPING.md)
- [Dashboard guide](docs/DASHBOARD.md)
- [Kiosk setup and operations](docs/KIOSK.md)
- [Data backup and restore](docs/BACKUP-RESTORE.md)
- [Community-to-Modular upgrade](docs/COMMUNITY-UPGRADE.md)
- [Outreach module](docs/OUTREACH.md)
- [Carpool module](docs/CARPOOL.md)
- [Integrations](docs/INTEGRATIONS.md)
- [Privacy](docs/PRIVACY.md) and [security](docs/SECURITY.md)
- [Release notes](docs/releases/README.md)
- [Local development and verification](docs/DEVELOPMENT.md)
- [Authoring bundled modules](docs/MODULE-AUTHORING.md)

## Support

Community support is available at robolancers@gmail.com. There is no service-level agreement. LancerLogin is licensed under Apache-2.0; bundled font attributions are in [Third-party notices](THIRD_PARTY_NOTICES.md).
