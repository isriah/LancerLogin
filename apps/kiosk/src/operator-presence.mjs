const modes = new Set(["attendance", "maintenance", "network", "sync", "review", "desktop"]);

// Presence is local UI state, never PIN authorization or cloud connectivity.
// Network time can jump after an offline boot. Leases measure elapsed time so
// clock recovery cannot expire an actively renewing attendance screen.
export function createOperatorPresence({ now = () => performance.now(), leaseMs = 15_000, onSuspend = () => undefined, restored } = {}) {
  const pages = new Map();
  let generation = 0, lost = true;
  if (restored) {
    generation = restored.generation; lost = restored.lost;
    for (const page of restored.pages) pages.set(page.pageId, { mode: page.mode, generation: page.generation, until: now() + page.remainingMs });
  }
  function expire() {
    for (const [id, page] of pages) if (page.until <= now()) {
      pages.delete(id);
      if (page.mode !== "attendance" || !pages.size) { lost = true; onSuspend(); }
    }
  }
  function status() {
    expire();
    const operator = [...pages.values()].some(page => page.mode !== "attendance");
    const captureSuspended = lost || operator || !pages.size;
    return { captureSuspended, reason: operator ? "operator_active" : captureSuspended ? "presence_lost" : null };
  }
  function update(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["action", "pageId", "generation", "mode"].includes(key))
      || !["enter", "renew", "transition", "leave"].includes(input.action) || typeof input.pageId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(input.pageId) || !modes.has(input.mode)) throw new Error("Invalid operator presence request");
    expire();
    let page = pages.get(input.pageId);
    if (input.action !== "enter" && (!page || input.generation !== page.generation)) throw new Error("This page session expired. Retry or reopen the attendance screen.");
    if (input.action === "leave") {
      if (input.mode !== page.mode) throw new Error("Page mode does not match");
      pages.delete(input.pageId); lost = true; onSuspend();
      return { pageId: input.pageId, generation: ++generation, mode: page.mode, ...status(), expiresInMs: 0 };
    }
    if (input.action === "renew" && input.mode !== page.mode) throw new Error("Renewal cannot change the page mode");
    if (input.action === "enter" && pages.size >= 32 && !page) throw new Error("Too many open kiosk pages. Close unused tabs and retry.");
    if (input.action !== "renew") {
      page = { mode: input.mode, generation: ++generation };
      // Only a deliberate attendance entry can recover abandoned presence.
      if (input.mode === "attendance") lost = false;
    }
    page.until = now() + leaseMs;
    pages.set(input.pageId, page);
    const state = status();
    if (state.captureSuspended) onSuspend();
    return { pageId: input.pageId, generation: page.generation, mode: page.mode, ...state, expiresInMs: leaseMs };
  }
  return { update, status,
    checkpoint() {
      expire();
      return { generation, lost, pages: [...pages].map(([pageId, page]) => ({ pageId, mode: page.mode, generation: page.generation, remainingMs: Math.max(0, Math.floor(page.until - now())) })) };
    },
    suspend() { lost = true; onSuspend(); return status(); } };
}
