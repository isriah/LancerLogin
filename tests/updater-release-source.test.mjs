import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createGitHubReleaseSource } from '../apps/updater/github-release-source.mjs';
import { sha256, signedBytes } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard } from '../packages/shared/src/updater/dashboard-archive.mjs';
const encode = text => new TextEncoder().encode(text);
const token = 'synthetic-read-only-token';
const pair = generateKeyPairSync('ed25519');
const pins = { product: 'LancerLogin', channel: 'development', repository: { id: 123, owner: 'synthetic', name: 'release-test' }, keyId: 'synthetic-key', publicKey: new Uint8Array(Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url')) };
const base = 'https://api.github.com/repos/synthetic/release-test';
const installed = { version: '1.0.0', schema: 0, updaterVersion: '1.0.0', highestSequence: 1, ledger: [] };
async function fixture(sequence = 2, dashboard = null, migrationCount = 0) {
  const files = new Map([['api.mjs', encode('export default {fetch(){return new Response("synthetic");}};')], ['dashboard.tar', dashboard ?? packDashboard([{ path: 'index.html', bytes: encode('<!doctype html><title>Synthetic</title>') }])]]);
  for (let index = 1; index <= migrationCount; index++) files.set(`${String(index).padStart(4, '0')}_synthetic.sql`, encode(`CREATE TABLE synthetic_${index}(id INTEGER);`));
  const manifest = {
    format: 1, kind: 'application', product: pins.product, channel: pins.channel, repository: pins.repository, keyId: pins.keyId,
    sequence, version: `1.${sequence}.0`, sourceCommit: 'a'.repeat(40), minimumUpdaterVersion: '1.0.0',
    compatibility: { installedVersion: { min: '1.0.0', max: '1.0.0' }, installedSchema: { min: 0, max: 0 }, apiVersion: 1, apiSchema: { min: 0, max: migrationCount }, frontendApi: { min: 1, max: 1 } },
    targetSchema: migrationCount, codeRollback: 'compatible', artifacts: [], migrations: [],
  };
  for (const [name, bytes] of files) {
    const digest = await sha256(bytes);
    manifest.artifacts.push({ role: name === 'api.mjs' ? 'api' : name.endsWith('.tar') ? 'dashboard' : 'migration', name, bytes: bytes.length, sha256: digest });
    if (name.endsWith('.sql')) manifest.migrations.push({ id: name, fromSchema: manifest.migrations.length, toSchema: manifest.migrations.length + 1, artifact: name, sha256: digest });
  }
  const manifestBytes = encode(JSON.stringify(manifest)); files.set('manifest.json', manifestBytes); files.set('manifest.sig', new Uint8Array(sign(null, signedBytes(manifestBytes), pair.privateKey)));
  const id = sequence * 100;
  const assets = [...files].map(([name, bytes], index) => ({ id: id + index + 1, name, size: bytes.length, state: 'uploaded', url: 'https://evil.invalid/do-not-use', browser_download_url: 'https://evil.invalid/do-not-use' }));
  return { manifest, files, assets, release: { id, immutable: true, draft: false, prerelease: false, published_at: '2026-09-01T00:00:00Z', tag_name: `v${manifest.version}` } };
}
function transport(fixtures, override = () => null) {
  const calls = [], json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init) => {
    calls.push({ url, init }); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
    if (url.startsWith('https://api.github.com/')) assert.equal(init.headers.Authorization, `Bearer ${token}`);
    else assert.equal(init.headers.Authorization, undefined);
    const changed = await override(url, init); if (changed) return changed;
    if (url === base) return json({ id: pins.repository.id, owner: { login: pins.repository.owner }, name: pins.repository.name, private: true });
    if (url === `${base}/releases?per_page=30&page=1`) return json(fixtures.map(f => f.release));
    for (const f of fixtures) {
      if (url === `${base}/releases/${f.release.id}`) return json(f.release);
      const assetPage = `${base}/releases/${f.release.id}/assets?per_page=30&page=`;
      if (url.startsWith(assetPage)) { const page = Number(url.slice(assetPage.length)); return json(f.assets.slice((page - 1) * 30, page * 30)); }
      for (const asset of f.assets) if (url === `${base}/releases/assets/${asset.id}`) return new Response(f.files.get(asset.name));
    }
    throw new Error('Synthetic unexpected request');
  };
  return { fetch, calls, json };
}
async function availability(source, state) {
  let result = await source.available(state);
  while (result.status === 'checking') result = await source.available(state, JSON.parse(JSON.stringify(result.progress)));
  return result;
}
test('private immutable release resolves signed bytes, discovers highest compatible release and resumes exact identity', async () => {
  const f = await fixture(), next = await fixture(3), http = transport([f, next]);
  const source = createGitHubReleaseSource({ pins, token, fetch: http.fetch });
  assert.deepEqual(await source.candidates(), [200, 300]);
  const available = await availability(source, installed); assert.equal(available.sequence, 3); assert.equal(available.identity.releaseId, 300);
  const handle = await source.resolve(200);
  assert.equal(handle.identity.repository.id, 123); assert.equal(handle.identity.assets.length, 4);
  assert.deepEqual(await source.download(handle, 'api.mjs'), f.files.get('api.mjs'));
  assert.deepEqual(await source.download(handle, 'dashboard.tar'), f.files.get('dashboard.tar'));
  const persisted = JSON.parse(JSON.stringify(handle.identity));
  assert.deepEqual((await source.resume(persisted)).identity, handle.identity);
  persisted.assets[0].id++; await assert.rejects(source.resume(persisted), /source-checkpoint/);
  await assert.rejects(source.download({ ...handle }, 'api.mjs'), /source-handle/);
  assert.ok(!JSON.stringify(handle.identity).includes(token)); assert.ok(!JSON.stringify(handle.identity).includes('https:'));
  assert.equal((await availability(source, { ...installed, highestSequence: 9 })).status, 'no-compatible-release');
  assert.ok(http.calls.every(call => !call.url.includes('/latest') && !call.url.includes('evil.invalid')));
});
test('wrong numeric repository, mutable release and missing asset membership fail closed', async () => {
  const f = await fixture();
  const wrong = transport([f], url => url === base ? new Response(JSON.stringify({ id: 999, owner: { login: 'synthetic' }, name: 'release-test', private: true })) : null);
  await assert.rejects(createGitHubReleaseSource({ pins, token, fetch: wrong.fetch }).resolve(200), /source-repository/); assert.equal(wrong.calls.length, 1);
  f.release.immutable = false;
  await assert.rejects(createGitHubReleaseSource({ pins, token, fetch: transport([f]).fetch }).resolve(200), /source-release/);
  f.release.immutable = true; f.assets.pop();
  await assert.rejects(createGitHubReleaseSource({ pins, token, fetch: transport([f]).fetch }).resolve(200), /source-assets/);
});
test('redirect transport strips authorization and refuses foreign hosts, API redirects and redirect chains', async () => {
  const f = await fixture(), apiAsset = f.assets.find(asset => asset.name === 'api.mjs');
  let destination = `https://release-assets.githubusercontent.com/synthetic?id=${apiAsset.id}&signature=synthetic-only`, secondRedirect = false;
  const http = transport([f], url => {
    if (url === `${base}/releases/assets/${apiAsset.id}`) return new Response(null, { status: 302, headers: { location: destination } });
    if (url.startsWith('https://release-assets.githubusercontent.com/')) return secondRedirect ? new Response(null, { status: 302, headers: { location: destination } }) : new Response(f.files.get('api.mjs'));
    return null;
  });
  const source = createGitHubReleaseSource({ pins, token, fetch: http.fetch }), handle = await source.resolve(200);
  await source.download(handle, 'api.mjs');
  const cdn = http.calls.find(call => call.url === destination);
  assert.deepEqual(cdn.init.headers, { Accept: 'application/octet-stream' }); assert.equal(cdn.init.referrerPolicy, 'no-referrer');
  secondRedirect = true; await assert.rejects(source.download(handle, 'api.mjs'), /source-redirect/);
  for (const bad of ['https://evil.invalid/x', 'http://release-assets.githubusercontent.com/x', 'https://user:pass@release-assets.githubusercontent.com/x', 'https://release-assets.githubusercontent.com:444/x']) {
    destination = bad; await assert.rejects(source.download(handle, 'api.mjs'), /source-redirect/); assert.ok(http.calls.every(call => call.url !== bad));
  }
  const redirected = transport([f], url => url === base ? new Response(null, { status: 301, headers: { location: 'https://evil.invalid/repo' } }) : null);
  await assert.rejects(createGitHubReleaseSource({ pins, token, fetch: redirected.fetch }).resolve(200), /source-unavailable/); assert.equal(redirected.calls.length, 1);
});
test('downloads enforce stream limits before aggregation, reject tampering and validate even correctly signed unsafe tar', async () => {
  const f = await fixture(), apiAsset = f.assets.find(asset => asset.name === 'api.mjs'); let mode = 'normal', cancelled = false;
  const http = transport([f], url => {
    if (url !== `${base}/releases/assets/${apiAsset.id}` || mode === 'normal') return null;
    if (mode === 'oversize') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(apiAsset.size + 1)); }, cancel() { cancelled = true; } }));
    const modified = f.files.get('api.mjs').slice(); modified[0] ^= 1; return new Response(modified);
  });
  const source = createGitHubReleaseSource({ pins, token, fetch: http.fetch }), handle = await source.resolve(200);
  mode = 'oversize'; await assert.rejects(source.download(handle, 'api.mjs'), /source-size/); assert.equal(cancelled, true);
  mode = 'tampered'; await assert.rejects(source.download(handle, 'api.mjs'), /source-artifact/);
  const invalid = await fixture(4, new Uint8Array(2048)), badSource = createGitHubReleaseSource({ pins, token, fetch: transport([invalid]).fetch });
  await assert.rejects(badSource.download(await badSource.resolve(400), 'dashboard.tar'), /source-archive/);
});
test('bad signatures cannot appear as available, and deadline/error messages never expose provider content', async () => {
  const f = await fixture(); f.files.get('manifest.sig')[0] ^= 1;
  const source = createGitHubReleaseSource({ pins, token, fetch: transport([f]).fetch });
  await assert.rejects(source.resolve(200), /source-signature/);
  assert.equal((await source.available(installed)).status, 'no-compatible-release');
  const stalled = createGitHubReleaseSource({ pins, token, deadlineMs: 5, fetch: () => new Promise(() => {}) });
  await assert.rejects(stalled.resolve(200), error => error.message === 'source-deadline');
  const failed = createGitHubReleaseSource({ pins, token, fetch: () => { throw new Error('Private upstream details must not escape'); } });
  await assert.rejects(failed.resolve(200), error => error.message === 'source-unavailable');
});

test('30 realistic schema49 releases discover incrementally within request budget and bind progress to installed state', async () => {
  const fixtures = [];
  for (let sequence = 2; sequence < 32; sequence++) {
    const f = await fixture(sequence, null, 49);
    // GitHub embeds full asset records in each release, including verbose metadata.
    f.release.assets = f.assets.map(asset => ({ ...asset, uploader: { login: 'synthetic', avatar_url: 'https://example.invalid/' + 'x'.repeat(1024) } }));
    fixtures.push(f);
  }
  assert.ok(encode(JSON.stringify(fixtures.map(f => f.release))).length > 131072);
  const http = transport(fixtures), source = createGitHubReleaseSource({ pins, token, fetch: http.fetch });
  let result, progress = null, iterations = 0;
  do {
    const before = http.calls.length;
    result = await source.available(installed, progress); iterations++;
    assert.ok(http.calls.length - before <= 14, 'one direct-download invocation stays below Free request allowance');
    if (iterations < 30) assert.equal(result.status, 'checking');
    if (result.status === 'checking') {
      assert.equal(result.checked, iterations); assert.equal(result.total, 30);
      progress = JSON.parse(JSON.stringify(result.progress));
      if (iterations === 1) await assert.rejects(source.available({ ...installed, highestSequence: 2 }, progress), /source-checkpoint/);
    }
  } while (result.status === 'checking');
  assert.equal(iterations, 30); assert.equal(result.status, 'available'); assert.equal(result.sequence, 31);
  assert.equal(http.calls.filter(call => call.url === `${base}/releases?per_page=30&page=1`).length, 1);
  assert.ok(http.calls.some(call => call.url.includes('/assets?per_page=30&page=2')));
});
