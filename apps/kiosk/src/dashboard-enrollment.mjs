const identifier = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const text = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const terminal = new Set(["enroll_success", "enroll_failure", "cancelled", "expired"]);
export const enrollmentProgress = new Set(["waiting_member", "awaiting_confirmation", "enroll_wait_first", "enroll_remove", "enroll_wait_second", ...terminal]);

export function readEnrollmentSession(value, config, now = Date.now()) {
  if (value === null) return null;
  const expires = typeof value?.expiresAt === "string" ? Date.parse(value.expiresAt) : value?.expiresAt;
  if (!identifier(value?.id) || value.pairingId !== config?.pairingId || !Number.isSafeInteger(expires) || expires > now + 300_000
    || !["waiting_member", "ready", "cancelled"].includes(value.state) || !enrollmentProgress.has(value.progress)
    || value.state === "ready" && !value.member) throw new Error("Dashboard enrollment session is unavailable.");
  if (value.member && (!identifier(value.member.rosterId) || !text(value.member.memberId, 100) || !text(value.member.firstName, 100) || !text(value.member.lastName, 100))) throw new Error("Dashboard enrollment member is unavailable.");
  return { id: value.id, pairingId: value.pairingId, expiresAt: expires, state: value.state, progress: value.progress, ...(value.member ? { member: { ...value.member } } : {}) };
}

// This authority is memory-only and never opens the local PIN session. Restarting
// the service requires a new on-screen confirmation before any reader write.
export function createDashboardEnrollment({ now = Date.now, loadPairing, fetchSession, sendProgress, enroll, onActive = async () => {}, onIdle = async () => {} }) {
  let current, config, busy = false, generation = 0, message = "";
  const snapshot = () => current ? { ...structuredClone(current), busy, message } : null;
  function active() { return Boolean(current && !terminal.has(current.progress) && current.state !== "cancelled" && now() < current.expiresAt); }
  function assertActive(id = current?.id) {
    if (!current || current.id !== id || current.state === "cancelled" || terminal.has(current.progress) || now() >= current.expiresAt) throw new Error("Dashboard enrollment was cancelled or expired. Start a new session from the dashboard.");
  }
  async function finish(status, detail) {
    if (!current || terminal.has(current.progress)) return;
    current.progress = status; message = detail; generation++;
    if (!busy) await onIdle();
  }
  async function update(value, pairing) {
    let next;
    try { next = readEnrollmentSession(value, pairing, now()); }
    catch (error) { await finish("enroll_failure", "Dashboard enrollment authority could not be verified."); throw error; }
    if (!next) { await finish("cancelled", "Dashboard enrollment ended. Return to the kiosk."); return; }
    if (now() >= next.expiresAt) { if (current?.id === next.id) await finish("expired", "Dashboard enrollment expired."); return; }
    if (current?.id === next.id) {
      if (config?.kioskToken !== pairing.kioskToken || config?.kioskId !== pairing.kioskId || current.pairingId !== next.pairingId || current.expiresAt !== next.expiresAt
        || current.member && (!next.member || current.member.rosterId !== next.member.rosterId || current.member.memberId !== next.member.memberId || current.member.firstName !== next.member.firstName || current.member.lastName !== next.member.lastName)) {
        await finish("enroll_failure", "Dashboard enrollment identity changed. Start a new session."); throw new Error(message);
      }
      if (terminal.has(current.progress)) return;
      if (next.state === "cancelled" || terminal.has(next.progress)) { await finish(next.state === "cancelled" ? "cancelled" : next.progress, "Dashboard enrollment ended."); return; }
      current.state = next.state;
      if (next.member) current.member = next.member;
      return;
    }
    if (busy) { await finish("cancelled", "Dashboard enrollment was replaced."); return; }
    if (next.state === "cancelled" || terminal.has(next.progress)) return;
    config = { ...pairing }; current = { ...next, progress: next.member ? "awaiting_confirmation" : "waiting_member" }; message = ""; generation++;
    try { await onActive(); }
    catch (error) { await finish("enroll_failure", "Fingerprint enrollment is unavailable while this kiosk is busy."); throw error; }
  }
  async function authority(id) {
    assertActive(id);
    const pairing = await loadPairing();
    if (!pairing || ["apiUrl", "kioskId", "pairingId", "kioskToken"].some(key => pairing[key] !== config[key])) { await finish("cancelled", "Kiosk pairing changed."); throw new Error("Kiosk pairing changed."); }
    const remote = await fetchSession(pairing);
    await update(remote, pairing); assertActive(id);
    return current.member;
  }
  async function progress(status, detail) {
    assertActive();
    if (!enrollmentProgress.has(status)) throw new Error("Unsupported enrollment progress.");
    const id = current.id;
    const reply = await sendProgress(config, id, { status, ...(detail ? { message: detail } : {}) });
    await update(reply, config);
    if (status !== "enroll_success") assertActive(id);
    if (current?.id === id && !terminal.has(current.progress)) current.progress = status;
  }
  async function confirm(id) {
    if (busy) throw new Error("Dashboard enrollment is already in progress.");
    busy = true;
    try {
      const member = await authority(id);
      if (!member || current.state !== "ready") throw new Error("Choose a member in the dashboard before confirming enrollment.");
      const version = generation;
      await progress("awaiting_confirmation");
      const result = await enroll({ member, checkActive: () => { assertActive(id); if (generation !== version) throw new Error("Dashboard enrollment changed."); },
        beforeStore: () => authority(id), onProgress: status => progress(status) });
      assertActive(id);
      await progress("enroll_success", "Fingerprint enrollment saved. Lift your finger.");
      message = "Fingerprint enrollment saved. Lift your finger, then return to the kiosk.";
      return result;
    } catch (error) {
      if (current?.id === id && !terminal.has(current.progress)) {
        try { await sendProgress(config, id, { status: now() >= current.expiresAt ? "expired" : "enroll_failure", message: "Enrollment did not complete. Review kiosk status before retrying." }); } catch { /* Never retry reader writes after uncertain completion. */ }
        await finish(now() >= current.expiresAt ? "expired" : "enroll_failure", error instanceof Error ? error.message : "Enrollment did not complete.");
      }
      throw error;
    } finally { busy = false; await onIdle(); }
  }
  return { update, snapshot, active, confirm, async refresh(id) { await authority(id); return snapshot(); },
    async expire() { if (current && !terminal.has(current.progress) && now() >= current.expiresAt) await finish("expired", "Dashboard enrollment expired."); },
    async cancel(id) { assertActive(id); const pairing = config; await finish("cancelled", "Dashboard enrollment cancelled."); await sendProgress(pairing, id, { status: "cancelled" }); },
    unavailable: () => finish("enroll_failure", "Dashboard enrollment authority is unavailable. Start a new session when connected.") };
}
