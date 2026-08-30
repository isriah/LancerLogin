# Integrations

All integrations are optional and configured, tested, rotated, or removed by Admins in the dashboard. Saved credentials remain encrypted and are never returned to the browser.

- Google OAuth provides optional dashboard sign-in. Register the adopter's Pages callback, `https://<slug>-dashboard.pages.dev/api/auth/google/callback`. When Google is selected during first-Admin setup, its client ID and secret are collected and encrypted in that setup form so Google-only installations never depend on a login that has not been configured yet. Admins can later test, rotate, or remove the configuration in Integrations.
- Resend sends one missed-meeting notice per member/meeting by default and individual attendance reports.
- Discord supports Operator/Admin member linking, missing-member notices with dashboard-visible contest records and audited resolution, calendar event create-or-update mapping, and one persistent kiosk-status message edited only when rendered state changes.

The Worker contains production HTTPS clients for these provider APIs. Automated tests replace outbound requests with provider fakes, so CI never sends email, Discord messages, calendar events, or OAuth credentials. Delivery keys, update mappings, controlled mentions, Admin-only configuration, and audit records enforce the workflow boundaries.
