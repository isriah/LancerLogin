export const identityMethods = Object.freeze(["fingerprint", "rfid", "nfc", "member_id", "qr"]);

export const identityMethodLabels = Object.freeze({
  fingerprint: "Fingerprint",
  rfid: "RFID badge",
  nfc: "NFC badge",
  member_id: "Member ID entry",
  qr: "QR code",
});

export function normalizeIdentityMethod(value) {
  return identityMethods.includes(value) ? value : "fingerprint";
}

/** A Discord code: six digits. Spaces are dropped, so "482 916" reads as typed in Discord's reply. */
export function normalizeDiscordCode(value) {
  if (typeof value !== "string" || value.length > 16) return undefined;
  const code = value.replace(/\s+/g, "");
  return /^\d{6}$/.test(code) ? code : undefined;
}

/** The note on the backup method's start screen while a Discord code kiosk cannot reach the server. */
export const discordCodeOfflineNote = (memberLookup) => `Discord codes need a network connection. ${memberLookup === "search" ? "Search for your name instead." : "Sign in with your member ID instead."}`;
/** The same note while the server answers but earlier scans still wait to sync: codes are held so scans stay in order. */
export const discordCodeHeldNote = (memberLookup) => `Discord codes are paused while earlier scans sync. ${memberLookup === "search" ? "Search for your name instead." : "Sign in with your member ID instead."}`;
/** The button on the code screen that opens the backup method. */
export const discordCodeBackupLabel = (memberLookup) => memberLookup === "search" ? "No code? Search for your name" : "No code? Use member ID";

/** What a member ID kiosk is called where its identification mode is shown. */
export const memberModeLabel = ({ discordCode = false } = {}) => discordCode ? "Discord code" : "Member ID";

/**
 * The start screen's text. At a Discord code kiosk it is the code entry while the server can be reached (`cloudOnline`
 * true, or unknown) and no earlier scan is holding codes back (`codesHeld`), and otherwise the backup method with a
 * note saying why.
 */
export function identityReadyState(method, { memberLookup = "entry", discordCode = false, cloudOnline, codesHeld = false } = {}) {
  const normalized = normalizeIdentityMethod(method);
  if (normalized === "fingerprint") return { message: "Place finger on reader", detail: "Attendance kiosk ready" };
  if (normalized === "member_id" && discordCode && cloudOnline !== false && !codesHeld) return { message: "Enter your Discord code", detail: "Run /code in the team Discord to get one." };
  const notice = normalized === "member_id" && discordCode ? { notice: (cloudOnline !== false && codesHeld ? discordCodeHeldNote : discordCodeOfflineNote)(memberLookup) } : {};
  if (normalized === "member_id" && memberLookup === "search") return { message: "Find your name", detail: "Search by name, member ID or email", ...notice };
  if (normalized === "member_id") return { message: "Enter member ID", detail: "Use the touch keyboard below", ...notice };
  if (normalized === "qr") return { message: "Scan QR code", detail: "Present a registered code to the scanner" };
  return { message: `Present ${normalized.toUpperCase()} badge`, detail: "Hold a registered badge near the reader" };
}

export function identityUnknownState(method) {
  const normalized = normalizeIdentityMethod(method);
  if (normalized === "fingerprint") return { message: "Fingerprint not recognized", detail: "Try the same finger again, or ask an operator for help" };
  if (normalized === "member_id") return { message: "Member ID not recognized", detail: "Check the member ID and try again" };
  return { message: "Credential not recognized", detail: `This ${identityMethodLabels[normalized].toLowerCase()} is not registered` };
}
