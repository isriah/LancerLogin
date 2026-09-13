# LancerLogin V2 development

This is the unfinished Modular V2 snapshot on `codex/v2`. Community V1 remains on `main`; use the latest stable Community release for installation.

Read [V2 status](docs/V2-STATUS.md), [development isolation](docs/MODULAR-DEVELOPMENT.md), [architecture](docs/ARCHITECTURE.md) and [local verification](docs/DEVELOPMENT.md) before changing this branch. It is preserved for continued development and is not a production release or a supported V1 upgrade.

Use Node 24.10 or later and `npm ci --no-audit`. Run focused checks for touched behavior, then `npm run verify:all` and `npm run test:browser` when reviewing a broader change. Publishing and deployment automation is disabled on this branch.

LancerLogin is a standalone attendance system. Fingerprint templates remain on the local biometric sensor, outside server records and public fixtures.
