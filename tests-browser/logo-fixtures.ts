import { crc32, deflateSync } from "node:zlib";

// Synthetic organization logos of several shapes for browser specs, built in memory so no image files are needed.

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
}

/**
 * A PNG data URL of the given size: a magenta field with a gold diamond touching all four edges, so a clipped or
 * squashed logo is easy to see. With `margin` (a fraction of each side) the edge is transparent and only the middle is
 * drawn, as in a logo exported with padding.
 */
export function pngLogo(width: number, height: number, { margin = 0 }: { margin?: number } = {}) {
  const stride = width * 4 + 1; const raw = Buffer.alloc(stride * height);
  const left = Math.floor(width * margin), top = Math.floor(height * margin);
  const innerWidth = Math.max(1, width - left * 2), innerHeight = Math.max(1, height - top * 2);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const inside = x >= left && x < left + innerWidth && y >= top && y < top + innerHeight;
      if (!inside) continue;
      const dx = Math.abs((x - left + 0.5) / innerWidth - 0.5), dy = Math.abs((y - top + 0.5) / innerHeight - 0.5);
      const diamond = dx + dy <= 0.5; const offset = row + 1 + x * 4;
      raw[offset] = diamond ? 0xe9 : 0x8b; raw[offset + 1] = diamond ? 0xb9 : 0x2f; raw[offset + 2] = diamond ? 0x49 : 0x72; raw[offset + 3] = 0xff;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** An SVG data URL with the given root attributes (for example only a viewBox, or only a width) and the same artwork. */
export function svgLogo(attributes: string, viewWidth = 100, viewHeight = 200) {
  const w = viewWidth, h = viewHeight;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect width="${w}" height="${h}" fill="#8b2f72"/><path d="M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z" fill="#e9b949"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** The shapes the logo frames must hold: taller, square, and wider than the frame, a thin strip, and an SVG with no size of its own. */
export const logoShapes = [
  { name: "tall", logo: () => pngLogo(300, 600) },
  { name: "square", logo: () => pngLogo(512, 512) },
  { name: "wide", logo: () => pngLogo(600, 120) },
  { name: "very thin", logo: () => pngLogo(60, 600) },
  { name: "viewBox-only SVG", logo: () => svgLogo('viewBox="0 0 100 200"') },
] as const;

/** Further shapes worth a look by eye; the screenshot script and the reproduction use them. */
export const extraLogoShapes = [
  { name: "tiny", logo: () => pngLogo(32, 32) },
  { name: "huge", logo: () => pngLogo(4000, 4000) },
  { name: "width-only SVG", logo: () => svgLogo('width="100"') },
  { name: "transparent", logo: () => pngLogo(400, 400, { margin: 0.2 }) },
] as const;

type LogoPage = import("@playwright/test").Page;
export type Box = { x: number; y: number; width: number; height: number };

/** A dashboard whose organization has `logo()` (read on every load, so a test can change it and reload), in dark theme. */
export async function useLogoDashboard(page: LogoPage, modules: unknown, logo: () => { logoData: string; logoBackdrop?: string }, { signedIn = true }: { signedIn?: boolean } = {}) {
  const settings = () => ({ organizationName: "Reference Arts Collective", subtitle: "Shared operations", primaryColor: "#7c3aed", secondaryColor: "#0f766e", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30, earlyScanMinutes: 15, discordContestWindowHours: 24, attendanceReportingStartsOn: null, ...logo() });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark"));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: modules }));
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: settings() } }));
  await page.route("**/auth/session", (route) => signedIn ? route.fulfill({ json: { user: { id: "admin-1", role: "admin", debugMode: false } } }) : route.fulfill({ status: 401, json: { error: "Authentication required" } }));
  await page.route("**/admin/setup/progress", (route) => route.fulfill({ json: { completedSteps: ["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"].map((step) => ({ step })) } }));
}

/** A web kiosk that is already paired (its pairing is put in IndexedDB before the page starts) and gets `logoData`. */
export async function usePairedWebKiosk(page: LogoPage, logoData: string) {
  await page.addInitScript(() => {
    const request = indexedDB.open("lancerlogin-web-kiosk", 2);
    request.onupgradeneeded = () => { request.result.createObjectStore("state"); request.result.createObjectStore("queue", { keyPath: "seq", autoIncrement: true }).createIndex("eventId", "eventId", { unique: true }); };
    request.onsuccess = () => { request.result.transaction("state", "readwrite").objectStore("state").put({ kioskId: "web-kiosk-logo", kioskToken: "synthetic-token", pairingId: "pairing-logo", name: "Front desk" }, "pairing"); request.result.close(); };
  });
  await page.route("**/kiosk/config", (route) => route.fulfill({ json: { kiosk: { id: "web-kiosk-logo", name: "Front desk" }, settings: { organizationName: "Reference Arts Collective", logoData, primaryColor: "#7c3aed", secondaryColor: "#0f766e", logoBackdrop: "auto", authenticationMethod: "member_id", kind: "web", memberLookup: "entry" } } }));
  await page.route("**/kiosk/roster", (route) => route.fulfill({ json: { members: [] } }));
  await page.route("**/kiosk/commands", (route) => route.fulfill({ json: { command: null } }));
  await page.route("**/kiosk/heartbeat", (route) => route.fulfill({ json: { ok: true, kioskId: "web-kiosk-logo", receivedAt: new Date().toISOString() } }));
}

/** For each `selector` image, once it and the page fonts have loaded: its box, the box of its closest `frameSelector` ancestor, its natural size, and whether that frame is drawn plain (contrast background None: no padding). */
export async function logoBoxes(page: LogoPage, selector: string, frameSelector: string) {
  return page.evaluate(async ({ selector, frameSelector }) => {
    const box = (element: Element) => { const bounds = element.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }; };
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(selector));
    // Web fonts change the height of the text beside a logo, so measure only once they are in.
    await document.fonts.ready;
    await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
    return images.map((image) => { const frame = image.closest(frameSelector)!; return { image: box(image), frame: box(frame), natural: { width: image.naturalWidth, height: image.naturalHeight }, plain: frame.classList.contains("backdrop-none") }; });
  }, { selector, frameSelector });
}

/** True when `inner` has a size and lies wholly inside `outer`, allowing for sub-pixel rounding. */
export function inside(inner: Box, outer: Box, slack = 0.6) {
  return inner.width > 0 && inner.height > 0 && inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;
}
export function overlaps(a: Box, b: Box) { return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height; }
