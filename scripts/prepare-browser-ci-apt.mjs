import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// This repository tests Playwright's bundled Chromium, not the runner's Chrome.
// Never relax apt's signature or checksum checks to work around an index outage.
export function filterChromeSource(text, format) {
  const target = 'https://dl.google.com/linux/chrome-stable/deb';
  if (!text.includes(target)) return text;
  if (format === '.sources') return text.split(/((?:\r?\n)[\t ]*(?:\r?\n))/).map((stanza) => {
    const lines = stanza.split(/\r?\n/);
    if (!lines.some(line => !line.trimStart().startsWith('#') && line.includes(target))) return stanza;
    const fields = new Map(); let current;
    for (const line of lines) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      if (/^[\t ]/.test(line)) {
        if (!current) throw new Error('Unexpected Chrome apt stanza continuation.');
        fields.set(current, fields.get(current) + ' ' + line.trim()); continue;
      }
      const match = /^([A-Za-z][A-Za-z0-9-]*):[\t ]*(.*)$/.exec(line);
      if (!match || fields.has(match[1].toLowerCase())) throw new Error('Unexpected Chrome apt stanza field.');
      current = match[1].toLowerCase(); fields.set(current, match[2].trim());
    }
    if (!/^https:\/\/dl\.google\.com\/linux\/chrome-stable\/deb\/?$/.test(fields.get('uris') ?? '') ||
        fields.get('types') !== 'deb' || fields.get('suites') !== 'stable' || fields.get('components') !== 'main' ||
        fields.has('enabled') && !['yes', 'no'].includes(fields.get('enabled'))) {
      throw new Error('Unexpected Chrome apt stanza identity; review runner image.');
    }
    if (fields.get('enabled') === 'no') return stanza;
    if (fields.has('enabled')) return stanza.replace(/^Enabled:[^\r\n]*/im, 'Enabled: no');
    const newline = stanza.includes('\r\n') ? '\r\n' : '\n';
    return `Enabled: no${newline}${stanza}`;
  }).join('');
  if (format !== '.list') throw new Error('Unexpected Chrome apt source format; review runner image.');
  return text.split('\n').map((line) => {
    if (line.trimStart().startsWith('#') || !line.includes(target)) return line;
    if (!/^\s*deb\s+(?:\[[^\]\r\n]+\]\s+)?https:\/\/dl\.google\.com\/linux\/chrome-stable\/deb\/?\s+stable\s+main\s*(?:#.*)?$/.test(line)) {
      throw new Error('Unexpected Chrome apt source entry; review runner image.');
    }
    return `# Disabled for ephemeral Playwright CI only: ${line}`;
  }).join('\n');
}

export function assertHostedUbuntu({ platform, env, osRelease }) {
  if (platform !== 'linux' || env.GITHUB_ACTIONS !== 'true' ||
      env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Linux' ||
      !/^ID=(?:ubuntu|"ubuntu")$/m.test(osRelease)) {
    throw new Error('Chrome apt preparation is restricted to GitHub-hosted Ubuntu CI.');
  }
}

async function main() {
  assertHostedUbuntu({ platform: process.platform, env: process.env,
    osRelease: await readFile('/etc/os-release', 'utf8') });
  const directory = '/etc/apt/sources.list.d';
  const names = await readdir(directory);
  if (names.length > 100) throw new Error('Unexpected apt source count.');
  const paths = ['/etc/apt/sources.list', ...names.filter((name) => /\.(list|sources)$/.test(name)).map((name) => `${directory}/${name}`)];
  const edits = [];
  // Validate every source before changing any file. Unknown formats fail closed.
  for (const path of paths) {
    let stat;
    try { stat = await lstat(path); } catch (error) {
      if (error.code === 'ENOENT' && path === '/etc/apt/sources.list') continue;
      throw error;
    }
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error('Unexpected apt source file.');
    const before = await readFile(path, 'utf8');
    const after = filterChromeSource(before, path.endsWith('.list') ? '.list' : '.sources');
    if (after !== before) edits.push({ path, after });
  }
  for (const { path, after } of edits) await writeFile(path, after);
  console.log(`Prepared Playwright CI apt sources: ${edits.length} Chrome source files disabled.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
