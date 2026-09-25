# LancerLogin

LancerLogin is standalone, open-source, self-hosted attendance software for clubs, classrooms, teams, and arts groups. Each installation uses one Raspberry Pi fingerprint kiosk and a dashboard in the organization's own Cloudflare account.

The current stable public release is **1.2.0**. The public repository contains source, reviewed releases, and public documentation. Create a separate **private** repository from the template for an installation. That private repository holds deployment history and secrets.

## What it does

- Records kiosk check-in and check-out with an R503 fingerprint reader.
- Lets Administrators and Operators manage meetings, attendance, reports, and roster information within their assigned permissions.
- Keeps fingerprint templates in the R503 sensor. LancerLogin does not upload templates or raw fingerprint scans.
- Queues kiosk scans locally while the network is unavailable, then retries them safely when the connection returns.
- Provides backup-first web updates and a separately managed physical-kiosk update path.

## Supported kiosk

One physical kiosk is supported per installation: a Raspberry Pi 3B+, 4, or 5 with at least 1 GB RAM, a Waveshare 7-inch DSI LCD (E), an R503 reader, and Wi-Fi or Ethernet.

## Install

1. Select **Use this template** in the [public repository](https://github.com/isriah/LancerLogin) and create a **private** repository in your GitHub account.
2. Follow the [public setup guide](https://isriah.github.io/LancerLogin/setup.html) to create the required Cloudflare account token and private repository secrets.
3. In the private repository, run **Install or upgrade LancerLogin** with `create`, **Latest stable**, and a lowercase installation slug.
4. Open the dashboard URL from the workflow summary, enter the one-time setup code, and create the first Admin account.
5. Complete Guided Setup, then pair the physical kiosk or use the browser simulator for a software-only check.

For a routine web update, an Admin opens **Settings → Updates**, reviews the pinned release, downloads an entire-installation backup, and uses **Start update** only after confirming the backup was saved. Physical-kiosk updating is separate. See [web updates](docs/WEB-UPDATES.md) and [kiosk operations](docs/KIOSK.md).

## Documentation

- [Installation and Cloudflare setup](docs/BOOTSTRAPPING.md)
- [Dashboard guide](docs/DASHBOARD.md)
- [Kiosk setup and operations](docs/KIOSK.md)
- [Data backup and restore](docs/BACKUP-RESTORE.md)
- [Integrations](docs/INTEGRATIONS.md)
- [Privacy](docs/PRIVACY.md) and [security](docs/SECURITY.md)
- [Release notes](docs/releases/README.md)
- [Local development and verification](docs/DEVELOPMENT.md)

## Support

Community support is available at robolancers@gmail.com. There is no service-level agreement. LancerLogin is licensed under Apache-2.0; bundled font attributions are in [Third-party notices](THIRD_PARTY_NOTICES.md).
