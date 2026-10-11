# LancerLogin guide

LancerLogin is a self-hosted attendance dashboard and one-Raspberry-Pi kiosk for an organization that manages its own GitHub and Cloudflare accounts. The current stable public release is **1.0.3**.

## Start here

1. Create a **private** deployment repository from the public [LancerLogin template](https://github.com/isriah/LancerLogin).
2. Follow the [setup walkthrough](https://isriah.github.io/LancerLogin/setup.html) to configure the private deployment environment and install the dashboard.
3. Create the first Administrator, read the privacy notice, and complete Guided Setup.
4. Pair a Raspberry Pi kiosk with a one-time key, or use the browser simulator for a software-only check.

## Choose a task

- [Set up an installation](../docs/BOOTSTRAPPING.md)
- [Configure the dashboard](../docs/DASHBOARD.md)
- [Set up and operate a kiosk](../docs/KIOSK.md)
- [Manage backups and recovery](../docs/BACKUP-RESTORE.md)
- [Configure optional integrations](../docs/INTEGRATIONS.md)
- [Understand privacy](../docs/PRIVACY.md)
- [Read release notes](../docs/releases/README.md)

Public documentation never contains private repository details, account IDs, backup contents, credentials, attendance records, or operator output. A Raspberry Pi kiosk can be managed locally or through the access method its Administrator has configured, such as SSH or Raspberry Pi Connect. Neither remote method is required by LancerLogin.

The public site uses sanitized provider screenshots and generated example values. A browser simulator demonstrates dashboard-to-kiosk behavior but is not physical kiosk evidence.

## Screenshot coverage

The setup walkthrough includes sanitized GitHub, Cloudflare and integration controls, with annotated dashboard and kiosk examples. Screenshots describe the documented flow and contain generated example values. They are not proof of physical kiosk behavior or a complete installation-specific credential inventory.
