# Integrations

This guide is for Administrators. All integrations are optional and configured in **Settings → Integrations**. Enable a provider before entering credentials. Saved values remain encrypted and are never returned to the browser. A saved provider cannot send messages or sync data until its verification succeeds.

## Google sign-in

Google sign-in is separate from Google Calendar. In [Google Auth Platform](https://console.cloud.google.com/auth/overview), create a Web application client and copy the dashboard's exact callback URI into **Authorized redirect URIs**. Do not use a desktop client or invent the callback URL.

For sign-in, request only `openid`, `email`, and `profile`. Google Auth Platform currently organizes the configuration as Branding, Audience, Clients, Data Access, and Verification Center. Select an Internal audience only if every intended dashboard user belongs to the project's Google Cloud organization. Otherwise use External and review Google's current publishing and verification requirements.

An active Admin must be able to use a local password before Google sign-in can be removed. This avoids removing the installation's only usable Admin sign-in route.

## Google Calendar

Enable Google Calendar separately, save its OAuth web client, authorize one Google account, and select a calendar where that account can write. LancerLogin sends only the generic event name **LancerLogin meeting** and meeting start and end times. It does not send roster, attendance, notes, organization name, attendee, reminder, or description data.

Meeting delivery is asynchronous. A provider failure does not undo a meeting change. The integration card reports waiting or failed work and offers retry and **Sync all meetings**. Removing the connection clears LancerLogin's authorization and mappings; it does not promise to remove events already delivered to Google.

## Resend

Enable Resend, use a verified sending domain, create a sending-only API key, and choose a From address on that domain. Verification sends a six-digit code to the Administrator-selected address. The code expires after ten minutes. If verification fails, correct the stated domain, sender, or code issue before trying again.

## Discord

Discord can provide member linking, attendance notices, calendar delivery, contest handling, and a persistent kiosk-status message. Enable it, then provide the bot token, application public key, application ID, server ID, and attendance-channel ID requested by the card. Copy the exact Interactions Endpoint URL that LancerLogin shows into the Discord application settings.

Verification checks the saved application and server, reconciles the LancerLogin `/pair` and `/attendance-report` commands, sends a message to the selected attendance channel, and requires the signed button proof. **Reconcile Discord commands** repairs those two commands without replacing credentials or clearing existing mappings.

The optional attendance-channel manager operates only on LancerLogin-tracked messages. The optional anomaly report requires a different text channel in the verified server. Administrators must restrict that channel to intended attendance staff. Provider failures never block kiosk scans or an attendance record.

## Safe changes

Saving, rotating, disabling, or removing a provider clears its verification where appropriate. Disabled and unverified providers do not send operational messages or synchronize meetings. Review the card's status after every change and retry only the action it identifies. Do not paste credentials into source, logs, screenshots, or chat.
