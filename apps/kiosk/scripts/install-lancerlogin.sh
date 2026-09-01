#!/usr/bin/env bash
set -euo pipefail

VERSION="${LANCERLOGIN_VERSION:-0.3.0}"
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
  echo "4. Ask once for the dashboard-generated, time-limited pairing key."
  echo "5. Store the resulting kiosk credential owner-only and start the local service."
  echo "6. Configure an installed Chromium browser to open the local touch kiosk at desktop login."
  echo "Dry-run complete: no files, services, hardware, accounts, or network were changed."
  exit 0
fi

[[ "$MODE" == "--install" ]] || { echo "Use --dry-run to preview or --install to proceed." >&2; exit 2; }
[[ "${EUID}" -eq 0 ]] || { echo "Run the installer as root with sudo." >&2; exit 2; }
check_hardware
for command in curl sha256sum tar systemctl runuser ss nmcli; do command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 2; }; done
[[ -x /usr/bin/node ]] || { echo "Node.js 18 or newer must be installed at /usr/bin/node." >&2; exit 2; }
node_major="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 18 ]] || { echo "Node.js 18 or newer is required." >&2; exit 2; }

arch="$(architecture)"
archive="lancerlogin-kiosk-${VERSION}-linux-${arch}.tar.gz"
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 "$RELEASE_ROOT/$archive" --output "$temporary/$archive"
curl --fail --location --proto '=https' --tlsv1.2 "$RELEASE_ROOT/$archive.sha256" --output "$temporary/$archive.sha256"
(cd "$temporary" && sha256sum --check "$archive.sha256")

id lancerlogin >/dev/null 2>&1 || useradd --system --home /var/lib/lancerlogin --shell /usr/sbin/nologin lancerlogin
usermod --append --groups dialout lancerlogin
[[ -e /dev/serial0 ]] || echo "Warning: /dev/serial0 is unavailable. Enable the Pi UART before starting LancerLogin."
systemctl stop lancerlogin-kiosk.service 2>/dev/null || true
if ss -H -ltn 'sport = :8788' | grep -q .; then
  echo "Port 8788 is already used by another service. LancerLogin did not disable or replace that service." >&2
  echo "Stop the conflicting kiosk service, then run this installer again:" >&2
  ss -H -ltnp 'sport = :8788' >&2 || true
  exit 1
fi
install -d -m 0755 -o root -g root /opt/lancerlogin
install -d -m 0700 -o lancerlogin -g lancerlogin /var/lib/lancerlogin
tar --extract --gzip --file "$temporary/$archive" --directory /opt/lancerlogin --no-same-owner

install -m 0644 /opt/lancerlogin/systemd/lancerlogin-kiosk.service /etc/systemd/system/lancerlogin-kiosk.service
install -d -m 0755 /etc/polkit-1/rules.d
install -m 0644 /opt/lancerlogin/polkit/49-lancerlogin-network.rules /etc/polkit-1/rules.d/49-lancerlogin-network.rules
install -d -m 0755 /etc/systemd/system/lancerlogin-kiosk.service.d
printf '[Service]\nEnvironment=LANCERLOGIN_VERSION=%s\n' "$VERSION" > /etc/systemd/system/lancerlogin-kiosk.service.d/10-version.conf
chmod 0644 /etc/systemd/system/lancerlogin-kiosk.service.d/10-version.conf
systemctl daemon-reload
systemctl enable lancerlogin-kiosk.service
systemctl restart lancerlogin-kiosk.service
service_ready=false
for _ in $(seq 1 20); do
  if curl --fail --silent --show-error http://127.0.0.1:8788/health >/dev/null; then service_ready=true; break; fi
  sleep 0.5
done
if [[ "$service_ready" != true ]]; then
  echo "LancerLogin was installed, but its local service did not become healthy." >&2
  systemctl status lancerlogin-kiosk.service --no-pager -l >&2 || true
  journalctl -u lancerlogin-kiosk.service -n 30 --no-pager >&2 || true
  exit 1
fi
host_name="$(hostname)"
local_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "LancerLogin is installed, healthy, and waiting for pairing."
echo "On a phone or computer connected to the same network, open http://${host_name}.local:8788/ and paste the one-time pairing key from the dashboard."
[[ -z "$local_ip" ]] || echo "If the .local address does not open, use http://${local_ip}:8788/ instead."
browser_path="$(command -v chromium || command -v chromium-browser || true)"
if [[ -n "$browser_path" ]]; then
  install -d -m 0755 /etc/xdg/autostart
  printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=LancerLogin Kiosk' "Exec=${browser_path} --kiosk --noerrdialogs --disable-infobars http://127.0.0.1:8788/" 'X-GNOME-Autostart-enabled=true' > /etc/xdg/autostart/lancerlogin-kiosk.desktop
  chmod 0644 /etc/xdg/autostart/lancerlogin-kiosk.desktop
  echo "Chromium will open LancerLogin in kiosk mode at the next desktop login."
else
  echo "Chromium was not found. Install it with Raspberry Pi OS software management, then open http://127.0.0.1:8788/ locally."
fi
echo "The kiosk can also open http://127.0.0.1:8788/ locally to scan, enroll, and verify service state."
