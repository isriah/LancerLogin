# Anonymous usage reporting governance

RoboLancers operates the optional LancerLogin anonymous usage collector. Community support, deletion requests, and responsible incident reports go to robolancers@gmail.com. There is no response-time or uptime service-level agreement.

## Collection and consent

Anonymous usage reporting is enabled by default during first-Admin setup, with a plain-language opt-out. An Administrator can later turn it off in **Settings → Privacy**. Turning it off stops future reports and clears the installation's local reporting reference.

The collector accepts only an opaque installation reference, release version, active kiosk count (`0` or `1`), one scrubbed diagnostic category, and optional city or metro. It must not receive organization, roster, attendance, fingerprint, credential, raw-IP, request-path, or message-content data. Cloudflare may use the connection to derive coarse location, but raw IP is not in the application payload or collector storage.

## Retention and access

The collector retains one report per installation per UTC day for 30 days. It replaces the raw reference with a keyed HMAC before storage. Only designated maintainers can access its authenticated aggregate endpoint, which never returns installation references or hashes. Metro groups with fewer than five installations are suppressed.

## Deletion and incidents

While reporting remains enabled, an Administrator can copy the deletion-request reference from **Settings → Privacy** and email it to RoboLancers. Maintainers verify the request through that reply channel, submit the reference to the authenticated deletion route, and remove matching reports and the pseudonymous installation row. Request deletion before opting out if removal of already pseudonymized reports is required.

If an incident could materially affect installations, RoboLancers will investigate, contain or disable the collector when needed, remove affected data where appropriate, and publish a plain-language public notice describing the affected period, data categories, mitigation, and recommended adopter actions.
