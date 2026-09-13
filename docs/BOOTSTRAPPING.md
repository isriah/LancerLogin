# Installation setup

This guide is for the Administrator creating a new organization-owned LancerLogin installation. It describes a fresh installation, not a migration or a recovery. The current stable public release is 1.0.2.

## Before you start

- Create an organization-owned GitHub account or confirm that you can administer a private repository and its `production` environment.
- Confirm that you are a Super Administrator in the Cloudflare account that will own the Worker, D1 database, and Pages dashboard.
- Choose a lowercase installation slug made of letters, numbers, and hyphens. Keep the slug with the private deployment repository record.
- Store generated secrets in a password manager. Do not put them in a repository file, issue, dashboard form, or chat.

## Create the private deployment repository

1. Open [isriah/LancerLogin](https://github.com/isriah/LancerLogin), select **Use this template**, and create a **private** repository in the adopter's GitHub account. Do not fork the public repository for an installation.
2. In the private repository, open **Settings → Environments**, create the `production` environment, and add a required reviewer if the GitHub plan supports it.
3. Follow [Cloudflare linking](CLOUDFLARE-LINKING.md) to create the account-owned token and add the three required environment secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `LANCERLOGIN_SETUP_CODE`.
4. Before provisioning, set up the separate web-update credential and installation variables described in [web updates](WEB-UPDATES.md). This keeps routine web updates scoped to the private deployment repository.

## Run the installation workflow

1. In the private repository, open **Actions → Install or upgrade LancerLogin → Run workflow**.
2. Select `create`, keep **Latest stable**, and enter the chosen `installation_slug`.
3. Select **Run workflow**. If the `production` environment waits for approval, complete that approval in GitHub.
4. On success, open the Pages dashboard URL in the workflow summary. The workflow checks the account-token pair and refuses resource-name collisions before it creates the installation.

Use `resume` only after an interrupted initial setup with the same slug. Use `upgrade` for a routine web update, not a fresh installation. See [web updates](WEB-UPDATES.md).

## Create the first Administrator

1. Open the dashboard URL and enter `LANCERLOGIN_SETUP_CODE`.
2. Create the first Admin with a local password, Google sign-in, or both. The setup code is not the Admin password.
3. Review **Anonymous usage reporting**. It is enabled by default and has an immediate opt-out. It can be changed later in **Settings → Privacy**.
4. If you use Google sign-in, copy the exact redirect URI shown by the dashboard into the Google OAuth client. Do not guess or edit the URL. See [Integrations](INTEGRATIONS.md).

The bootstrap route closes after the installation record exists. If sign-in configuration needs recovery later, use the documented local recovery procedure rather than trying to reopen first-Admin setup.

## Complete Guided Setup

Guided Setup is shared across Administrators. It leads through **Organization**, **Roster**, **Kiosk**, **Kiosk input test**, and **Attendance confirmation**. Each required step records who completed it and when. Optional integrations do not block completion.

For the kiosk step, install the guided Pi package first. The installer starts an unpaired local service. Back in the dashboard, create a one-time pairing key and paste it into the Pi's local pairing page. The browser simulator can verify a software-only path, but it does not verify a physical reader or kiosk.

When the final attendance check is complete, select **Go to Dashboard**. You can reopen the checklist later through **Settings → Guided Setup** without deleting data.
