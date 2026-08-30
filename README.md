# LancerLogin

Open-source, self-hosted attendance for a single Raspberry Pi fingerprint kiosk and its administrators. It is designed for clubs, classrooms, teams, and arts groups.

LancerLogin is a new, standalone project. It has no migration or connection path to any existing attendance installation. Fingerprint templates remain on the local R503 sensor; the cloud service stores only roster, attendance, settings, and installation-encrypted integration secrets.

## Current stage

This repository contains the runnable Worker, D1 schema, Pages dashboard, guided Raspberry Pi kiosk service, public documentation, adopter-owned provisioning workflow, and mocked provider/hardware verification suite. Local builds do not configure or contact a Cloudflare account, Raspberry Pi, or external integration. Deployment occurs only when an adopter adds their own scoped token and manually runs the guarded workflow.

## Local development

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Start an individual package with `npm run dev:api`, `npm run dev:dashboard`, or `npm run dev:kiosk`. The Worker starts unconfigured and cannot deploy or modify cloud resources through these commands.

Read [the browser-led quick start](docs/BOOTSTRAPPING.md), [architecture](docs/ARCHITECTURE.md), [security model](docs/SECURITY.md), and [public task guides](docs-site/index.html).

## Support

Community support: robolancers@gmail.com (no SLA).
