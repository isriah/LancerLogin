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

export function createR503(exchange, { capacity = 200, password = 0 } = {}) {
  const send = async (instruction, parameters = []) => parseAcknowledgement(await exchange(commandPacket(instruction, parameters)));
  const reader = {
    async status() {
      requireSuccess(await send(0x13, [(password >>> 24) & 0xff, (password >>> 16) & 0xff, (password >>> 8) & 0xff, password & 0xff]), "password verification");
      const count = requireSuccess(await send(0x1d), "template count");
      return { connected: true, templateCount: ((count[0] ?? 0) << 8) | (count[1] ?? 0) };
    },
    async scan() {
      const image = await send(0x01); if (image.confirmation === 0x02) return { status: "no_finger" }; requireSuccess(image, "image capture");
      requireSuccess(await send(0x02, [0x01]), "image conversion");
      const found = await send(0x04, [0x01, 0x00, 0x00, (capacity >> 8) & 0xff, capacity & 0xff]); if (found.confirmation === 0x09) return { status: "not_found" };
      const result = requireSuccess(found, "template search"); return { status: "match", slot: ((result[0] ?? 0) << 8) | (result[1] ?? 0), score: ((result[2] ?? 0) << 8) | (result[3] ?? 0) };
    },
    async match() {
      const result = await reader.scan(); return result.status === "match" ? { slot: result.slot, score: result.score } : undefined;
    },
    async led({ color = 2, mode = 3, speed = 64, cycles = 0 } = {}) {
      requireSuccess(await send(0x35, [mode, speed, color, cycles]), "LED control");
    },
    async enroll(slot, { attempts = 60, delayMs = 250, onProgress = async () => undefined } = {}) {
      if (!Number.isInteger(slot) || slot < 0 || slot >= capacity) throw new Error(`R503 slot must be between 0 and ${capacity - 1}`);
      const capture = async (buffer) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const image = await send(0x01);
          if (image.confirmation === 0) { requireSuccess(await send(0x02, [buffer]), `image ${buffer} conversion`); return; }
          if (image.confirmation !== 0x02) requireSuccess(image, `image ${buffer} capture`);
          await delay(delayMs);
        }
        throw new Error("R503 enrollment timed out waiting for a finger");
      };
      await onProgress("enroll_wait_first");
      await capture(0x01);
      await onProgress("enroll_scan_accepted");
      let removed = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const image = await send(0x01);
        if (image.confirmation === 0x02) { removed = true; break; }
        requireSuccess(image, "finger removal check"); await delay(delayMs);
      }
      if (!removed) throw new Error("R503 enrollment timed out waiting for the finger to be removed");
      await onProgress("enroll_wait_second");
      await capture(0x02);
      requireSuccess(await send(0x05), "template creation");
      requireSuccess(await send(0x06, [0x01, (slot >> 8) & 0xff, slot & 0xff]), "template storage");
      await onProgress("enroll_success");
      return { slot };
    },
  };
  return reader;
}
