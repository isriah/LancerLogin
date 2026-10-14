import { timingSafeEqual } from "node:crypto";

// R503/R503-M22 manual v1.4, ModelBuffer format. Other template formats must
// receive their own verified compatibility profile, not be padded or guessed.
export const r503TemplateBytes = 1536;

export function createR503TemplateTransfer(transaction, { password = 0, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isInteger(password) || password < 0 || password > 0xffffffff) throw new Error("Invalid reader configuration");
  const command = async (io, instruction, parameters = [], responseBytes = 0) => {
    await io.writePacket(1, Uint8Array.from([instruction, ...parameters]));
    const response = await io.readPacket();
    try {
      if (response.kind !== 7 || response.payload.length !== responseBytes + 1 || response.payload[0] !== 0) throw new Error("Reader template command failed");
      return response.payload.slice(1);
    } finally { response.payload.fill(0); }
  };
  const prepare = async (io, slot) => {
    if (!Number.isInteger(slot) || slot < 0 || slot > 1023) throw new Error("Invalid template slot");
    await command(io, 0x13, [password >>> 24, (password >>> 16) & 255, (password >>> 8) & 255, password & 255]);
    const parameters = await command(io, 0x0f, [], 16);
    try {
      const capacity = (parameters[4] << 8) | parameters[5];
      const packetCode = (parameters[12] << 8) | parameters[13];
      if (capacity < 1 || capacity > 1024 || slot >= capacity || packetCode > 3) throw new Error("Unsupported reader parameters");
      return { packetBytes: 32 * (2 ** packetCode) };
    } finally { parameters.fill(0); }
  };
  const occupied = async (io, slot) => {
    const index = await command(io, 0x1f, [Math.floor(slot / 256)], 32);
    try { return Boolean(index[Math.floor((slot % 256) / 8)] & (1 << (slot % 8))); }
    finally { index.fill(0); }
  };
  const load = async (io, slot, packetBytes) => {
    await command(io, 0x07, [1, slot >>> 8, slot & 255]);
    await command(io, 0x08, [1]);
    const template = new Uint8Array(r503TemplateBytes);
    let offset = 0;
    try {
      while (offset < template.length) {
        const packet = await io.readPacket();
        try {
          const expectedLength = Math.min(packetBytes, template.length - offset);
          const expectedKind = offset + expectedLength === template.length ? 8 : 2;
          if (packet.kind !== expectedKind || packet.payload.length !== expectedLength) throw new Error("Invalid template transfer sequence");
          template.set(packet.payload, offset);
          offset += packet.payload.length;
        } finally { packet.payload.fill(0); }
      }
      return template;
    } catch (error) { template.fill(0); throw error; }
  };
  return {
    // Caller must encrypt promptly, then clear the returned bytes.
    async exportTemplate(slot, options) {
      let exported;
      try {
        return await transaction(async (io) => {
          const { packetBytes } = await prepare(io, slot);
          if (!await occupied(io, slot)) throw new Error("Source template slot is empty");
          exported = await load(io, slot, packetBytes);
          return exported;
        }, options);
      } catch (error) { exported?.fill(0); throw error; }
    },
    async importTemplate(slot, input, options) {
      if (!(input instanceof Uint8Array) || input.length !== r503TemplateBytes) throw new Error("Unsupported template size");
      const template = Uint8Array.from(input);
      try {
        return await transaction(async (io) => {
          const { packetBytes } = await prepare(io, slot);
          if (await occupied(io, slot)) throw new Error("Destination template slot is occupied");
          await command(io, 0x09, [1]);
          for (let offset = 0; offset < template.length; offset += packetBytes) {
            const end = Math.min(template.length, offset + packetBytes);
            await io.writePacket(end === template.length ? 8 : 2, template.subarray(offset, end));
            // A completed OS write only queues UART bytes. Pace each frame at
            // the supported 57600 baud, plus reader processing time, including
            // the final packet before sending another command.
            await wait(Math.max(40, Math.ceil(((end - offset + 11) * 10 * 1000) / 57600) + 15));
          }
          // Recheck before committing flash, even if the higher-level scheduler
          // already serialized enrollment and scanning with this transaction.
          if (await occupied(io, slot)) throw new Error("Destination template slot is occupied");
          await command(io, 0x06, [1, slot >>> 8, slot & 255]);
          const restored = await load(io, slot, packetBytes);
          try {
            if (!timingSafeEqual(template, restored)) throw new Error("Stored template verification failed");
          } finally { restored.fill(0); }
          return { slot, verified: true };
        }, options);
      } finally { template.fill(0); }
    },
  };
}
