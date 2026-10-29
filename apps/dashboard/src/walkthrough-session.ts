import { walkthroughs, type WalkthroughPage } from "../../../packages/shared/src/walkthrough.ts";

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const keyFor = (userId: string, pageId: WalkthroughPage, version: number) => `lancerlogin-walkthrough-deferred:${encodeURIComponent(userId)}:${pageId}:${version}`;

export function walkthroughSessionStorage(): SessionStorage | undefined {
  try { return window.sessionStorage; } catch { return undefined; }
}

/** Temporary deferrals never change the account's saved walkthrough progress. */
export class WalkthroughSession {
  private deferred = new Set<string>();
  private userId: string;
  private storage?: SessionStorage;
  constructor(userId: string, storage?: SessionStorage) { this.userId = userId; this.storage = storage; }
  isDeferred(pageId: WalkthroughPage, version: number): boolean {
    const key = keyFor(this.userId, pageId, version);
    if (this.deferred.has(key)) return true;
    try { return this.storage?.getItem(key) === "1"; } catch { return false; }
  }
  defer(pageId: WalkthroughPage, version: number): void {
    const key = keyFor(this.userId, pageId, version);
    this.deferred.add(key);
    try { this.storage?.setItem(key, "1"); } catch { /* Keep this session's in-memory deferral. */ }
  }
  reset(pageId: WalkthroughPage, version: number): void {
    const key = keyFor(this.userId, pageId, version);
    this.deferred.delete(key);
    try { this.storage?.removeItem(key); } catch { /* Debug reset still opens the current walkthrough. */ }
  }
  clear(): void {
    this.deferred.clear();
    for (const pageId of Object.keys(walkthroughs) as WalkthroughPage[]) this.reset(pageId, walkthroughs[pageId].version);
  }
}

const setupQuietKey = "lancerlogin-walkthrough-setup-quiet";
let setupQuiet = false;

export function clearWalkthroughSession(userId: string): void {
  new WalkthroughSession(userId, walkthroughSessionStorage()).clear();
  setupQuiet = false;
  try { walkthroughSessionStorage()?.removeItem(setupQuietKey); } catch { /* Nothing to clear. */ }
}

/** Module setup ran in this browser session: page tours stop opening on their own until the next session. Saved progress is unchanged. */
export function quietWalkthroughsAfterSetup(storage: SessionStorage | undefined = walkthroughSessionStorage()): void {
  try { if (!storage) throw new Error("Session storage is unavailable"); storage.setItem(setupQuietKey, "1"); } catch { setupQuiet = true; /* Keep the choice for this page load. */ }
}
export function walkthroughsQuietAfterSetup(storage: SessionStorage | undefined = walkthroughSessionStorage()): boolean {
  if (setupQuiet) return true;
  try { return storage?.getItem(setupQuietKey) === "1"; } catch { return false; }
}
