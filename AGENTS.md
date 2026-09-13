# LancerLogin agent guidance

Use public `main` for stable Community V1 and `codex/v2` for unfinished Modular V2. Installation configuration belongs in an adopter-owned private deployment repository. Never publish private ancestry, credentials, attendance, biometric data, or installation-specific recovery evidence.

Read relevant documentation before changing a surface: `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/SECURITY.md`, `docs/KIOSK.md`, `docs/BACKUP-RESTORE.md`, and `docs/WEB-UPDATES.md`. For dashboard changes, read `docs/UI-STANDARDS.md` and follow its keyboard, theme and responsive checklist.

Preserve unrelated staged, unstaged and untracked work. Use a focused branch and isolate concurrent changes in Git worktrees. Run `npm ci --no-audit`, then the relevant `npm run verify:api`, `verify:dashboard`, `verify:docs`, `verify:kiosk`, or `verify:provisioning` command. Changed browser interactions also require focused `npm run test:browser -- <test-file>` coverage. Migration changes require `npm run verify:migrations`.

Review the diff and commit only intended files. Release preparation requires `npm run verify:release`, complete browser checks, and successful exact-commit public Verify CI including strict dependency audit and Linux kiosk artifact checks. Follow `docs/RELEASE-CHECKLIST.md`. Never bypass a failed release gate or rewrite applied migrations.

Release publication, live deployment, provider mutation and Pi operations require user authorization. Verify exact repository URLs, account, database name and UUID, Worker binding and environment together. Keep release and deployment separate. A cosmetic rename does not authorize copying or restoring the database. Existing database names may be fixed through `LANCERLOGIN_DATABASE_NAME`.

Do not use the retired custom LancerLogin skills, coordinator automations or work-unit ledger procedures. Do not create replacement custom skills. Use ordinary branches, review, tests, releases and the private deployment controller.

Do not use em dashes in responses or authored content. Use a spaced regular hyphen.
