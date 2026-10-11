const packetKinds = new Set([0x01, 0x02, 0x07, 0x08]);
const sum = (bytes) => bytes.reduce((total, byte) => (total + byte) & 0xffff, 0);
const validAddress = (address) => Number.isInteger(address) && address >= 0 && address <= 0xffffffff;

// Payloads may contain sensitive reader data. Never include bytes in errors.
export function encodeR503Packet(kind, payload, address = 0xffffffff) {
  if (!packetKinds.has(kind) || !(payload instanceof Uint8Array) || payload.length < 1 || payload.length > 256 || !validAddress(address)) {
    throw new Error("Invalid R503 packet parameters");
  }
  const length = payload.length + 2;
  const packet = Uint8Array.from([0xef, 0x01, address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255, kind, length >>> 8, length & 255, ...payload, 0, 0]);
  const checksum = sum(packet.subarray(6, -2));
  packet[packet.length - 2] = checksum >>> 8;
  packet[packet.length - 1] = checksum & 255;
  return packet;
}

// One decoder belongs to one bounded serial transaction. A protocol failure
// poisons it rather than resynchronizing into potentially unrelated data.
export function createR503PacketDecoder({ address = 0xffffffff, maxBufferedBytes = 4096 } = {}) {
  if (!validAddress(address) || !Number.isInteger(maxBufferedBytes) || maxBufferedBytes < 267 || maxBufferedBytes > 65536) {
    throw new Error("Invalid R503 decoder limits");
  }
  let pending = new Uint8Array();
  let closed = false;
  const fail = () => {
    pending.fill(0);
    pending = new Uint8Array();
    closed = true;
    throw new Error("Invalid or incomplete R503 packet stream");
  };
  return {
    push(chunk) {
      if (closed || !(chunk instanceof Uint8Array) || pending.length + chunk.length > maxBufferedBytes) return fail();
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending);
      joined.set(chunk, pending.length);
      pending.fill(0);
      pending = joined;
      const packets = [];
      let offset = 0;
      while (pending.length - offset >= 9) {
        const bytes = pending.subarray(offset);
        const receivedAddress = ((bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5]) >>> 0;
        const length = (bytes[7] << 8) | bytes[8];
        if (bytes[0] !== 0xef || bytes[1] !== 0x01 || receivedAddress !== address || !packetKinds.has(bytes[6]) || length < 3 || length > 258) return fail();
        const total = 9 + length;
        if (bytes.length < total) break;
        const expected = (bytes[total - 2] << 8) | bytes[total - 1];
        if (sum(bytes.subarray(6, total - 2)) !== expected) return fail();
        packets.push({ kind: bytes[6], payload: bytes.slice(9, total - 2) });
        offset += total;
      }
      const remainder = pending.slice(offset);
      pending.fill(0);
      pending = remainder;
      return packets;
    },
    finish() {
      if (closed || pending.length) return fail();
      closed = true;
    },
    dispose() {
      pending.fill(0);
      pending = new Uint8Array();
      closed = true;
    },
  };
}
