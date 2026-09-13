import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterChromeSource, assertHostedUbuntu } from '../scripts/prepare-browser-ci-apt.mjs';

const chrome = 'deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] https://dl.google.com/linux/chrome-stable/deb/ stable main';
test('disables only the exact unrelated Chrome source, retaining Ubuntu and other providers', () => {
  const other = 'deb https://archive.ubuntu.com/ubuntu noble main\n# comment\ndeb https://packages.microsoft.com/repos/code stable main\n';
  const output = filterChromeSource(other + chrome + '\n', '.list');
  assert.equal(output, other + '# Disabled for ephemeral Playwright CI only: ' + chrome + '\n');
  assert.equal(filterChromeSource(output, '.list'), output);
  assert.equal(filterChromeSource(other, '.list'), other);
  assert.equal(filterChromeSource('Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\n', '.sources'), 'Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\n');
});
test('unexpected matching source formats and entries fail closed', () => {
  for (const value of [chrome.replace('stable main', 'beta main'), chrome.replace('deb [', 'deb-src ['), chrome.replace('/deb/', '/deb/evil')]) {
    assert.throws(() => filterChromeSource(value, '.list'), /Unexpected/);
  }
  assert.throws(() => filterChromeSource(`URIs: https://dl.google.com/linux/chrome-stable/deb`, '.sources'), /identity/);
});
test('deb822 disables only the exact Chrome stanza, preserving signing settings and unrelated stanzas', () => {
  const target = 'Types: deb\nURIs: https://dl.google.com/linux/chrome-stable/deb/\nSuites: stable\nComponents: main\nArchitectures: amd64\nSigned-By: /usr/share/keyrings/google.gpg';
  const other = 'Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\nComponents: main universe';
  const input = other + '\n\n' + target + '\n\n' + other + '\n';
  const expected = other + '\n\nEnabled: no\n' + target + '\n\n' + other + '\n';
  assert.equal(filterChromeSource(input, '.sources'), expected);
  assert.equal(filterChromeSource(expected, '.sources'), expected);
  assert.equal(filterChromeSource('Enabled: yes\n'+target, '.sources'), 'Enabled: no\n'+target);
  assert.equal(filterChromeSource(target.replaceAll('\n','\r\n'), '.sources'), 'Enabled: no\r\n'+target.replaceAll('\n','\r\n'));
  for (const bad of [target.replace('/deb/', '/deb/ https://archive.ubuntu.com/ubuntu'), target.replace('Types: deb','Types: deb deb-src'), target.replace('Suites: stable','Suites: stable beta'), target.replace('Components: main','Components: main extra'), target+'\nURIs: https://foreign.test', target.replace('/deb/','/deb/evil'), 'Enabled: perhaps\n'+target]) {
    assert.throws(() => filterChromeSource(bad, '.sources'), /Unexpected/);
  }
  assert.equal(filterChromeSource('# https://dl.google.com/linux/chrome-stable/deb\n'+other, '.sources'), '# https://dl.google.com/linux/chrome-stable/deb\n'+other);
});
test('refuses local hosts, self-hosted runners and non-Ubuntu systems', () => {
  const valid = { platform: 'linux', env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux' }, osRelease: 'ID=ubuntu\n' };
  assert.doesNotThrow(() => assertHostedUbuntu(valid));
  for (const patch of [{ platform: 'win32' }, { env: {} }, { env: { ...valid.env, RUNNER_ENVIRONMENT: 'self-hosted' } }, { osRelease: 'ID=debian\n' }]) {
    assert.throws(() => assertHostedUbuntu({ ...valid, ...patch }), /restricted/);
  }
});
test('workflow retains full browser dependencies and unfiltered test suite', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,RUNNER_OS/);
  assert.ok(workflow.indexOf('scripts/prepare-browser-ci-apt.mjs') < workflow.indexOf('npx playwright install --with-deps chromium'));
  assert.match(workflow, /run: npm run test:browser\s*$/);
  assert.doesNotMatch(workflow, /allow-unauthenticated|AllowInsecure|Check-Valid-Until|continue-on-error/);
});
