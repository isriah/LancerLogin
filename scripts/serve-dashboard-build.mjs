// Builds the dashboard for production and serves it with `vite preview`, for the browser tests (playwright.config.ts
// uses it in CI and with `npm run test:browser -- --server build`).
//
//   VITE_API_BASE_URL=<mock API> node scripts/serve-dashboard-build.mjs --port <port>
//
// The build bakes in VITE_API_BASE_URL, so it runs at server start with this run's mock API address, after the runner
// has composed any plugins into the checkout. It calls Vite directly: the dashboard's `build` script also runs `tsc` and
// check-module-composition, which Verify runs separately. vite preview falls back to index.html for app routes.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(workspace, "apps", "dashboard");
const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
if (portIndex < 0 || !Number.isInteger(port) || port < 1_024 || port > 65_535) throw new Error("Usage: node scripts/serve-dashboard-build.mjs --port <port>");
if (!process.env.VITE_API_BASE_URL) throw new Error("Set VITE_API_BASE_URL to the API the build should call");
// One folder per port, so parallel runs in other checkouts or on other port bases never share a build.
const outDir = join(workspace, "node_modules", ".cache", "lancerlogin-dashboard-build", String(port));

const vite = await import(pathToFileURL(createRequire(join(root, "package.json")).resolve("vite")).href);
const started = performance.now();
await vite.build({ root, logLevel: "warn", build: { outDir, emptyOutDir: true } });
console.log(`Built the dashboard in ${((performance.now() - started) / 1000).toFixed(1)} s for ${process.env.VITE_API_BASE_URL}`);
const server = await vite.preview({ root, logLevel: "warn", build: { outDir }, preview: { host: "127.0.0.1", port, strictPort: true } });
console.log(`Serving the dashboard build at ${server.resolvedUrls?.local?.join(" ") ?? `http://127.0.0.1:${port}`}`);
