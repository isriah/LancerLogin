# Integrations

All integrations are optional and configured, tested, rotated, or removed by Admins in the dashboard. Saved credentials remain encrypted and are never returned to the browser.

- Google OAuth provides optional dashboard sign-in. Register the adopter's Pages callback, `https://<slug>-dashboard.pages.dev/api/auth/google/callback`. When Google is selected during first-Admin setup, its client ID and secret are collected and encrypted in that setup form so Google-only installations never depend on a login that has not been configured yet. Admins can later test, rotate, or remove the configuration in Integrations.
- Resend sends one missed-meeting notice per member/meeting by default and individual attendance reports.
- Discord supports Operator/Admin member linking, automatic absence notices after the organization-wide scan cutoff, signed member-submitted contests, calendar event create-or-update mapping, and one persistent kiosk-status message. The five-minute schedule sends each meeting notice once, records exactly who received it, and retries failed delivery. Only a linked recipient pressing the signed message button can open a contest; attendance does not change until an Admin or Operator records a review note and approves it. Controlled mentions prevent unrelated pings. Heartbeats update kiosk state and the same five-minute schedule marks stale kiosks offline. Discord failures never block kiosk or attendance delivery.

Discord setup needs the bot token, application public key, server ID, and attendance channel ID. Set the Discord application Interactions Endpoint URL to the exact URL displayed by **Settings → Integrations**. The public key verifies every button submission before any contest write.

The Worker contains production HTTPS clients for these provider APIs. Automated tests replace outbound requests with provider fakes, so CI never sends email, Discord messages, calendar events, or OAuth credentials. Delivery keys, update mappings, controlled mentions, Admin-only configuration, and audit records enforce the workflow boundaries.
