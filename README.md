# LancerLogin

Open-source, self-hosted attendance for a single Raspberry Pi fingerprint kiosk and its administrators. It is designed for clubs, classrooms, teams, and arts groups.

LancerLogin is a new, standalone project. It has no migration or connection path to any existing attendance installation. Fingerprint templates remain on the local R503 sensor; the cloud service stores only roster, attendance, settings, and installation-encrypted integration secrets.

## Current stage

This repository contains runnable Worker, dashboard, and kiosk workspace packages backed by a mock-first implementation roadmap. No Cloudflare account, Raspberry Pi, tokens, or external service is configured or contacted by local builds.

## Local development

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Start an individual package with `npm run dev:api`, `npm run dev:dashboard`, or `npm run dev:kiosk`. The Worker starts unconfigured and cannot deploy or modify cloud resources through these commands.

Read [the quick start design](docs/BOOTSTRAPPING.md), [architecture](docs/ARCHITECTURE.md), and [implementation roadmap](docs/ROADMAP.md).

## Support

Community support: robolancers@gmail.com (no SLA).
