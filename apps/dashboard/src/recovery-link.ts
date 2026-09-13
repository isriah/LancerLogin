const key = () => `lancerlogin-recovery-origin-v1:${location.origin}`;
export function normalizedRecoveryLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/recovery' && value === `${url.origin}/recovery`) return value; } catch { /* Ignore malformed cached hints. */ }
}
export function savedRecoveryLink() { try { return normalizedRecoveryLink(sessionStorage.getItem(key())); } catch { return; } }
export function rememberRecoveryLink(value: unknown) { const link = normalizedRecoveryLink(value); if (link) { try { sessionStorage.setItem(key(), link); } catch { /* Navigation still works without storage. */ } } return link; }
