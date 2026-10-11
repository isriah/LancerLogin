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

export function identityReadyState(method) {
  const normalized = normalizeIdentityMethod(method);
  if (normalized === "fingerprint") return { message: "Place finger on reader", detail: "Attendance kiosk ready" };
  if (normalized === "member_id") return { message: "Enter member ID", detail: "Use the touch keyboard below" };
  if (normalized === "qr") return { message: "Scan QR code", detail: "Present a registered code to the scanner" };
  return { message: `Present ${normalized.toUpperCase()} badge`, detail: "Hold a registered badge near the reader" };
}

export function identityUnknownState(method) {
  const normalized = normalizeIdentityMethod(method);
  if (normalized === "fingerprint") return { message: "Fingerprint not recognized", detail: "Try the same finger again, or ask an operator for help" };
  if (normalized === "member_id") return { message: "Member ID not recognized", detail: "Check the member ID and try again" };
  return { message: "Credential not recognized", detail: `This ${identityMethodLabels[normalized].toLowerCase()} is not registered` };
}
