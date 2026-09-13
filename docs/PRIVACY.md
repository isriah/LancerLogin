# Privacy notice

LancerLogin stores organization configuration, roster, meeting, attendance, audit, and optional integration information in the adopter's Cloudflare account until an Administrator exports or deletes it. The organization operating an installation is responsible for its own retention and access decisions.

## Fingerprints and kiosk data

Fingerprint templates remain in the attached R503 sensor. LancerLogin does not upload fingerprint templates or raw fingerprint scans. The kiosk stores slot-to-member mappings locally so it can identify a scan. Local queued attendance events are retained only until they can be delivered or handled through the documented recovery process.

## Dashboard and integrations

The dashboard stores local-password hashes, encrypted optional-integration credentials, roster and attendance records, and audit history. Saved integration values are not displayed in the browser. An entire-installation backup can contain password hashes, encrypted integration ciphertext, kiosk credential hashes, and audit history. Protect it like an Administrator credential.

## Anonymous usage reporting

The first-Admin form labels this option **Anonymous usage reporting**. It is enabled by default and has an immediate opt-out. An Administrator can change it in **Settings → Privacy**.

While reporting is enabled, LancerLogin can send an opaque random installation reference, release version, active kiosk count, one scrubbed diagnostic category, and best-effort city or metro. It does not send names, roster data, attendance, fingerprint data, organization name, dashboard accounts, credentials, message content, request paths, or raw IP addresses. Turning reporting off clears the local reporting reference and stops future reports.

RoboLancers operates the optional community collector. It retains reports for 30 days and restricts aggregate access to designated maintainers. While reporting is enabled, an Administrator can copy the deletion-request reference from **Settings → Privacy** and email robolancers@gmail.com. Community support has no service-level agreement. See [telemetry governance](TELEMETRY-GOVERNANCE.md) for retention, deletion, and incident handling.
