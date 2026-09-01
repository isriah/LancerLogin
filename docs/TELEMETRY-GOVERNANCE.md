# Anonymous usage reporting governance

RoboLancers operates the optional LancerLogin anonymous usage collector. Internal code and infrastructure may retain the technical term `telemetry`. Questions, deletion requests, and responsible incident reports go to `robolancers@gmail.com`. Community support is best-effort and has no response-time or uptime SLA.

## Collection and consent

Anonymous usage reporting is enabled by default on the first-Admin form, where the plain privacy notice and an immediate opt-out checkbox are shown together. An Admin can later turn reporting off in **Settings → Privacy**, which stops future reports and clears the installation's local reporting reference.

An accepted installation can send only an opaque random installation reference, release version, active kiosk count (`0` or `1`), one scrubbed diagnostic category, and best-effort city/metro. Raw IP is used only by Cloudflare to derive coarse connection location and is not read into the application payload or stored. Organization, roster, attendance, fingerprint, credential, and raw-IP data are prohibited by the collector schema and request validation.

## Retention and access

Reports are retained for 30 days and then deleted by a daily scheduled job. The collector stores at most one row per installation per UTC day and replaces the raw random reference with a keyed HMAC before storage. Only designated RoboLancers maintainers may access the authenticated aggregate endpoint. That endpoint never returns installation references or hashes, and metro groups with fewer than five installations are suppressed.

## Deletion requests

While reporting is enabled, an Admin can copy the opaque deletion-request reference shown in **Settings → Privacy** and email it to `robolancers@gmail.com`. Maintainers verify the request through the reply channel, submit the reference to the authenticated deletion route, and remove all matching reports and the pseudonymous installation row. The deletion route hashes the supplied reference in memory and does not persist it. Turning reporting off stops future reports but cannot identify already pseudonymized collector rows after the local reference is cleared, so request deletion before opting out if removal of retained reports is wanted.

## Incidents and disclosure

RoboLancers will investigate reports sent to the support address, contain the collector or disable its endpoint when needed, delete affected data where appropriate, and publish a plain-language notice in the public repository when an incident could materially affect community installations. The notice will describe the affected period and data categories, mitigations, and recommended adopter actions without exposing installation or personal data.

The collector uses fresh, dedicated Cloudflare resources and credentials. It never shares an account, database, Worker, secret, repository, or deployment path with an adopter installation or any earlier attendance system.
