# Privacy notice (draft)

LancerLogin stores organization configuration, roster, meeting, attendance, and audit information in the adopter's cloud account until an Admin exports or deletes it. Fingerprint templates remain exclusively in the attached R503 sensor. The system does not upload fingerprint templates or raw fingerprint scans.

Optional integrations store encrypted credentials in the adopter's installation and never display saved values. With first-Admin consent only, telemetry sends a random installation ID, release version, active kiosk count, scrubbed diagnostic category, and approximate city/metro. It does not send names, roster, attendance, fingerprint data, organization name, or raw IP address. Raw IP is discarded after the coarse location lookup.

The Worker buffers only one coarse diagnostic category (`worker-internal` or `integration-upstream`) after consent; it never stores an exception message, request path, identity, or IP for telemetry. A successfully transmitted category is then cleared. Declining telemetry clears the opaque telemetry installation ID and prevents diagnostic collection.

Support: robolancers@gmail.com. No service-level agreement is offered.
