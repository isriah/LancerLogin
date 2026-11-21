const header = [0xef, 0x01, 0xff, 0xff, 0xff, 0xff];
const checksum = (bytes) => bytes.reduce((sum, value) => (sum + value) & 0xffff, 0);

export function commandPacket(instruction, parameters = []) {
  const length = parameters.length + 3; const content = [0x01, length >> 8, length & 0xff, instruction, ...parameters]; const sum = checksum(content);
  return Uint8Array.from([...header, ...content, sum >> 8, sum & 0xff]);
}

export function parseAcknowledgement(packet) {
  const bytes = Uint8Array.from(packet); if (bytes.length < 12 || bytes[0] !== 0xef || bytes[1] !== 0x01 || bytes[6] !== 0x07) throw new Error("Invalid R503 acknowledgement header");
  const length = (bytes[7] << 8) | bytes[8]; if (bytes.length !== 9 + length) throw new Error("Incomplete R503 acknowledgement");
  const expected = (bytes.at(-2) << 8) | bytes.at(-1); if (checksum([...bytes.slice(6, -2)]) !== expected) throw new Error("Invalid R503 acknowledgement checksum");
  return { confirmation: bytes[9], parameters: bytes.slice(10, -2) };
}

const resultMessages = new Map([
  [0x01, "The fingerprint reader could not receive the request. Try again."],
  [0x03, "The fingerprint image was too faint. Press the same finger flat on the reader and try again."],
  [0x06, "The fingerprint image was too messy. Wipe the reader, place the same finger flat, and try again."],
  [0x07, "The reader could not turn that scan into a usable fingerprint. Try again with a steady finger."],
  [0x08, "The two scans did not match clearly. Use the same finger for both scans and try again."],
  [0x09, "No matching fingerprint was found."],
  [0x0a, "The reader could not combine those scans. The finger may already be stored, or the two scans may have been different. Choose the existing mapping, use the same finger twice, or try a different slot."],
  [0x0b, "That sensor slot is outside the reader's storage range."],
  [0x18, "The reader could not write to that sensor slot. Choose a different slot and try again."],
  [0x1a, "The reader could not clear that sensor slot."],
]);

export function r503ErrorMessage(code, operation = "operation") {
  return resultMessages.get(code) ?? `The fingerprint reader could not complete ${operation}. Try again, or test the reader from maintenance.`;
}

const requireSuccess = (acknowledgement, operation) => {
  if (acknowledgement.confirmation !== 0) {
    const error = new Error(r503ErrorMessage(acknowledgement.confirmation, operation));
    error.code = acknowledgement.confirmation;
    error.operation = operation;
    throw error;
  }
  return acknowledgement.parameters;
};
const delay = (milliseconds) => milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();

// The one place the reader's storage size is read. A reader says how many templates it holds in its system
// parameters (ReadSysPara, bytes 4-5 of 16); the driver and template transfer both read it with this function.
export const r503FallbackCapacity = 200;
export const r503MaximumCapacity = 1024;
export function r503CapacityFromParameters(parameters) {
  if (parameters?.length !== 16) return undefined;
  const capacity = (parameters[4] << 8) | parameters[5];
  return capacity >= 1 && capacity <= r503MaximumCapacity ? capacity : undefined;
}
// What the driver does with it. The kiosk has always treated the reader as holding 200 templates, so only a larger,
// plausible report changes anything: no answer, a short answer, zero, garbage, less than 200 or more than 1024 all
// mean 200, exactly as before.
export const r503DriverCapacity = (reported) => Number.isInteger(reported) && reported > r503FallbackCapacity && reported <= r503MaximumCapacity ? reported : r503FallbackCapacity;

// How many parameter bytes a successful answer to each instruction carries (R503 manual v1.4); every other
// instruction the kiosk sends is answered with none. A refusal may carry the same bytes or none. The serial exchange
// notes an answer of another length in the log and still returns it, as it always has; the driver reads the bytes
// that are there.
const replyParameters = new Map([[0x04, 4], [0x0f, 16], [0x1d, 2], [0x1f, 32]]);
const answers = (instruction) => (packet) => {
  const parameters = packet.length - 12, expected = replyParameters.get(instruction) ?? 0;
  return parameters === expected || (packet[9] !== 0 && parameters === 0);
};

// Reader answers that mean "that read did not work", not "the reader is broken": the request arrived garbled, or the
// image could not be taken or used. Re-seating the finger usually fixes them, so enrollment retries a few times.
const momentaryCapture = new Set([0x01, 0x03]);
const momentaryConversion = new Set([0x01, 0x06, 0x07, 0x15]);

/**
 * Decides when a failing reader is offline. A transport error (no valid answer at all: a timeout, a closed or missing
 * serial port) means offline at once. An error the reader itself answered with proves it is connected, so it counts as
 * offline only after `limit` such answers in a row with no good read between them.
 */
export function createReaderHealth({ limit = 3 } = {}) {
  let refusals = 0;
  return {
    success() { refusals = 0; },
    failure(error) {
      if (!Number.isInteger(error?.code)) { refusals = 0; return "offline"; }
      // Stays offline until a good read: a reader that refuses everything must not look online between refusals.
      refusals += 1;
      return refusals < limit ? "retry" : "offline";
    },
  };
}

export function createR503(exchange, { capacity: configuredCapacity, password = 0, imageRetries = 5 } = {}) {
  const send = async (instruction, parameters = []) => parseAcknowledgement(await exchange(commandPacket(instruction, parameters), { accepts: answers(instruction) }));
  let knownCapacity = configuredCapacity, askedWhileScanning = false;
  // Never fails and never makes its caller fail: a reader that does not answer, refuses, or answers with something
  // other than 16 bytes is a 200-slot reader, as the kiosk has always assumed. Only a usable answer is remembered, so
  // a later call asks again; a scan asks at most once per service start, so a reader that cannot answer costs one
  // wait, not one per finger.
  const capacity = async ({ scanning = false } = {}) => {
    if (knownCapacity !== undefined) return knownCapacity;
    if (scanning && askedWhileScanning) return r503FallbackCapacity;
    if (scanning) askedWhileScanning = true;
    try {
      const reply = await send(0x0f);
      const reported = reply.confirmation === 0 ? r503CapacityFromParameters(reply.parameters) : undefined;
      if (reported !== undefined) knownCapacity = r503DriverCapacity(reported);
    } catch { /* The fallback below. */ }
    return knownCapacity ?? r503FallbackCapacity;
  };
  const requireSlot = async (slot) => {
    const limit = await capacity();
    if (!Number.isInteger(slot) || slot < 0 || slot >= limit) throw new Error(`R503 slot must be between 0 and ${limit - 1}`);
  };
  const reader = {
    capacity,
    async status() {
      requireSuccess(await send(0x13, [(password >>> 24) & 0xff, (password >>> 16) & 0xff, (password >>> 8) & 0xff, password & 0xff]), "password verification");
      const count = requireSuccess(await send(0x1d), "template count");
      return { connected: true, templateCount: ((count[0] ?? 0) << 8) | (count[1] ?? 0) };
    },
    async occupiedSlots() {
      const limit = await capacity();
      const occupied = [];
      for (let page = 0; page < Math.ceil(limit / 256); page += 1) {
        const index = requireSuccess(await send(0x1f, [page]), "slot availability check");
        if (index.length !== 32) throw new Error("The reader could not verify occupied slots. Test the reader before enrolling.");
        for (let offset = 0; offset < 256; offset += 1) {
          const slot = page * 256 + offset;
          if (slot < limit && (index[Math.floor(offset / 8)] & (1 << (offset % 8)))) occupied.push(slot);
        }
      }
      return occupied;
    },
    async scan() {
      const image = await send(0x01); if (image.confirmation === 0x02) return { status: "no_finger" }; requireSuccess(image, "image capture");
      requireSuccess(await send(0x02, [0x01]), "image conversion");
      const limit = await capacity({ scanning: true });
      const found = await send(0x04, [0x01, 0x00, 0x00, (limit >> 8) & 0xff, limit & 0xff]); if (found.confirmation === 0x09) return { status: "not_found" };
      const result = requireSuccess(found, "template search"); return { status: "match", slot: ((result[0] ?? 0) << 8) | (result[1] ?? 0), score: ((result[2] ?? 0) << 8) | (result[3] ?? 0) };
    },
    // Erases one stored template (DeletChar). Callers decide which slots are safe to erase.
    async deleteTemplate(slot) {
      await requireSlot(slot);
      requireSuccess(await send(0x0c, [(slot >> 8) & 0xff, slot & 0xff, 0x00, 0x01]), "template deletion");
    },
    async match() {
      const result = await reader.scan(); return result.status === "match" ? { slot: result.slot, score: result.score } : undefined;
    },
    async led({ color = 2, mode = 3, speed = 64, cycles = 0 } = {}) {
      requireSuccess(await send(0x35, [mode, speed, color, cycles]), "LED control");
    },
    // Whether something is on the reader. An image the reader could not take (0x03) means it is working and has not
    // seen the finger lift, so it counts as present and the caller asks again. Other refusals are errors with a code.
    async fingerPresent() {
      const image = await send(0x01);
      if (image.confirmation === 0x02) return false;
      if (image.confirmation === 0x03) return true;
      requireSuccess(image, "finger removal check");
      return true;
    },
    async enroll(slot, { attempts = 60, delayMs = 250, onProgress = async () => undefined, replaceExisting = false, checkActive = () => {}, beforeStore = async () => {} } = {}) {
      await requireSlot(slot);
      if ((await reader.occupiedSlots()).includes(slot) && replaceExisting !== true) throw new Error(`Sensor slot ${slot} already contains a fingerprint. Confirm replacement or choose an empty slot.`);
      // A momentary failure asks for the image again instead of ending the enrollment. More than imageRetries of them
      // in a row, with no good image or lifted finger between, is reported as the reader's own error.
      const capture = async (buffer) => {
        let momentary = 0;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          checkActive();
          const image = await send(0x01);
          if (image.confirmation === 0) {
            const converted = await send(0x02, [buffer]);
            if (converted.confirmation === 0) return;
            if (!momentaryConversion.has(converted.confirmation) || (momentary += 1) > imageRetries) requireSuccess(converted, `image ${buffer} conversion`);
          } else if (image.confirmation === 0x02) momentary = 0;
          else if (!momentaryCapture.has(image.confirmation) || (momentary += 1) > imageRetries) requireSuccess(image, `image ${buffer} capture`);
          await delay(delayMs);
        }
        throw new Error("R503 enrollment timed out waiting for a finger");
      };
      await onProgress("enroll_wait_first");
      await capture(0x01);
      await onProgress("enroll_scan_accepted");
      let removed = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        checkActive();
        const image = await send(0x01);
        if (image.confirmation === 0x02) { removed = true; break; }
        // A failed image here still means the finger has not been seen to lift; the attempts bound the wait.
        if (!momentaryCapture.has(image.confirmation)) requireSuccess(image, "finger removal check");
        await delay(delayMs);
      }
      if (!removed) throw new Error("R503 enrollment timed out waiting for the finger to be removed");
      await onProgress("enroll_wait_second");
      await capture(0x02);
      await beforeStore();
      checkActive();
      requireSuccess(await send(0x05), "template creation");
      checkActive();
      requireSuccess(await send(0x06, [0x01, (slot >> 8) & 0xff, slot & 0xff]), "template storage");
      await onProgress("enroll_success");
      return { slot };
    },
  };
  return reader;
}
