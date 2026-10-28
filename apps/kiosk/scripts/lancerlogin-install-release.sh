#!/usr/bin/env bash
set -euo pipefail

# This helper has no URL or command-line override. Root-owned policy revalidates
# a short-lived exact official target supplied by the authenticated kiosk service.
readonly DOWNLOAD_ROOT="https://github.com/isriah/LancerLogin/releases/download"
[[ "$#" -eq 0 ]] || { echo "This official update helper accepts no arguments." >&2; exit 2; }

temporary=""
was_active=false
cleanup() {
  status=$?
  [[ -z "$temporary" ]] || rm -rf -- "$temporary"
  if [[ "$status" -ne 0 && "$was_active" == true ]]; then
    systemctl start lancerlogin-kiosk.service || true
  fi
  exit "$status"
}

main() {
  temporary="$(mktemp -d)"
  trap cleanup EXIT
  trap 'exit 143' TERM INT HUP

  if systemctl is-active --quiet lancerlogin-kiosk.service; then
    was_active=true
  fi

  # The resolver verifies tag, commit, track, immutability and the single-use command id, then prints
  # the version and the GitHub API SHA-256 digests of the installer and both kiosk archives.
  local resolved version installer_sha256 arm64_sha256 armv7_sha256 extra
  resolved="$(/usr/bin/node /opt/lancerlogin/src/resolve-kiosk-release.mjs)" || { echo "The official kiosk update could not be verified." >&2; exit 1; }
  rm -f -- /var/lib/lancerlogin/update-request.json
  read -r version installer_sha256 arm64_sha256 armv7_sha256 extra <<<"$resolved" || true
  [[ -z "${extra:-}" && "${version:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$ ]] || { echo "The official kiosk update target was malformed." >&2; exit 1; }
  for digest in "${installer_sha256:-}" "${arm64_sha256:-}" "${armv7_sha256:-}"; do
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { echo "The official kiosk update digest was malformed." >&2; exit 1; }
  done

  local release_root="$DOWNLOAD_ROOT/v$version"
  curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 --retry 2 "$release_root/install-lancerlogin.sh" --output "$temporary/install-lancerlogin.sh"
  printf '%s  %s\n' "$installer_sha256" install-lancerlogin.sh > "$temporary/install-lancerlogin.sh.sha256"
  (cd "$temporary" && sha256sum --check --strict --quiet install-lancerlogin.sh.sha256) || { echo "The downloaded installer does not match the immutable release digest." >&2; exit 1; }

  LANCERLOGIN_VERSION="$version" LANCERLOGIN_ARCHIVE_SHA256_ARM64="$arm64_sha256" LANCERLOGIN_ARCHIVE_SHA256_ARMV7="$armv7_sha256" \
    /usr/bin/bash "$temporary/install-lancerlogin.sh" --install
}

# Parse the whole invocation before running it. An installer replaces this file, and bash must not read
# further bytes from a changed script after the installer returns.
{ main "$@"; exit $?; }
