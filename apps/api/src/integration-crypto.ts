const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), (character) => character.charCodeAt(0));
const buffer = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;

async function keyFrom(secret: string) {
  const bytes = decode(secret);
  if (bytes.length !== 32) throw new Error("INTEGRATION_KEY must contain exactly 32 random bytes");
  return crypto.subtle.importKey("raw", buffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptIntegration(value: Record<string, string>, secret: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFrom(secret), encoder.encode(JSON.stringify(value))));
  return { ciphertext: encode(ciphertext), iv: encode(iv) };
}

export async function decryptIntegration(ciphertext: string, iv: string, secret: string): Promise<Record<string, string>> {
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, await keyFrom(secret), buffer(decode(ciphertext)));
  return JSON.parse(decoder.decode(plaintext)) as Record<string, string>;
}
