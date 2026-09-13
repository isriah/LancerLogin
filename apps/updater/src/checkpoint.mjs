const encoder = new TextEncoder();
export const toBase64 = bytes => {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
};
export const fromBase64 = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));

// Raw key is supplied only by updater bootstrap, never by an application request.
export async function createCheckpointCipher(rawKey, installationId) {
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== 32) throw Error('checkpoint-key');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(rawKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const additionalData = context => encoder.encode(`LancerLogin updater checkpoint v1\n${installationId}\n${context}`);
  return Object.freeze({
    async seal(context, value) {
      const bytes = encoder.encode(JSON.stringify(value));
      if (bytes.length > 262144) throw Error('checkpoint-size');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(context) }, key, bytes);
      return { format: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
    },
    async open(context, envelope) {
      try {
        if (envelope.format !== 1 || envelope.ciphertext.length > 350000) throw Error();
        const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: additionalData(context) }, key, fromBase64(envelope.ciphertext));
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch { throw Error('checkpoint-integrity'); }
    },
  });
}
