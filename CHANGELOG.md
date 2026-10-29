# Changelog

LancerLogin follows semantic versioning. Each release's full notes are kept in [`docs/releases`](docs/releases/README.md) and published with the release on [GitHub Releases](https://github.com/isriah/LancerLogin/releases). This file summarizes major versions only.

## 2.0.0

LancerLogin 2.0.0 is the first stable release of LancerLogin 2.

- **Modules and plugins.** Attendance is built in, and Admins choose which modules to turn on. Outreach Participation is an official plugin; Carpool and Guest Visits are optional plugins that Admins can add from Settings.
- **Multiple kiosks and sign-in methods.** Pair as many kiosks as you need, each with its own method: fingerprint, RFID badge, NFC badge, member ID entry, or QR code. Optional encrypted cloud storage lets new kiosks receive existing fingerprint enrollments.
- **Easier first-time setup.** The installer checks your token and settings before it creates anything and explains each problem it finds. In the dashboard, you create the first Admin, choose modules, and follow Attendance setup to a working first check-in.
- **Optional dashboard update token.** One-click dashboard updates need a GitHub token, but it is now optional and LancerLogin reads its expiry from GitHub. Without it, update by running the installation workflow.
- **Updates.** Stable and Beta update tracks, and kiosk updates from the Kiosks page that switch back automatically if the new release fails to start.

LancerLogin 1 installations update in place through the 1.2.6 bridge; see [Upgrade Community to Modular](docs/COMMUNITY-UPGRADE.md).

## 1.x

LancerLogin 1 established the self-hosted dashboard and kiosk, in-app web updates, member labels and attendance rules, saved reports, and the Stable and Beta update tracks. See the [release notes index](docs/releases/README.md).

## 0.x

Notes for pre-1.0 releases from v0.24.0 are in the [release notes index](docs/releases/README.md). Earlier pre-1.0 versions have no published notes.
