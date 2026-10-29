export function hardwarePairingKey(apiUrl: string, code: string, kioskName: string) {
  const bytes = new TextEncoder().encode(JSON.stringify({ apiUrl, code, kioskName: kioskName.trim() || "Main kiosk" })); let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `LL1.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

const releaseVersion = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const latestKioskInstallerUrl = "https://github.com/isriah/LancerLogin/releases/latest/download/install-lancerlogin.sh";

/** The guided Pi installer published with the given release. A development build without a release version falls back to releases/latest/download/install-lancerlogin.sh. */
export function kioskInstallerUrlFor(version: string) {
  const value = version.replace(/^v/, "");
  return releaseVersion.test(value) ? `https://github.com/isriah/LancerLogin/releases/download/v${value}/install-lancerlogin.sh` : latestKioskInstallerUrl;
}

/** The release this dashboard was built from; the kiosk installer is pinned to it so a beta dashboard never installs the stable kiosk. */
export const dashboardReleaseVersion = __LANCERLOGIN_VERSION__.replace(/^v/, "");
export const kioskInstallerUrl = kioskInstallerUrlFor(dashboardReleaseVersion);

/** Shell commands an Admin runs on the Pi, in order. The installer prints what it will change before `--install` changes anything. */
export function kioskInstallCommands(fingerprintReader: boolean, installerUrl = kioskInstallerUrl) {
  const reader = fingerprintReader ? "" : " --no-fingerprint-reader";
  return [`curl -fLO ${installerUrl}`, `sudo bash install-lancerlogin.sh --dry-run${reader}`, `sudo bash install-lancerlogin.sh --install${reader}`].join("\n");
}
