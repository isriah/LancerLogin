# Integrations

All integrations are optional and configured, tested, rotated, or removed by Admins in the dashboard. Saved credentials remain encrypted and are never returned to the browser.

- Google OAuth provides optional dashboard sign-in.
- Resend sends one missed-meeting notice per member/meeting by default and individual attendance reports.
- Discord supports member linking, missing-member notices with contest records, calendar event create-or-update mapping, and one persistent kiosk-status message edited only when rendered state changes.

Current code uses provider fakes exclusively. Production bindings must enforce API signature verification, least-privilege scopes, explicit Admin consent before sends, durable idempotency, and audit records.
