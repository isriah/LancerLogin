// A virtual R503 fingerprint reader for virtual kiosks. It answers the command packets the kiosk's real driver
// (apps/kiosk/src/r503.mjs) sends over serial, so that driver runs unchanged. A "finger" is a name such as
// "member:1001:1"; the reader stores which finger each slot holds and finds it again when that finger is presented.
//
// Modeled: password check, template count, slot index, image capture, image to template, search, template creation
// and storage, template deletion and LED control, plus faults (faint, messy or unusable images, no match, a chosen
// match score, slow answers, and an unplugged reader). Not modeled: template upload and download (fingerprint
// sharing between kiosks), the reader's own match scoring, and any instruction the kiosk doesn't send.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const header = [0xef, 0x01, 0xff, 0xff, 0xff, 0xff];
const checksum = (bytes) => bytes.reduce((sum, value) => (sum + value) & 0xffff, 0);
const pause = (ms) => ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export const imageFaults = Object.freeze({ faint: 0x03, messy: 0x06, unusable: 0x07 });
export const defaultMatchScore = 180;

/** An acknowledgement packet with a confirmation code and parameters. */
export function acknowledgement(confirmation, parameters = []) {
  const length = parameters.length + 3;
  const content = [0x07, length >> 8, length & 0xff, confirmation, ...parameters];
  const sum = checksum(content);
  return Uint8Array.from([...header, ...content, sum >> 8, sum & 0xff]);
}

/** The instruction and parameters of a command packet, or undefined when the packet is malformed. */
export function readCommand(packet) {
  const bytes = Uint8Array.from(packet);
  if (bytes.length < 12 || bytes[0] !== 0xef || bytes[1] !== 0x01 || bytes[6] !== 0x01) return undefined;
  const length = (bytes[7] << 8) | bytes[8];
  if (bytes.length !== 9 + length || checksum([...bytes.slice(6, -2)]) !== ((bytes.at(-2) << 8) | bytes.at(-1))) return undefined;
  return { instruction: bytes[9], parameters: [...bytes.slice(10, -2)] };
}

export function createVirtualR503({ path, capacity = 200, timeoutMs = 600 } = {}) {
  const slots = new Map();
  if (path && existsSync(path)) for (const [slot, finger] of Object.entries(JSON.parse(readFileSync(path, "utf8")).slots ?? {})) slots.set(Number(slot), finger);
  const save = () => {
    if (!path) return;
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ slots: Object.fromEntries([...slots].sort(([a], [b]) => a - b)) }, null, 2)}\n`);
    renameSync(temporary, path);
  };
  const state = { finger: null, image: null, buffers: { 1: null, 2: null }, model: null, led: null, liftTimer: undefined };
  const faults = { image: null, imageReads: 0, noMatch: false, score: defaultMatchScore, delayMs: 0, unplugged: false };

  function answer({ instruction, parameters }) {
    switch (instruction) {
      case 0x13: return acknowledgement(0); // Password verification
      case 0x1d: return acknowledgement(0, [slots.size >> 8, slots.size & 0xff]); // Template count
      case 0x1f: { // Slot index for one page of 256 slots
        const page = parameters[0] ?? 0; const index = new Array(32).fill(0);
        for (const slot of slots.keys()) if (Math.floor(slot / 256) === page) index[Math.floor((slot % 256) / 8)] |= 1 << (slot % 8);
        return acknowledgement(0, index);
      }
      case 0x01: { // Image capture
        if (!state.finger) { state.image = null; return acknowledgement(0x02); }
        if (faults.image && faults.imageReads > 0) { faults.imageReads -= 1; state.image = null; const code = faults.image; if (!faults.imageReads) faults.image = null; return acknowledgement(code); }
        state.image = state.finger; return acknowledgement(0);
      }
      case 0x02: { // Image to template, in buffer 1 or 2
        if (!state.image) return acknowledgement(0x07);
        state.buffers[parameters[0] === 2 ? 2 : 1] = state.image; return acknowledgement(0);
      }
      case 0x04: { // Search the library for the template in buffer 1
        const wanted = state.buffers[1];
        const slot = faults.noMatch ? undefined : [...slots].find(([, finger]) => finger === wanted)?.[0];
        if (slot === undefined) return acknowledgement(0x09);
        return acknowledgement(0, [slot >> 8, slot & 0xff, faults.score >> 8, faults.score & 0xff]);
      }
      case 0x05: { // Combine both buffers into one model
        if (!state.buffers[1] || state.buffers[1] !== state.buffers[2]) return acknowledgement(0x0a);
        state.model = state.buffers[1]; return acknowledgement(0);
      }
      case 0x06: { // Store the model in a slot
        const slot = ((parameters[1] ?? 0) << 8) | (parameters[2] ?? 0);
        if (slot >= capacity) return acknowledgement(0x0b);
        if (!state.model) return acknowledgement(0x18);
        slots.set(slot, state.model); save(); return acknowledgement(0);
      }
      case 0x0c: { // Delete one or more slots
        const slot = ((parameters[0] ?? 0) << 8) | (parameters[1] ?? 0); const count = ((parameters[2] ?? 0) << 8) | (parameters[3] ?? 1);
        if (slot >= capacity) return acknowledgement(0x1a);
        for (let offset = 0; offset < count; offset += 1) slots.delete(slot + offset);
        save(); return acknowledgement(0);
      }
      case 0x35: state.led = { mode: parameters[0], speed: parameters[1], color: parameters[2], cycles: parameters[3] }; return acknowledgement(0); // LED
      default: return acknowledgement(0x01);
    }
  }

  return {
    /** The serial exchange: one command packet in, one acknowledgement out, as createSerialExchange does on a Pi. */
    async exchange(packet) {
      await pause(faults.delayMs);
      if (faults.unplugged) { await pause(timeoutMs); throw new Error("R503 response timed out"); }
      const command = readCommand(packet);
      return command ? answer(command) : acknowledgement(0x01);
    },
    /** Puts a finger on the reader. With holdMs it lifts by itself, like a member tapping the reader. */
    present(finger, holdMs = 0) {
      if (typeof finger !== "string" || !/^[a-z]+:[A-Za-z0-9._-]{1,100}(?::\d)?$/.test(finger)) throw new Error("Present a finger such as member:1001:1");
      clearTimeout(state.liftTimer); state.finger = finger;
      if (holdMs > 0) state.liftTimer = setTimeout(() => { state.finger = null; }, Math.min(holdMs, 60_000));
    },
    lift() { clearTimeout(state.liftTimer); state.finger = null; },
    setFaults(next) {
      if (next.image !== undefined) { if (next.image !== null && !Object.hasOwn(imageFaults, next.image)) throw new Error("Image fault must be faint, messy or unusable"); faults.image = next.image === null ? null : imageFaults[next.image]; faults.imageReads = next.image === null ? 0 : Math.min(Math.max(Number(next.imageReads ?? 1), 1), 20); }
      if (next.noMatch !== undefined) faults.noMatch = Boolean(next.noMatch);
      if (next.score !== undefined) { const score = Number(next.score); if (!Number.isInteger(score) || score < 0 || score > 65_535) throw new Error("Match score must be 0 to 65535"); faults.score = score; }
      if (next.delayMs !== undefined) { const delay = Number(next.delayMs); if (!Number.isInteger(delay) || delay < 0 || delay > 10_000) throw new Error("Delay must be 0 to 10000 ms"); faults.delayMs = delay; }
      if (next.unplugged !== undefined) faults.unplugged = Boolean(next.unplugged);
    },
    status() {
      const image = Object.entries(imageFaults).find(([, code]) => code === faults.image)?.[0] ?? null;
      return { finger: state.finger, slots: Object.fromEntries([...slots].sort(([a], [b]) => a - b)), led: state.led, faults: { ...faults, image } };
    },
  };
}
