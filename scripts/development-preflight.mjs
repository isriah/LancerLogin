import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEVELOPMENT_REPOSITORY = "example/LancerLogin";
export const DEVELOPMENT_PREFIX = "lancerlogin-v2-example";
export const DEVELOPMENT_RESOURCES = Object.freeze([
  Object.freeze({ kind: "worker", name: `${DEVELOPMENT_PREFIX}-api` }),
  Object.freeze({ kind: "pages", name: `${DEVELOPMENT_PREFIX}-dashboard` }),
  Object.freeze({ kind: "d1", name: `${DEVELOPMENT_PREFIX}-data` }),
  Object.freeze({ kind: "d1", name: `${DEVELOPMENT_PREFIX}-updater-state` }),
]);
const paths = { worker: "workers/scripts", pages: "pages/projects", d1: "d1/database" };
const pageSizes = { worker: 100, pages: 10, d1: 100 };
const accountPattern = /^[a-f0-9]{32}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const placeholder = 'export default { fetch() { return new Response("Development bootstrap pending", { status: 503 }); } };';

export class DevelopmentPreflightError extends Error {
  constructor(message, resources = []) {
    super(message);
    this.name = "DevelopmentPreflightError";
    this.resources = resources;
  }
}
function fail(message) { throw new DevelopmentPreflightError(message); }

function validateContext({ repository, expectedAccountId, env, mode }) {
  if (repository !== DEVELOPMENT_REPOSITORY) fail("Only the approved development repository is accepted");
  if (!["report", "create"].includes(mode)) fail("Mode must be report or create");
  if (!accountPattern.test(expectedAccountId ?? "") || !accountPattern.test(env.CLOUDFLARE_ACCOUNT_ID ?? "")) {
    fail("Supply the approved account separately and set CLOUDFLARE_ACCOUNT_ID");
  }
  if (expectedAccountId !== env.CLOUDFLARE_ACCOUNT_ID) fail("Credential account does not match the approved account");
  if (typeof env.CLOUDFLARE_API_TOKEN !== "string" || !/^cfat_[A-Za-z0-9_-]+$/.test(env.CLOUDFLARE_API_TOKEN)) {
    fail("Set CLOUDFLARE_API_TOKEN to a scoped Account API Token through secure setup");
  }
}

// Intentionally private: callers cannot pass arbitrary API paths, methods, or bodies.
function cloudflareAdapter(accountId, token, fetchImpl) {
  async function request(path, method = "GET", body) {
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${token}`, accept: "application/json",
          ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      });
      if (!response.ok) fail("Cloudflare request failed; check access and rerun report before further creation");
      const document = await response.json();
      if (document?.success !== true) fail("Cloudflare returned an unsuccessful response");
      return document;
    } catch {
      // Neither response text nor thrown provider/fetch messages are safe to log.
      fail("Cloudflare request failed; check access and rerun report before further creation");
    }
  }
  return {
    async verify() {
      const document = await request("tokens/verify");
      if (document.result?.status !== "active") fail("Account token is not active for the approved account");
    },
    async list(kind) {
      const entries = [];
      const pageSize = pageSizes[kind];
      for (let page = 1; page <= 100; page++) {
        const document = await request(`${paths[kind]}?page=${page}&per_page=${pageSize}`);
        if (!Array.isArray(document.result) || document.result.some((entry) =>
          !entry || typeof entry !== "object" || typeof entry[kind === "worker" ? "id" : "name"] !== "string" || !entry[kind === "worker" ? "id" : "name"])) {
          fail("Cloudflare inventory is malformed");
        }
        entries.push(...document.result);
        const total = document.result_info?.total_pages;
        if (total !== undefined) {
          if (!Number.isSafeInteger(total) || total < 0 || total > 100 || (total === 0 && entries.length)) {
            fail("Cloudflare pagination is malformed or exceeds the inventory limit");
          }
          if (page >= total) return entries;
        } else if (document.result.length < pageSize) return entries;
      }
      fail("Cloudflare inventory exceeds the page limit; absence cannot be established");
    },
    async create(target) {
      if (target.kind === "worker") {
        const body = new FormData();
        body.set("metadata", JSON.stringify({ main_module: "bootstrap.mjs", compatibility_date: "2026-08-01", bindings: [] }));
        body.set("bootstrap.mjs", new Blob([placeholder], { type: "application/javascript+module" }), "bootstrap.mjs");
        return (await request(`${paths.worker}/${target.name}`, "PUT", body)).result;
      }
      const body = target.kind === "pages" ? { name: target.name, production_branch: "main" } : { name: target.name };
      return (await request(paths[target.kind], "POST", body)).result;
    },
  };
}

function sanitizeResource(target, entry, accountId) {
  if (!entry || typeof entry !== "object") fail("Cloudflare resource record is malformed");
  const name = target.kind === "worker" ? entry.id : entry.name;
  if (name !== target.name) fail("Cloudflare returned the wrong development resource");
  if ([entry.account_id, entry.account?.id].some((value) => value !== undefined && value !== accountId)) {
    fail("Cloudflare returned a resource in the wrong account");
  }
  const id = target.kind === "d1" ? entry.uuid : entry.id;
  if (target.kind === "worker" ? id !== target.name : typeof id !== "string" || !uuidPattern.test(id)) {
    fail("Cloudflare returned a missing or invalid development resource ID");
  }
  return { ...target, state: "exists", id };
}

async function inventory(adapter, accountId) {
  const lists = {};
  for (const kind of Object.keys(paths)) lists[kind] = await adapter.list(kind);
  return DEVELOPMENT_RESOURCES.map((target) => {
    const matches = lists[target.kind].filter((entry) => (target.kind === "worker" ? entry?.id : entry?.name) === target.name);
    if (matches.length > 1) fail("Duplicate development resource names prevent safe provisioning");
    return matches.length ? sanitizeResource(target, matches[0], accountId) : { ...target, state: "missing" };
  });
}

export async function developmentPreflight({ repository, expectedAccountId, env = process.env, mode = "report", fetchImpl = fetch }) {
  validateContext({ repository, expectedAccountId, env, mode });
  const adapter = cloudflareAdapter(expectedAccountId, env.CLOUDFLARE_API_TOKEN, fetchImpl);
  await adapter.verify();
  const resources = await inventory(adapter, expectedAccountId);
  if (mode === "report") return { repository, mode, resources };
  if (resources.some((resource) => resource.state === "exists")) {
    throw new DevelopmentPreflightError("Development resource collision; create never adopts or replaces existing resources", resources);
  }
  const created = [];
  try {
    for (const target of DEVELOPMENT_RESOURCES) {
      // Cloudflare's Worker PUT is not atomic create-only. Provision exclusively;
      // this last check reduces, but cannot eliminate, an external concurrent race.
      const current = await inventory(adapter, expectedAccountId);
      if (current.some((resource) => resource.state === "exists" && !created.some((owned) => owned.kind === resource.kind && owned.id === resource.id && owned.name === resource.name))) {
        fail("Development resource collision appeared during creation");
      }
      if (created.some((owned) => !current.some((resource) => resource.kind === owned.kind && resource.id === owned.id && resource.name === owned.name))) {
        fail("Previously created resource identity changed; rerun report");
      }
      const result = await adapter.create(target);
      created.push(sanitizeResource(target, result, expectedAccountId));
    }
    const verified = await inventory(adapter, expectedAccountId);
    if (created.some((resource) => !verified.some((item) => item.kind === resource.kind && item.name === resource.name && item.id === resource.id))) {
      fail("Created resource identity could not be verified; rerun report");
    }
    return { repository, mode, resources: verified };
  } catch (error) {
    throw new DevelopmentPreflightError(error instanceof DevelopmentPreflightError ? error.message : "Development creation failed; rerun report", created);
  }
}

export function parseDevelopmentArguments(args) {
  const options = { mode: "report" };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) fail("Duplicate development preflight argument");
    seen.add(flag);
    if (flag === "--create") options.mode = "create";
    else if (["--repository", "--expected-account"].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) fail("Missing development preflight argument");
      options[flag === "--repository" ? "repository" : "expectedAccountId"] = value;
    } else fail("Unsupported development preflight argument");
  }
  return options;
}

function verifyCheckout() {
  let remote;
  try { remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { fail("Could not verify development checkout origin"); }
  if (![`https://github.com/${DEVELOPMENT_REPOSITORY}.git`, `git@github.com:${DEVELOPMENT_REPOSITORY}.git`].includes(remote)) {
    fail("Checkout origin must be the approved development repository");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseDevelopmentArguments(process.argv.slice(2));
    verifyCheckout();
    console.log(JSON.stringify(await developmentPreflight(options), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof DevelopmentPreflightError ? error.message : "Development preflight failed",
      resources: error instanceof DevelopmentPreflightError ? error.resources : [] }));
    process.exitCode = 1;
  }
}
