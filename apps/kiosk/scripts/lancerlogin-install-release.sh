#!/usr/bin/env bash
set -euo pipefail

# This helper has no URL or command-line override. Root-owned policy revalidates
# a short-lived exact official target supplied by the authenticated kiosk service.
readonly DOWNLOAD_ROOT="https://github.com/isriah/LancerLogin/releases/download"
[[ "$#" -eq 0 ]] || { echo "This official update helper accepts no arguments." >&2; exit 2; }

temporary="$(mktemp -d)"
was_active=false
cleanup() {
  status=$?
  rm -rf -- "$temporary"
  if [[ "$status" -ne 0 && "$was_active" == true ]]; then
    systemctl start lancerlogin-kiosk.service || true
  fi
  exit "$status"
}
trap cleanup EXIT

if systemctl is-active --quiet lancerlogin-kiosk.service; then
  was_active=true
fi

version="$(/usr/bin/node /opt/lancerlogin/src/resolve-kiosk-release.mjs)" || { echo "The official kiosk update could not be verified." >&2; exit 1; }
rm -f -- /var/lib/lancerlogin/update-request.json

release_root="$DOWNLOAD_ROOT/v$version"
curl --fail --location --proto '=https' --tlsv1.2 "$release_root/install-lancerlogin.sh" --output "$temporary/install-lancerlogin.sh"
curl --fail --location --proto '=https' --tlsv1.2 "$release_root/install-lancerlogin.sh.sha256" --output "$temporary/install-lancerlogin.sh.sha256"
(cd "$temporary" && sha256sum --check install-lancerlogin.sh.sha256)

LANCERLOGIN_VERSION="$version" /usr/bin/bash "$temporary/install-lancerlogin.sh" --install
