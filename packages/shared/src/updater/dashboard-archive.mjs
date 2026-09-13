// Deliberately restricted deterministic ustar. Returns bytes, never writes paths.
export const DASHBOARD_LIMITS = Object.freeze({ bytes: 16777216, files: 2048, fileBytes: 8388608, pathBytes: 100 });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const check = (ok, code) => { if (!ok) throw new Error(code); };
const zeros = bytes => bytes.every(byte => byte === 0);
export function validateDashboardPath(path) {
  check(typeof path === 'string' && path.length <= DASHBOARD_LIMITS.pathBytes && /^[A-Za-z0-9_-]/.test(path) && !/[^A-Za-z0-9_./-]/.test(path) && !path.endsWith('/'), 'dashboard-path');
  const parts = path.split('/');
  check(parts.every(part => part && !part.startsWith('.') && !part.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'dashboard-path');
  check(!parts.some(part => /(?:secret|credential|private[-_]?key|^token(?:\.|$)|^id_rsa)/i.test(part)), 'dashboard-private-file');
  check(/\.(?:html|js|mjs|css|map|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|txt|json|wasm)$/.test(path) || ['_headers', '_redirects'].includes(path), 'dashboard-file-type');
  return path;
}
function header(path, size) {
  const out = new Uint8Array(512);
  const put = (at, text) => out.set(encoder.encode(text), at);
  const octal = (at, width, value) => put(at, value.toString(8).padStart(width - 1, '0') + '\0');
  put(0, path); octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0);
  octal(124, 12, size); octal(136, 12, 0); out.fill(32, 148, 156);
  put(156, '0'); put(257, 'ustar\0'); put(263, '00');
  put(148, out.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ');
  return out;
}
function acceptPath(path, seen) {
  validateDashboardPath(path);
  const key = path.toLowerCase();
  check(!seen.has(key), 'dashboard-duplicate');
  check(![...seen].some(other => key.startsWith(other + '/') || other.startsWith(key + '/')), 'dashboard-path-conflict');
  seen.add(key);
}
export function packDashboard(entries) {
  check(Array.isArray(entries) && entries.length > 0 && entries.length <= DASHBOARD_LIMITS.files, 'dashboard-files');
  const seen = new Set(); let size = 1024;
  const files = entries.map(entry => {
    acceptPath(entry.path, seen);
    check(entry.bytes instanceof Uint8Array && entry.bytes.length <= DASHBOARD_LIMITS.fileBytes, 'dashboard-file-size');
    size += 512 + Math.ceil(entry.bytes.length / 512) * 512;
    check(size <= DASHBOARD_LIMITS.bytes, 'dashboard-size');
    return { path: entry.path, bytes: Uint8Array.from(entry.bytes) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  check(files.some(file => file.path === 'index.html'), 'dashboard-index');
  const out = new Uint8Array(size); let at = 0;
  for (const file of files) { out.set(header(file.path, file.bytes.length), at); out.set(file.bytes, at + 512); at += 512 + Math.ceil(file.bytes.length / 512) * 512; }
  return out;
}
export function readDashboard(archive) {
  check(archive instanceof Uint8Array && archive.length >= 1536 && archive.length <= DASHBOARD_LIMITS.bytes && archive.length % 512 === 0, 'dashboard-size');
  const bytes = Uint8Array.from(archive), files = [], seen = new Set(); let at = 0, previous = '';
  while (at + 1024 < bytes.length) {
    check(files.length < DASHBOARD_LIMITS.files, 'dashboard-files');
    const raw = bytes.subarray(at, at + 512);
    const nameBytes = raw.subarray(0, 100), end = nameBytes.indexOf(0);
    let path;
    try { path = decoder.decode(nameBytes.subarray(0, end < 0 ? 100 : end)); } catch { throw new Error('dashboard-path'); }
    acceptPath(path, seen); check(path > previous, 'dashboard-order'); previous = path;
    const sizeText = decoder.decode(raw.subarray(124, 136));
    check(/^[0-7]{11}\0$/.test(sizeText), 'dashboard-header');
    const size = parseInt(sizeText, 8); check(size <= DASHBOARD_LIMITS.fileBytes, 'dashboard-file-size');
    const expected = header(path, size);
    check(raw.every((byte, index) => byte === expected[index]), 'dashboard-header');
    const next = at + 512 + Math.ceil(size / 512) * 512;
    check(next <= bytes.length - 1024, 'dashboard-truncated');
    check(zeros(bytes.subarray(at + 512 + size, next)), 'dashboard-padding');
    files.push(Object.freeze({ path, bytes: bytes.slice(at + 512, at + 512 + size) })); at = next;
  }
  check(at === bytes.length - 1024 && zeros(bytes.subarray(at)), 'dashboard-trailer');
  check(files.some(file => file.path === 'index.html'), 'dashboard-index');
  return Object.freeze(files);
}
