import { kioskDisplayForQueuedScan } from "./kiosk-presentation.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Shown under an accepted scan whose match score is below the re-enrollment threshold. Attendance is still recorded.
export const weakReadingNotice = "Your fingerprint is reading weakly. Ask a mentor to re-enroll it.";

export function createIdentityScanner({ captureIdentity, captureAllowed = () => true, captureTime, setFeedback = async () => undefined, queue, loadPairing, flushAttendance, onDisplay, onInput = () => undefined, onCloud, now = () => Date.now(), delay = wait, eventId = () => crypto.randomUUID(), debounceMs = 8_000, flushWaitMs = 1_000, weakReading = () => false }) {
  let stopped = false; let paused = false; let lastIdentity; let lastIdentityAt = 0; let lastUnknownAt = -Infinity;
  async function show(id, overrides) { await onDisplay(id, overrides); try { await setFeedback(id); } catch { /* Screen feedback remains available if optional hardware feedback fails. */ } }
  let currentTick, currentCommit, captureGeneration = 0;
  const suspensions = new Set();
  const allowed = () => !suspensions.size && captureAllowed();
  async function performTick() {
    if (paused || !allowed()) { await delay(100); return; }
    const epoch = captureGeneration;
    const valid = () => epoch === captureGeneration && allowed();
    const config = await loadPairing();
    if (!config) { await onDisplay("unpaired"); await delay(500); return; }
    let observation;
    try { observation = await captureIdentity(); onInput(true); }
    catch { onInput(false); await show("reader_offline"); await delay(1_000); return; }
    if (!valid()) return;
    if (!observation || observation.status === "idle") { await delay(100); return; }
    const timestamp = now();
    if (observation.status === "unknown") {
      if (timestamp - lastUnknownAt >= debounceMs) {
        lastUnknownAt = timestamp;
        const overrides = { ...(observation.message ? { message: observation.message } : {}), ...(observation.detail ? { detail: observation.detail } : {}) };
        await show("unknown", Object.keys(overrides).length ? overrides : undefined);
      }
      await delay(250); return;
    }
    if (observation.status !== "identified" || !observation.memberId) { await delay(100); return; }
    const identityKey = observation.identityKey || observation.memberId;
    if (lastIdentity === identityKey && timestamp - lastIdentityAt < debounceMs) { await delay(250); return; }
    await show("processing", observation.processingDetail ? { detail: observation.processingDetail } : undefined);
    let event;
    let queuedDisplay;
    try {
      event = { eventId: eventId(), memberId: observation.memberId, ...(captureTime ? await captureTime() : { occurredAt: new Date(timestamp).toISOString() }), ...(config.pairingId ? { pairingId: config.pairingId } : {}), ...(Number.isInteger(observation.matchScore) ? { matchScore: observation.matchScore } : {}) };
      queuedDisplay = kioskDisplayForQueuedScan(observation.memberId, await queue.pending());
      if (!valid()) return;
      lastIdentity = identityKey; lastIdentityAt = timestamp;
      // Synchronous ownership before invoking enqueue closes the entry/write
      // race. Strict suspension waits only for this durable commit boundary.
      currentCommit = Promise.resolve().then(() => queue.enqueue(event));
      try { if (!await currentCommit) throw new Error("Scan was not queued"); }
      finally { currentCommit = undefined; }
    } catch {
      await show("rejected", { detail: "This scan could not be saved. Ask an operator for help." });
      await delay(250); return;
    }
    let acknowledgement;
    try {
      let timer;
      try {
        const result = await Promise.race([flushAttendance(config), new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), flushWaitMs); })]);
        acknowledgement = result?.acknowledgements?.find((item) => item.eventId === event.eventId);
        if (result) onCloud(Boolean(acknowledgement));
      } finally { clearTimeout(timer); }
    } catch { onCloud(false); }
    if (!acknowledgement) { await show(queuedDisplay.id, { detail: event.clock?.verified === false ? "Saved on kiosk | Clock needs sync before attendance can be confirmed" : queuedDisplay.detail }); await delay(250); return; }
    if (acknowledgement.rejected) { await show("rejected", { detail: acknowledgement.error }); await delay(250); return; }
    // The member scanned on another kiosk moments apart from this scan, so this finger was probably matched to the
    // wrong member. Nothing was recorded. The debounce still applies, so a finger left on the reader is not resent.
    if (acknowledgement.rescan) { await show("rescan"); await delay(250); return; }
    const displayName = acknowledgement.member?.displayName;
    const meetingTitle = acknowledgement.meeting?.title;
    const notice = !acknowledgement.duplicate && weakReading(event.matchScore) ? { notice: weakReadingNotice, durationMs: 4_000 } : {};
    if (acknowledgement.duplicate) await show("duplicate", { name: displayName, meetingTitle });
    else if (acknowledgement.action === "check_out") await show("goodbye", { name: displayName, meetingTitle, ...notice });
    else await show("welcome", { name: displayName, meetingTitle, ...notice });
    await delay(250);
  }
  function tick() {
    if (!currentTick) currentTick = performTick().finally(() => { currentTick = undefined; });
    return currentTick;
  }
  async function loop() { while (!stopped) await tick(); }
  return { start: loop, pause() { paused = true; }, async pauseAndDrain() { paused = true; await currentTick; }, resume() { paused = false; },
    suspend(reason) { if (!suspensions.has(reason)) { suspensions.add(reason); captureGeneration++; } return currentCommit ? currentCommit.catch(() => undefined) : Promise.resolve(); },
    release(reason) { if (suspensions.delete(reason)) captureGeneration++; }, stop() { stopped = true; }, tick };
}

// Preserve the original fingerprint contract while routing it through the shared
// identity-to-attendance pipeline.
export function createScanner({ scanSensor, setLed, mappings, onReader, ...shared }) {
  return createIdentityScanner({
    ...shared,
    setFeedback: setLed,
    onInput: onReader,
    captureIdentity: async () => {
      const observation = await scanSensor();
      if (!observation || observation.status === "no_finger") return { status: "idle" };
      if (observation.status === "not_found") return { status: "unknown" };
      if (observation.status !== "match") return { status: "idle" };
      const memberId = await mappings.memberForSlot(observation.slot);
      if (!memberId) return { status: "unknown", detail: "This fingerprint is not linked to an active roster member" };
      return { status: "identified", memberId, identityKey: `fingerprint:${observation.slot}` };
    },
  });
}
