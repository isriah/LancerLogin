# LancerLogin V2 guidance

Read README.md, docs/V2-STATUS.md and docs/MODULAR-DEVELOPMENT.md before changing this unfinished branch. Read relevant architecture, security, kiosk and development documentation. Read docs/UI-STANDARDS.md before dashboard presentation changes.

Use Node 24.10 or later and npm ci --no-audit. Run focused tests for changed behavior, then npm run verify:all and npm run test:browser for broader verification. Report baseline failures honestly; preserve fail-closed recovery validation and historical migrations.

Keep credentials, installation configuration, attendance and biometric data out of source, fixtures and logs. Preserve unrelated work. Inspect the diff before committing. Only ordinary CI is enabled; do not release, deploy, publish production documentation or claim V1 upgrade support from this branch.

Do not use em dashes in authored content. Use a regular hyphen with a space on each side.
