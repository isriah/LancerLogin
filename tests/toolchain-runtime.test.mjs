import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const requireFromMiniflare = createRequire(require.resolve("miniflare"));
const sharp = requireFromMiniflare("sharp");

test("Miniflare's patched native image library decodes synthetic AVIF and resizes it", async () => {
  // Exercise the actual transitive native dependency, including the patched HEIF decoder.
  const input = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#224466" } })
    .avif({ lossless: true }).toBuffer();
  const { data, info } = await sharp(input).resize(8, 6).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 8);
  assert.equal(info.height, 6);
  assert.equal(info.channels, 3);
  assert.equal(data.length, 8 * 6 * 3);
  assert.ok(data[0] >= 32 && data[0] <= 36);
  assert.ok(data[1] >= 66 && data[1] <= 70);
  assert.ok(data[2] >= 100 && data[2] <= 104);
});
