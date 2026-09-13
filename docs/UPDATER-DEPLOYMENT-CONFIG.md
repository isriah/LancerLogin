# Offline updater deployment review package

WU201 generates configuration for the WU199 Worker artifact. It creates local files only; it does not deploy, provision a database, install secrets, edit application configuration, initialize state, or enable public routing.

Run `node scripts/generate-updater-deployment.mjs --input <trusted-input.json> --output <new-directory>`. The parent directory must already exist. The exact input keys are `updaterWorkerName`, `compatibilityDate` (a real YYYY-MM-DD date), and `config`. `config` is the existing strict WU199 object with `format`, `pins`, `trust`, and optional `fencePolicy`. Input JSON is bounded to 128 KiB and rejects duplicate keys. The updater Worker name must differ from the application Worker; a supplied fence policy must name this updater as its maintenance service.

Validation invokes both the Worker configuration decoder and full runtime constructor with distinct inert database objects, synthetic secrets and a fetch function that throws. No initialize or runtime operation is invoked. Constructor I/O would fail rather than contact a provider. The input must contain public trust and nonsecret configuration only; this tool has no secret-value input fields. Plain-text binding values remain the operator's responsibility to classify correctly, as elsewhere in the runtime's trusted configuration contract.

The atomically claimed new output directory contains:

- `updater.mjs`: the generic WU199 offline bundle, with no installation values injected.
- `wrangler.json`: pinned updater Worker name, account and three distinct database IDs, compatibility date, exact serialized `UPDATER_CONFIG`, and `workers_dev: false` / `preview_urls: false`. No public routes are generated.
- `application-bindings.review.json`: an application configuration fragment with `UPDATER` targeting `ApplicationUpdates`, `MAINTENANCE` targeting `MaintenanceLifecycle`, and both installation-ID variables. This is a review fragment, not a replacement application configuration.
- `required-secrets.review.json`: six required updater secret names plus application HMAC-name mappings. `UPDATER_APP_KEY` must share the value of updater `APP_HMAC`; `MAINTENANCE_APP_KEY` must share the value of updater `MAINTENANCE_HMAC`. These two pairs must remain distinct. No values are included.

Existing output directories are never reused or overwritten. A failed build/write may leave an incomplete directory; review it and choose a new directory for another attempt. No cleanup/reset is automatic.

Before any separately authorized deployment, review the generated binding fragment against the existing complete application configuration, including scheduler and compute bindings. Bindings and variables in Wrangler configuration are not an additive patch automatically applied by this tool. The intended application service bindings must also match the bootstrap-owned `pins.nonsecretBindings` and any writer-fence adoption records; generating a fragment does not rewrite those records or prove an adoption. Existing state migrations, actual database identity and resource ownership, independent secret custody/installation, and the private resumable initialization procedure remain prerequisites. No migrations directory is supplied for the three databases because their schema ownership is different; blindly applying one database's migrations to all three is not supported.

The public recovery hostname/custom-domain route must be separately provisioned to match `pins.recoveryOrigin`. With workers.dev, previews and routes disabled, the generated configuration deliberately supplies no public endpoint. Provisioning and positive deployed-writer adoption remain externally verified prerequisites. The package does not establish hosted CPU/query budgets, initialization success, recovery readiness, or updater self-upgrade readiness.

## Focused evidence

`node --test tests/updater-deployment-config.test.mjs` passed one focused test in 1.243 seconds on the WU201 base. It checks malformed or conflicting input, full constructor validation, exact IDs and named targets, secret-name mappings, synthetic-secret absence, and refusal to overwrite. The 869,331-byte generic bundle was generated using the existing build tool. Installed Wrangler's `unstable_readConfig` parsed and normalized the generated configuration successfully; this is its local validation path, not a deployment or network-enabled dry-run. No provider credentials, hosted calls, dependency changes, or resource mutations were used.
