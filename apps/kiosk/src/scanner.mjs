const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createScanner({ scanSensor, setLed, mappings, queue, loadPairing, flushAttendance, onDisplay, onReader, onCloud, now = () => Date.now(), delay = wait, eventId = () => crypto.randomUUID(), debounceMs = 8_000 }) {
  let stopped = false; let paused = false; let lastSlot; let lastSlotAt = 0; let lastUnknownAt = 0;
  async function show(id, overrides) { await onDisplay(id, overrides); try { await setLed(id); } catch { /* Display feedback remains available if the LED command fails. */ } }
  async function tick() {
    if (paused) { await delay(100); return; }
    const config = await loadPairing();
    if (!config) { await onDisplay("unpaired"); await delay(500); return; }
    let observation;
    try { observation = await scanSensor(); onReader(true); }
    catch { onReader(false); await show("reader_offline"); await delay(1_000); return; }
    if (!observation || observation.status === "no_finger") { await delay(100); return; }
    const timestamp = now();
    if (observation.status === "not_found") {
      if (timestamp - lastUnknownAt >= debounceMs) { lastUnknownAt = timestamp; await show("unknown"); }
      await delay(250); return;
    }
    if (observation.status !== "match") { await delay(100); return; }
    if (lastSlot === observation.slot && timestamp - lastSlotAt < debounceMs) { await delay(250); return; }
    lastSlot = observation.slot; lastSlotAt = timestamp;
    const memberId = await mappings.memberForSlot(observation.slot);
    if (!memberId) { await show("unknown", { detail: "This fingerprint is not linked to an active roster member" }); await delay(250); return; }
    await show("processing");
    const event = { eventId: eventId(), memberId, occurredAt: new Date(timestamp).toISOString() };
    await queue.enqueue(event);
    let acknowledgement;
    try {
      const result = await flushAttendance(config); acknowledgement = result.acknowledgements.find((item) => item.eventId === event.eventId); onCloud(Boolean(acknowledgement));
    } catch { onCloud(false); }
    if (!acknowledgement) { await show("offline"); await delay(250); return; }
    if (acknowledgement.rejected) { await show("rejected", { detail: acknowledgement.error }); await delay(250); return; }
    const displayName = acknowledgement.member?.displayName;
    const meetingTitle = acknowledgement.meeting?.title;
    if (acknowledgement.duplicate) await show("duplicate", { name: displayName, meetingTitle });
    else if (acknowledgement.action === "check_out") await show("goodbye", { name: displayName, meetingTitle });
    else await show("welcome", { name: displayName, meetingTitle });
    await delay(250);
  }
  async function loop() { while (!stopped) await tick(); }
  return { start: loop, pause() { paused = true; }, resume() { paused = false; }, stop() { stopped = true; }, tick };
}
