export function hardwarePairingKey(apiUrl: string, code: string, kioskName: string) {
  const bytes = new TextEncoder().encode(JSON.stringify({ apiUrl, code, kioskName: kioskName.trim() || "Main kiosk" })); let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `LL1.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export const kioskInstallerUrl = "https://github.com/isriah/LancerLogin/releases/latest/download/install-lancerlogin.sh";
