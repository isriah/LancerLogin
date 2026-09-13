import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { verifyBundle } from './development-bundle.mjs';

// Execute the actual immutable built dashboard against a loopback-only mocked API.
// No source transforms, provider traffic, credentials, personal data, or screenshots.
const [identityPath, bundlePath, digest] = process.argv.slice(2);
let server, browser, stage = 'artifact validation';
try {
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  await verifyBundle(bundlePath, digest, identity);
  const pages = resolve(bundlePath, 'pages');
  const requests = [], external = [];
  let configured = false;
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    requests.push(path);
    if (path === '/api/setup/status') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ configured, installation: { authMode: 'local' } }));
      return;
    }
    if (path === '/api/auth/session') { response.writeHead(401, { 'content-type': 'application/json' }); response.end('{}'); return; }
    const file = resolve(pages, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(pages + '/') && !file.startsWith(pages + '\\')) { response.writeHead(404); response.end(); return; }
    try {
      const body = await readFile(file);
      response.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2' })[extname(file)] ?? 'application/octet-stream');
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  stage = 'browser startup';
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { external.push('blocked external request'); return route.abort(); }
    return route.continue();
  });
  stage = 'hosted first-Admin setup';
  await page.goto(origin);
  await expect(page.getByLabel('One-time setup code')).toBeVisible();
  await expect(page.getByText('Local preview · no cloud linked')).toHaveCount(0);
  if (!requests.includes('/api/setup/status')) throw new Error('Built dashboard did not request hosted setup status');
  stage = 'hosted configured sign-in';
  configured = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  if (!requests.includes('/api/auth/session') || external.length) throw new Error('Built dashboard violated same-origin hosted authentication');
  console.log(JSON.stringify({ verification: 'local-built-dashboard-with-mock-api', hostedSetup: true, hostedSignIn: true, externalRequests: 0 }));
} catch {
  console.error(`Built development dashboard acceptance failed at ${stage}; no provider deployment was tested.`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
