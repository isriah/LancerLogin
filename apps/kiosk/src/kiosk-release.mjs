import { pathToFileURL } from 'node:url';

const latest = 'https://api.github.com/repos/isriah/LancerLogin/releases/latest';
const releases = 'https://api.github.com/repos/isriah/LancerLogin/releases?per_page=20';
function compatible(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.tag_name !== 'string' || !value.tag_name || value.tag_name.length > 128 ||
      value.draft !== undefined && typeof value.draft !== 'boolean' ||
      value.prerelease !== undefined && typeof value.prerelease !== 'boolean') throw new Error('Malformed release');
  return value.draft !== true && value.prerelease !== true && /^v0\.\d+\.\d+$/.test(value.tag_name);
}
export async function latestCompatibleInstaller({ fetchImpl = fetch, deadlineMs = 4000 } = {}) {
  const controller = new AbortController(); let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error('Release lookup timed out')); controller.abort(); }, deadlineMs); });
  try {
    return await Promise.race([(async () => {
      async function read(url) {
        const response = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'LancerLogin' }, redirect: 'manual', signal: controller.signal });
        if (!response.ok) throw new Error('Release feed unavailable');
        const reader = response.body?.getReader(); if (!reader) throw new Error('Empty release feed');
        const cancel = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        let size = 0; const chunks = [];
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1048576) throw new Error('Release feed too large'); chunks.push(value); } }
        finally { controller.signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
        controller.signal.throwIfAborted();
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      }
      let chosen = await read(latest);
      if (!compatible(chosen)) {
        const list = await read(releases);
        if (!Array.isArray(list) || list.length > 20) throw new Error('Malformed release feed');
        const eligible = list.map(compatible); // Validate the complete bounded feed.
        chosen = list[eligible.indexOf(true)];
      }
      if (!chosen || !Array.isArray(chosen.assets) || !['install-lancerlogin.sh', 'install-lancerlogin.sh.sha256'].every(name => chosen.assets.some(asset => asset?.name === name))) throw new Error('Compatible release is missing its verified installer');
      controller.signal.throwIfAborted();
      return chosen.tag_name.slice(1);
    })(), deadline]);
  } catch { throw new Error('No compatible official kiosk installer is currently available'); }
  finally { clearTimeout(timer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(await latestCompatibleInstaller()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
