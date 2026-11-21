import { constants } from "node:fs";
import { open } from "node:fs/promises";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const noData = (error) => error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK";
const packetKinds = new Set([0x01, 0x02, 0x07, 0x08]);
const acknowledgementKind = 0x07;
// ReadSysPara: the one command the kiosk sends whose answer has 16 parameter bytes, so no other answer looks like it.
const probeInstruction = 0x0f, probeParameters = 16;
const maxPendingBytes = 4096;

/**
 * The first complete R503 packet in the bytes read so far: header EF 01, this reader's address, a known packet kind, a
 * length in range and a matching checksum. Bytes before it are dropped; a start that fails any check is not a packet,
 * and the search moves on one byte. Without a complete packet, rest keeps everything from the first possible header.
 */
export function takeR503Packet(bytes, address = 0xffffffff) {
  let keep = -1;
  for (let offset = 0; offset < bytes.length; offset += 1) {
    if (bytes[offset] !== 0xef) continue;
    const available = bytes.length - offset;
    if (available < 9) {
      // Too short to judge: keep it unless the bytes already read rule it out.
      const expected = [0xef, 0x01, (address >>> 24) & 0xff, (address >>> 16) & 0xff, (address >>> 8) & 0xff, address & 0xff];
      const plausible = expected.every((value, index) => index >= available || bytes[offset + index] === value) && (available < 7 || packetKinds.has(bytes[offset + 6]));
      if (plausible && keep < 0) keep = offset;
      continue;
    }
    const received = ((bytes[offset + 2] << 24) | (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5]) >>> 0;
    const length = (bytes[offset + 7] << 8) | bytes[offset + 8];
    if (bytes[offset + 1] !== 0x01 || received !== address || !packetKinds.has(bytes[offset + 6]) || length < 3 || length > 258) continue;
    const total = 9 + length;
    if (available < total) { if (keep < 0) keep = offset; continue; }
    let sum = 0; for (let index = offset + 6; index < offset + total - 2; index += 1) sum = (sum + bytes[index]) & 0xffff;
    if (sum !== ((bytes[offset + total - 2] << 8) | bytes[offset + total - 1])) continue;
    return { packet: Uint8Array.from(bytes.slice(offset, offset + total)), rest: bytes.slice(offset + total) };
  }
  return { packet: undefined, rest: keep < 0 ? [] : bytes.slice(keep) };
}

/**
 * One command out, one acknowledgement back, on the reader's serial port.
 *
 * An acknowledgement does not say which command it answers, so the exchange keeps the two in step itself:
 * - Bytes already waiting when a command starts were sent for something earlier, and are discarded before it is written.
 * - A reply is the next valid acknowledgement packet (takeR503Packet); stray bytes and other packet kinds are skipped.
 * - `accepts` says whether a packet has the length the manual gives for this command. One that has not is logged and
 *   still returned: only a bad header, address or checksum makes the exchange skip a packet.
 * - After a command got no answer, its reply may still arrive, and it could look like the answer to the next command.
 *   The next exchange first asks the reader for its system parameters and discards everything up to that answer,
 *   which no other command produces. The reader answers in order, so nothing older can follow it. A reader that
 *   does not answer that question is treated as before this existed: waiting bytes are discarded and the command sent.
 */
export function createSerialExchange(path = "/dev/serial0", { timeoutMs = 2500, openHandle = open, address = 0xffffffff, settleMs = 30, pollMs = 15, now = Date.now, wait = delay, log = (message) => console.warn(message) } = {}) {
  let outOfStep = false;
  const timedOut = () => new Error("R503 response timed out");
  async function readAvailable(handle) {
    const bytes = [];
    for (;;) {
      const target = Buffer.alloc(256); let bytesRead = 0;
      try { ({ bytesRead } = await handle.read(target, 0, target.length, null)); } catch (error) { if (!noData(error)) throw error; }
      if (!bytesRead) return bytes;
      bytes.push(...target.subarray(0, bytesRead));
      if (bytes.length > maxPendingBytes) return bytes;
    }
  }
  // Discards what is waiting, and keeps discarding until the port has been quiet for quietMs (at most ten times that).
  async function discard(handle, quietMs = 0) {
    const started = now(); let quietSince = started;
    for (;;) {
      if ((await readAvailable(handle)).length) quietSince = now();
      if (now() - quietSince >= quietMs || now() - started >= quietMs * 10) return;
      await wait(Math.min(pollMs, quietMs));
    }
  }
  async function reply(handle, accepts, deadline, seen = { acknowledgements: 0 }) {
    let pending = [];
    for (;;) {
      pending.push(...await readAvailable(handle));
      for (;;) {
        const { packet, rest } = takeR503Packet(pending, address); pending = rest;
        if (!packet) break;
        if (packet[6] !== acknowledgementKind) continue;
        seen.acknowledgements += 1;
        if (!accepts || accepts(packet)) return packet;
      }
      if (pending.length > maxPendingBytes) pending = pending.slice(-maxPendingBytes);
      if (now() >= deadline) throw timedOut();
      await wait(pollMs);
    }
  }
  const probe = () => {
    const content = [0x01, 0x00, 0x03, probeInstruction], sum = content.reduce((total, value) => total + value, 0);
    return Uint8Array.from([0xef, 0x01, (address >>> 24) & 0xff, (address >>> 16) & 0xff, (address >>> 8) & 0xff, address & 0xff, ...content, sum >> 8, sum & 0xff]);
  };
  // The probe is an extra this exchange adds; a reader that will not answer it must not be worse off than before.
  // probeAnswered: the reader has answered ReadSysPara with its 16 bytes at least once. unanswered: probes (or the
  // driver's own ReadSysPara) in a row that got no answer at all.
  let probeAnswered = false, unanswered = 0;
  const isProbeAnswer = (answer) => answer.length === 12 + probeParameters;
  return async (packet, { accepts } = {}) => {
    const handle = await openHandle(path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK);
    try {
      await discard(handle);
      // A reader that has never answered the probe and has now ignored it twice is not asked again: the waiting
      // bytes were discarded above, and the command goes out as it always did.
      if (outOfStep && (probeAnswered || unanswered < 2)) {
        await handle.write(probe());
        const seen = { acknowledgements: 0 };
        try { await reply(handle, isProbeAnswer, now() + timeoutMs, seen); probeAnswered = true; unanswered = 0; }
        catch (error) {
          // A reader that answered, but never with its parameters, refused the probe. It is connected, and a full
          // timeout has passed with the port read throughout, so nothing older is still on its way.
          if (!seen.acknowledgements) {
            unanswered += 1;
            // The first unanswered probe fails the command, as a reader that is gone should. From the second, the
            // command is sent anyway, so the kiosk cannot stay offline because of the probe alone.
            if (unanswered < 2) throw error;
          }
        }
        // A stale answer to an earlier system-parameters command would have ended the wait early; let the real one land.
        await discard(handle, settleMs);
      }
      outOfStep = false;
      try {
        await handle.write(packet);
        const answer = await reply(handle, undefined, now() + timeoutMs);
        if (packet[9] === probeInstruction && isProbeAnswer(answer)) { probeAnswered = true; unanswered = 0; }
        // In step, the first valid acknowledgement is the answer, whatever its length, as it always has been. One of
        // an unexpected length is noted (never its bytes) so a reader that differs from the manual can be recognised.
        if (accepts && !accepts(answer)) log(`R503 answer to instruction 0x${packet[9].toString(16).padStart(2, "0")} has an unexpected length (${answer.length} bytes); used as received`);
        return answer;
      } catch (error) {
        outOfStep = true;
        if (packet[9] === probeInstruction) unanswered += 1;
        throw error;
      }
    } finally { await handle.close(); }
  };
}
