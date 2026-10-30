# Integrations

This guide is for Administrators. All integrations are optional and configured in **Settings > Integrations**. Enable a provider before entering credentials. Saved values remain encrypted and are never returned to the browser. A saved provider cannot send messages or sync data until its verification succeeds.

## Google sign-in

Google sign-in is separate from Google Calendar. In [Google Auth Platform](https://console.cloud.google.com/auth/overview), create a Web application client and copy the exact redirect URI that the setup card shows into **Authorized redirect URIs**. This is the address the API uses. Do not use a desktop client or invent the callback URL. Redirect URIs must use https. Only a `localhost` or `127.0.0.1` preview may use http.

For sign-in, request only `openid`, `email`, and `profile`. Google Auth Platform currently organizes the configuration as Branding, Audience, Clients, Data Access, and Verification Center. Select an Internal audience only if every intended dashboard user belongs to the project's Google Cloud organization. Otherwise use External and review Google's current publishing and verification requirements. For an External audience in Testing, add each Admin and Operator Google account under **Audience > Test users**. Otherwise Google shows "Access blocked".

Choose **Verify with Google** and sign in with a Google account that belongs to an active Admin. The Google email must match that Admin's LancerLogin email. If the installation was created with **Username and password**, first add the Admin's Google email in **Settings > Access**. Admins can add or change any user's Google email there. If verification fails, the Google sign-in card shows a message that explains the problem.

An active Admin must be able to use a local password before Google sign-in can be removed. This avoids removing the installation's only usable Admin sign-in route.

## Google Calendar

Google Calendar uses its own OAuth client, separate from Google sign-in. Calendar needs more access than sign-in, so it is best to keep it in its own Google Cloud project.

### Connect Google Calendar

1. In the [Google Cloud console](https://console.cloud.google.com/), use a separate project for Calendar. If you use the sign-in project instead, add the two Calendar scopes under **Data Access**: `https://www.googleapis.com/auth/calendar.calendarlist.readonly` and `https://www.googleapis.com/auth/calendar.events`.
2. Enable the [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) in that project.
3. In **Google Auth Platform > Clients**, create a **Web application** client. Add the **Authorized redirect URI** that the Google Calendar card shows. It has the form `https://<slug>-dashboard.pages.dev/api/admin/integrations/google-calendar/callback`.
4. For an External audience in Testing, add the Google account that will authorize Calendar under **Audience > Test users**.
5. In **Settings > Integrations > Google Calendar**, enter the client ID and client secret and choose **Save credentials**.
6. Choose **Authorize Google Calendar**. Sign in with the account that owns or can edit the calendar, and approve both permissions.
7. Choose **Load writable calendars**, pick the destination calendar, and choose **Use this calendar**.

If authorization fails, the card shows a message that explains the problem. In Testing, Google ends the authorization after 7 days. For ongoing sync, publish the app (**In production**) or use an Internal audience. When the card warns that authorization needs renewing, choose **Re-authorize Google Calendar**.

### Calendar delivery

Google Calendar and Discord scheduled events use the dashboard meeting title and notes as the event description, together with meeting start and end times. Clearing notes clears the Google event description on the next sync. Restrict provider destinations to the intended audience. LancerLogin does not add roster, attendance, attendees, or reminders to Google events.

Meeting delivery is asynchronous. A provider failure does not undo a meeting change. The integration card reports waiting or failed work and offers retry and **Sync all meetings**. Removing the connection clears LancerLogin's authorization and mappings; it does not promise to remove events already delivered to Google.

## Resend

Enable Resend, use a verified sending domain, create a **Sending access** API key restricted to that domain, and choose a plain From address on that domain with no display name. Verification sends a six-digit code to the Administrator-selected address. The code expires after ten minutes. The `onboarding@resend.dev` test sender delivers only to the email address of your own Resend account. If verification fails, the card shows Resend's own reason. Correct the stated domain, sender, or code issue before trying again.

## Discord

Discord can provide member linking, attendance notices, calendar delivery, contest handling, and a persistent kiosk-status message. Enable it, then provide the bot token, application public key, application ID, server ID, and attendance-channel ID requested by the card, and choose **Save credentials**. After saving, copy the exact Interactions Endpoint URL that LancerLogin shows into the Discord application settings. See [Create the Discord bot](#create-the-discord-bot) for the full order.

### Create the Discord bot

Follow these steps in order. Discord checks the Interactions Endpoint URL when you save it, and LancerLogin can answer only after its credentials are saved.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), choose **New Application**, and name it.
2. On the **Bot** page, choose **Reset Token** and copy the bot token into LancerLogin. Treat the token like a password. For optional label role sync, turn on the privileged **Server Members Intent** on the same page.
3. On the **General Information** page, copy the **Application ID** and **Public Key** into LancerLogin.
4. On the **Installation** page, enable **Guild Install** and select the **bot** scope. Grant **View Channels**, **Send Messages**, **Read Message History**, **Pin Messages**, **Create Public Threads**, **Create Events**, **Manage Events**, and **Manage Roles**. The bot needs **Create Events** to create scheduled events. Use the install link to add the bot to your server. For role sync, place the bot's role above the roles it will manage. Members need **Send Messages in Threads** in the attendance channel to ask questions in absence-notice threads.
5. In Discord, turn on **Developer Mode** in **User Settings > Advanced**. Right-click the server and choose **Copy Server ID**. Right-click the attendance channel and choose **Copy Channel ID**. The attendance channel must be a text channel. Paste both into LancerLogin.
6. In LancerLogin, choose **Save credentials**. All five values are required to save.
7. Copy the Interactions Endpoint URL that LancerLogin now shows under **Verify the connection**. This is the exact address the API uses. It has the form `https://<slug>-dashboard.pages.dev/api/discord/interactions`. Paste it into **Interactions Endpoint URL** on Discord's **General Information** page and choose **Save Changes**.
8. Choose **Send Discord verification**, then press the button in the message the bot posts.

If Discord says the interactions endpoint URL could not be verified, confirm that you chose **Save credentials** first. Then check that the saved public key is from the same Discord application: copy it again from **General Information** and use **Replace saved credentials**.

### After setup

Verification checks the saved application and server, reconciles the LancerLogin `/pair`, `/attendance-report`, `/label`, `/outreach-submit`, and `/outreach-correction` commands, sends a message to the selected attendance channel, and requires the signed button proof. After an update, a verified connection checks these commands automatically on the next five-minute maintenance pass and adds or updates only commands that changed. **Settings > Integrations > Discord** shows whether command setup is pending, current, or failed. **Reconcile Discord commands** repairs them immediately without replacing credentials or clearing existing mappings. Command setup does not associate labels or sync member roles. Outreach commands remain unavailable unless Outreach is enabled and ready.

Linked members can use `/outreach-submit` to record participation in an eligible dated Outreach activity and `/outreach-correction` to request Staff review. Responses are private and include receipt references. An exact Discord interaction retry is idempotent, and a correction never changes totals until Staff accepts it. Outreach Event publication is off by default. Staff can Publish or Resend a scheduled Event from its activity, or an Admin can enable automatic publication for future scheduled Events. Publication queues every configured Google Calendar and Discord destination and reports each provider result independently. Team Support and Other Service activities are never published.

Discord role sync is optional. Turn on the privileged **Server Members Intent** for the bot and grant **Manage Roles**, then place the bot's role above each role it will manage. In **Settings > Modules > Attendance > Labels**, an Admin links a label to a role by choosing it in the label's **Discord role** column. The list shows every server role and explains why the bot cannot manage some of them, such as a role above the bot's highest role or one managed by an integration. Role and label names do not need to match. **Create labels from Discord roles** creates a label named after each chosen role, or reuses an unlinked active label with that name, and links them. Each label links to at most one role and each role to at most one label.

An Admin can also link from Discord. Pair a roster member linked to an active LancerLogin Admin account; that Admin can run `/label @ROLE` in the configured server. An active label must have the same name as the role, ignoring letter case. Confirming the private prompt saves the link. Linking either way does not change role assignments.

On the **Labels** page, preview **Sync to Discord** for one label, or **Sync all linked roles** for every active linked label at once, before confirming. The preview lists additions, removals, and labeled members who are unpaired, absent from the server, or inactive. A sync removes the mapped role from every server member who is not an active, paired roster member with the current label, including unpaired accounts. It changes no other roles. Sync is manual; label and pairing changes take effect in Discord only after another sync. An icon next to each linked role shows its sync state: in sync, label changes since the last sync, syncing, failed, or never synced. Hover over it, focus it, or tap it for details, including when it last synced. Pairing changes are not tracked in that status. Applying label changes in Roster offers a link back to review role sync. When a sync fails for some members, the row's button becomes **Retry failed**, which retries only the failed changes still needed. Each row's **More** menu holds **Rename**, **View last sync**, **Unlink role**, and **Retire label**. Unlinking an association leaves existing Discord roles in place. Operators can view mappings, sync status, and the last sync.

Each absence notice opens one public thread for questions under its first message. Long recipient lists are split into multiple messages within Discord's content and mention limits, and every message includes the **Contest absence** button. The bot needs **Create Public Threads** permission, and members need **Send Messages in Threads** permission in the attendance channel. The button requests a private review. After rejection, a linked member can submit again within the same notice window; repeated clicks on an open request do not create duplicates. Earlier rejection reasons and reviewer details are retained. Turn on **Block re-contests after rejection** in the Discord settings to prevent this. The bot removes every tracked message in the notice after the configured contest window on its next five-minute maintenance pass, even when the optional attendance-channel manager is off. The thread may remain in Discord after its starter notice is removed. Changing a meeting's times, required setting or audience while its notice is still within the contest window removes that notice right away. A fresh notice is posted when the edited meeting's attendance closes. If Discord refuses the removal, maintenance keeps retrying and no new notice is posted. A member who is still checked in cannot contest before attendance closes. The optional manager maintains the pinned kiosk status and attendance guide. The optional anomaly report requires a different text channel in the verified server. Administrators must restrict that channel to intended attendance staff. If that channel is private, add the bot to it with **View Channel**, **Send Messages**, and **Read Message History**. Provider failures never block kiosk scans or an attendance record.

Sync upcoming meetings before their start time. A meeting already in progress without a Discord event is skipped with an explanation; existing active events retain their provider start time when updated. Ended meetings are skipped.

The Kiosks page verifies the tracked status message before reporting it current and provides **View Discord status message** after syncing. If the message was deleted, sync recreates it. Enable the attendance-channel manager to keep it pinned.

## Safe changes

Saving, rotating, disabling, or removing a provider clears its verification where appropriate. Disabled and unverified providers do not send operational messages or synchronize meetings. Review the card's status after every change and retry only the action it identifies. Do not paste credentials into source, logs, screenshots, or chat.
