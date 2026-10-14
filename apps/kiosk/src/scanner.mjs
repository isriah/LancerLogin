import { kioskDisplayForQueuedScan } from "./kiosk-presentation.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createIdentityScanner({ captureIdentity, setFeedback = async () => undefined, queue, loadPairing, flushAttendance, onDisplay, onInput = () => undefined, onCloud, now = () => Date.now(), delay = wait, eventId = () => crypto.randomUUID(), debounceMs = 8_000, flushWaitMs = 1_000 }) {
  let stopped = false; let paused = false; let lastIdentity; let lastIdentityAt = 0; let lastUnknownAt = 0;
  async function show(id, overrides) { await onDisplay(id, overrides); try { await setFeedback(id); } catch { /* Screen feedback remains available if optional hardware feedback fails. */ } }
  let currentTick;
  async function performTick() {
    if (paused) { await delay(100); return; }
    const config = await loadPairing();
    if (!config) { await onDisplay("unpaired"); await delay(500); return; }
    let observation;
    try { observation = await captureIdentity(); onInput(true); }
    catch { onInput(false); await show("reader_offline"); await delay(1_000); return; }
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
    lastIdentity = identityKey; lastIdentityAt = timestamp;
    await show("processing", observation.processingDetail ? { detail: observation.processingDetail } : undefined);
    const event = { eventId: eventId(), memberId: observation.memberId, occurredAt: new Date(timestamp).toISOString(), ...(config.pairingId ? { pairingId: config.pairingId } : {}) };
    let queuedDisplay;
    try {
      queuedDisplay = kioskDisplayForQueuedScan(observation.memberId, await queue.pending());
      if (!await queue.enqueue(event)) throw new Error("Scan was not queued");
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
    if (!acknowledgement) { await show(queuedDisplay.id, { detail: queuedDisplay.detail }); await delay(250); return; }
    if (acknowledgement.rejected) { await show("rejected", { detail: acknowledgement.error }); await delay(250); return; }
    const displayName = acknowledgement.member?.displayName;
    const meetingTitle = acknowledgement.meeting?.title;
    if (acknowledgement.duplicate) await show("duplicate", { name: displayName, meetingTitle });
    else if (acknowledgement.action === "check_out") await show("goodbye", { name: displayName, meetingTitle });
    else await show("welcome", { name: displayName, meetingTitle });
    await delay(250);
  }
  function tick() {
    if (!currentTick) currentTick = performTick().finally(() => { currentTick = undefined; });
    return currentTick;
  }
  async function loop() { while (!stopped) await tick(); }
  return { start: loop, pause() { paused = true; }, async pauseAndDrain() { paused = true; await currentTick; }, resume() { paused = false; }, stop() { stopped = true; }, tick };
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
