# Integrations

All integrations are optional and configured, tested, rotated, or removed by Admins in the dashboard. Saved credentials remain encrypted and are never returned to the browser.

- Google OAuth provides optional dashboard sign-in. Register the adopter's Pages callback, `https://<slug>-dashboard.pages.dev/api/auth/google/callback`.
- Resend sends one missed-meeting notice per member/meeting by default and individual attendance reports.
- Discord supports member linking, missing-member notices with contest records, calendar event create-or-update mapping, and one persistent kiosk-status message edited only when rendered state changes.

The Worker contains production HTTPS clients for these provider APIs. Automated tests replace outbound requests with provider fakes, so CI never sends email, Discord messages, calendar events, or OAuth credentials. Delivery keys, update mappings, controlled mentions, Admin-only configuration, and audit records enforce the workflow boundaries.
