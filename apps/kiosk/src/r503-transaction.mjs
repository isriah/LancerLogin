import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createR503PacketDecoder, encodeR503Packet } from "./r503-packets.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryable = (error) => error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK";

// One open descriptor preserves all packets for the entire command/data exchange.
// Callers own returned payloads and must clear them after use. No payload is logged.
export function createR503Transaction(path = "/dev/serial0", {
  timeoutMs = 5000, maxBytes = 16384, address = 0xffffffff,
  openHandle = open, now = () => performance.now(), wait = pause,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(maxBytes) || maxBytes < 267 || maxBytes > 65536) {
    throw new Error("Invalid R503 transaction limits");
  }
  // Validate the configured address before opening the device.
  createR503PacketDecoder({ address }).dispose();
  let tail = Promise.resolve();
  return (operation, { signal } = {}) => {
    const run = async () => {
      const started = now();
      let active = true;
      let busy = false;
      let poisoned = false;
      let transferred = 0;
      let failure = "R503 serial transaction failed";
      let handle;
      const decoder = createR503PacketDecoder({ address });
      const ready = [];
      const scratch = Buffer.alloc(512);
      const check = () => {
        if (signal?.aborted) { failure = "R503 serial transaction cancelled"; throw new Error(failure); }
        if (now() - started >= timeoutMs) { failure = "R503 serial transaction timed out"; throw new Error(failure); }
        if (!active) throw new Error("R503 serial transaction closed");
        if (poisoned) throw new Error("R503 serial transaction failed");
      };
      const count = (bytes) => {
        transferred += bytes;
        if (transferred > maxBytes) throw new Error("R503 serial transaction limit exceeded");
      };
      const exclusive = async (action) => {
        check();
        if (busy) { poisoned = true; throw new Error("Concurrent R503 transaction operations are not allowed"); }
        busy = true;
        try { return await action(); }
        catch (error) { poisoned = true; throw error; }
        finally { busy = false; }
      };
      try {
        check();
        handle = await openHandle(path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK);
        check();
        const result = await operation({
          writePacket: (kind, payload) => exclusive(async () => {
            const packet = encodeR503Packet(kind, payload, address);
            try {
              let offset = 0;
              while (offset < packet.length) {
                check();
                let written = 0;
                try { written = (await handle.write(packet, offset, packet.length - offset, null)).bytesWritten; }
                catch (error) { if (!retryable(error)) throw error; }
                if (!Number.isInteger(written) || written < 0 || written > packet.length - offset) throw new Error("Invalid R503 serial write");
                count(written);
                offset += written;
                if (!written) await wait(5);
              }
              check();
            } finally { packet.fill(0); }
          }),
          readPacket: () => exclusive(async () => {
            while (!ready.length) {
              check();
              let read = 0;
              try { read = (await handle.read(scratch, 0, scratch.length, null)).bytesRead; }
              catch (error) { if (!retryable(error)) throw error; }
              if (!Number.isInteger(read) || read < 0 || read > scratch.length) throw new Error("Invalid R503 serial read");
              count(read);
              if (read) ready.push(...decoder.push(scratch.subarray(0, read)));
              scratch.fill(0);
              if (!ready.length) await wait(5);
            }
            check();
            return ready.shift();
          }),
        });
        check();
        if (busy || ready.length) throw new Error("Unconsumed R503 serial packets");
        decoder.finish();
        return result;
      } catch {
        // Do not attach underlying exceptions: an injected transport or callback
        // could include packet bytes in its message or cause.
        throw new Error(failure);
      } finally {
        active = false;
        decoder.dispose();
        scratch.fill(0);
        for (const packet of ready) packet.payload.fill(0);
        if (handle) {
          try { await handle.close(); }
          catch { throw new Error("R503 serial connection could not close"); }
        }
      }
    };
    const result = tail.then(run, run);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
