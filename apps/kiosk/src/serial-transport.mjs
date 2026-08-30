import { constants } from "node:fs";
import { open } from "node:fs/promises";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createSerialExchange(path = "/dev/serial0", { timeoutMs = 2500 } = {}) {
  return async (packet) => {
    const handle = await open(path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK); const started = Date.now(); const received = [];
    try {
      await handle.write(packet);
      while (Date.now() - started < timeoutMs) {
        const target = Buffer.alloc(256);
        try { const { bytesRead } = await handle.read(target, 0, target.length, null); if (bytesRead) received.push(...target.subarray(0, bytesRead)); } catch (error) { if (error?.code !== "EAGAIN" && error?.code !== "EWOULDBLOCK") throw error; }
        if (received.length >= 9) { const length = (received[7] << 8) | received[8]; if (received.length >= 9 + length) return Uint8Array.from(received.slice(0, 9 + length)); }
        await delay(15);
      }
      throw new Error("R503 response timed out");
    } finally { await handle.close(); }
  };
}
