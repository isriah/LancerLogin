# V2 development isolation

This checkout is the unfinished `codex/v2` branch of the public LancerLogin repository. See [V2 status](V2-STATUS.md) before development or testing.

Only `.github/workflows/ci.yml` is executable. Release, deployment, credential maintenance, recovery and documentation publishing workflows are inert references under `.github/disabled-workflows`, with every job guarded by `if: ${{ false }}`. Do not reactivate them for V2. No Community installer, production upgrade or V1-to-V2 migration is supported from this branch.

Checked-in Wrangler defaults are unconfigured and have no account or database binding. Development provisioning prototypes use example repository and resource pins; they require review and explicit destination configuration before use. Actual retained V2 testing configuration and provider connections belong in the private deployment controller and protected storage.

Use synthetic members, attendance and documents in isolated tests. Keep credentials, private configuration, exports and attendance records out of public commits, fixtures and ordinary logs. Community telemetry is retired, including the scheduler job and transport exception. Historical schema fields remain inert.

Use Node 24.10 or later. Run focused checks while developing, `npm run verify:all` for the complete local gate and `npm run test:browser` for browser coverage. Recovery authorizer checks must remain enabled. Local test results do not establish hosted deployment or hardware acceptance.
