#!/usr/bin/env bash
set -euo pipefail

VERSION="${LANCERLOGIN_VERSION:-0.1.0}"
MODE="${1:---dry-run}"
RELEASE_ROOT="https://github.com/isriah/LancerLogin/releases/download/v${VERSION}"

architecture() {
  case "$(uname -m)" in
    aarch64) echo arm64 ;;
    armv7l) echo armv7 ;;
    *) echo unsupported ;;
  esac
}

check_hardware() {
  local arch memory_mb model
  arch="$(architecture)"
  memory_mb="$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)"
  model="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || true)"
  [[ "$arch" != unsupported ]] || { echo "Unsupported CPU. Use a 32-bit or 64-bit Raspberry Pi OS image." >&2; return 1; }
  [[ "$memory_mb" -ge 900 ]] || { echo "At least 1 GB RAM is required." >&2; return 1; }
  [[ "$model" == *"Raspberry Pi 3 Model B Plus"* || "$model" == *"Raspberry Pi 4 Model B"* || "$model" == *"Raspberry Pi 5 Model B"* ]] || echo "Warning: this model is outside the tested Pi 3B+/4/5 matrix: ${model:-unknown}"
  echo "Hardware check: ${model:-Raspberry Pi}, ${memory_mb} MB RAM, ${arch}."
}

if [[ "$MODE" == "--dry-run" ]]; then
  echo "LancerLogin guided installer preview"
  echo "1. Verify Raspberry Pi 3B+/4/5, >=1 GB RAM, network, UART, and display."
  echo "2. Download the fixed v${VERSION} kiosk artifact and SHA-256 checksum."
  echo "3. Install into /opt/lancerlogin with a dedicated system user."
  echo "4. Ask for the adopter's Worker API URL and one-time pairing code."
  echo "5. Store the resulting kiosk credential owner-only and start the local service."
  echo "Dry-run complete: no files, services, hardware, accounts, or network were changed."
  exit 0
fi

[[ "$MODE" == "--install" ]] || { echo "Use --dry-run to preview or --install to proceed." >&2; exit 2; }
[[ "${EUID}" -eq 0 ]] || { echo "Run the installer as root with sudo." >&2; exit 2; }
check_hardware
for command in curl sha256sum tar systemctl node; do command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 2; }; done

arch="$(architecture)"
archive="lancerlogin-kiosk-${VERSION}-linux-${arch}.tar.gz"
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 "$RELEASE_ROOT/$archive" --output "$temporary/$archive"
curl --fail --location --proto '=https' --tlsv1.2 "$RELEASE_ROOT/$archive.sha256" --output "$temporary/$archive.sha256"
(cd "$temporary" && sha256sum --check "$archive.sha256")

id lancerlogin >/dev/null 2>&1 || useradd --system --home /var/lib/lancerlogin --shell /usr/sbin/nologin lancerlogin
install -d -m 0755 -o root -g root /opt/lancerlogin
install -d -m 0700 -o lancerlogin -g lancerlogin /var/lib/lancerlogin
tar --extract --gzip --file "$temporary/$archive" --directory /opt/lancerlogin --no-same-owner

read -r -p "Worker API URL from the GitHub workflow summary: " api_url
read -r -p "Kiosk name [Main kiosk]: " kiosk_name
kiosk_name="${kiosk_name:-Main kiosk}"
read -r -s -p "One-time pairing code from the dashboard: " pairing_code
echo
sudo -u lancerlogin node /opt/lancerlogin/src/pair-cli.mjs "$api_url" "$pairing_code" "$kiosk_name"
unset pairing_code

install -m 0644 /opt/lancerlogin/systemd/lancerlogin-kiosk.service /etc/systemd/system/lancerlogin-kiosk.service
systemctl daemon-reload
systemctl enable --now lancerlogin-kiosk.service
echo "LancerLogin kiosk installed. Open http://127.0.0.1:8788/health locally to verify service state."
