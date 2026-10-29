# LancerLogin

LancerLogin is standalone, open-source, self-hosted attendance software for clubs, classrooms, teams, and arts groups. Each installation runs a web dashboard in the organization's own Cloudflare account and pairs any number of Raspberry Pi attendance kiosks.

The public repository contains the source, reviewed releases, and documentation. Each installation is a separate **private** repository created from this template; that private repository holds the installation's deployment history and secrets.

**Documentation: [isriah.github.io/LancerLogin](https://isriah.github.io/LancerLogin/)**

## What it does

- Records kiosk check-in and check-out by fingerprint, RFID badge, NFC badge, member ID, or QR code. Members never choose a meeting; the scan time selects it.
- Lets Admins and Operators manage meetings, attendance corrections, the roster, and reports within their permissions.
- Keeps fingerprint templates in the R503 sensor by default. Admin-enabled cloud storage can share enrollments between kiosks. Raw fingerprint images, badge values, and QR values are never uploaded. See the [privacy notice](https://isriah.github.io/LancerLogin/privacy.html).
- Queues scans on each kiosk while the network is down and sends them when it returns.
- Is built from modules: Attendance is built in, Outreach Participation is an official plugin, and Carpool and Guest Visits are optional plugins.
- Updates the dashboard from Settings after a backup, and each kiosk from the Kiosks page.

## Get started

1. [Install](https://isriah.github.io/LancerLogin/setup.html): create a private repository from this template, add a Cloudflare token and secrets, and run **Install or upgrade LancerLogin**.
2. [First sign-in and setup](https://isriah.github.io/LancerLogin/first-run.html): create the first Admin, choose modules, and complete Attendance setup.
3. [Set up kiosks](https://isriah.github.io/LancerLogin/kiosk.html), then [operate](https://isriah.github.io/LancerLogin/operations.html) and [update](https://isriah.github.io/LancerLogin/updates.html) the installation.

Upgrading a LancerLogin 1 installation? See [Upgrade Community to Modular](docs/COMMUNITY-UPGRADE.md).

## Reference documents

These describe behavior in depth. Step-by-step instructions are on the documentation site.

- [Architecture](docs/ARCHITECTURE.md), [security](docs/SECURITY.md), and [privacy](docs/PRIVACY.md)
- [Kiosk reference](docs/KIOSK.md) and [dashboard reference](docs/DASHBOARD.md)
- [Backup and restore](docs/BACKUP-RESTORE.md) and [local recovery](docs/LOCAL-RECOVERY.md)
- [Web updates](docs/WEB-UPDATES.md) and [update tracks](docs/UPDATE-TRACKS.md)
- [Integrations](docs/INTEGRATIONS.md), [labels and attendance policies](docs/ATTENDANCE-POLICIES.md), and [data workflows](docs/DATA-WORKFLOWS.md)
- [Module plugins](docs/MODULE-PLUGINS.md), [Outreach plugin](docs/OUTREACH.md), and [Carpool plugin](docs/CARPOOL.md)
- [Writing a plugin](docs/PLUGIN-AUTHORING.md) and [authoring modules](docs/MODULE-AUTHORING.md)
- [Local development and verification](docs/DEVELOPMENT.md)
- [Release notes](docs/releases/README.md) and [changelog](CHANGELOG.md)

## Support

Community support is available at robolancers@gmail.com. Support is best-effort, with no service-level agreement. LancerLogin is licensed under Apache-2.0; bundled font attributions are in [Third-party notices](THIRD_PARTY_NOTICES.md).
