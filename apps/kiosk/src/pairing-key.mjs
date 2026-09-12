export function decodePairingKey(value) {
  if (typeof value !== "string" || !value.startsWith("LL1.") || value.length > 2048) throw new Error("Paste a valid LancerLogin one-time pairing key");
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(4), "base64url").toString("utf8"));
    if (!decoded.apiUrl || !decoded.code || !decoded.kioskName) throw new Error();
    return decoded;
  } catch { throw new Error("The pairing key is invalid. Create a new key in the dashboard and try again."); }
}
