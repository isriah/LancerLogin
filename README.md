# LancerLogin

Open-source, self-hosted attendance for a single Raspberry Pi fingerprint kiosk and its administrators. It is designed for clubs, classrooms, teams, and arts groups.

LancerLogin is a new, standalone project. It has no live connection path to any existing attendance installation. Exported roster rows and local R503 slot mappings can be prepared for import, but fingerprint templates remain on the local R503 sensor; the cloud service stores only roster, attendance, settings, and installation-encrypted integration secrets.

## Current stage

This public repository contains the runnable Worker, D1 schema, Pages dashboard, guided Raspberry Pi kiosk service with a touch UI and in-sensor enrollment, public documentation, private-repository provisioning workflow, and mocked provider/hardware verification suite. Local builds do not configure or contact a Cloudflare account, Raspberry Pi, or external integration. Adopters create a private repository from this template; only that private repository can deploy a selected public release tag with the adopter's scoped token and one-time first-Admin setup code.

## Local development

```powershell
npm.cmd install
npm.cmd run verify:dashboard
npm.cmd run verify:all
```

Use the smallest relevant `verify:<area>` command while iterating, then run `verify:all` once before handing off a completed batch. `verify:browser` includes dashboard checks at 375x667 and 390x844, covering route overflow, touch targets, and the roster-member dialog. The available scopes and release gate are documented in [Local development and verification](docs/DEVELOPMENT.md). Start an individual package with `npm run dev:api`, `npm run dev:dashboard`, or `npm run dev:kiosk`. The Worker starts unconfigured and cannot deploy or modify cloud resources through these commands.

Start with the public [step-by-step installation guide](https://isriah.github.io/LancerLogin/setup.html), which includes real, sanitized GitHub and Cloudflare screenshots. Then use the repository’s [browser-led quick start](docs/BOOTSTRAPPING.md), [architecture](docs/ARCHITECTURE.md), [security model](docs/SECURITY.md), [release notes](docs/releases/README.md), and [release requirement checklist](docs/RELEASE-CHECKLIST.md).

## Support

Community support: robolancers@gmail.com (no SLA).

LancerLogin is licensed under Apache-2.0. Bundled font attributions and licenses are listed in [Third-party notices](THIRD_PARTY_NOTICES.md).
