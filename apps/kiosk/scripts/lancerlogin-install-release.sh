#!/usr/bin/env bash
set -euo pipefail

# This helper intentionally has no release, URL, or command-line override.
readonly GITHUB_API="https://api.github.com/repos/isriah/LancerLogin/releases/latest"
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

curl --fail --location --proto '=https' --tlsv1.2 "$GITHUB_API" --output "$temporary/release.json"
version="$(/usr/bin/node -e '
const release = require(process.argv[1]);
const tag = release.tag_name;
if (release.draft !== false || release.prerelease !== false || typeof tag !== "string" || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?![\s\S])/.test(tag) || !Array.isArray(release.assets)) process.exit(2);
const names = new Set(release.assets.map((asset) => asset?.name));
const required = ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => {
  const archive = `lancerlogin-kiosk-${tag.slice(1)}-linux-${arch}.tar.gz`;
  return [archive, `${archive}.sha256`];
})];
if (!required.every((name) => names.has(name))) process.exit(2);
process.stdout.write(tag.slice(1));
' "$temporary/release.json")" || { echo "Latest stable release is missing its verified kiosk installer." >&2; exit 1; }

release_root="$DOWNLOAD_ROOT/v$version"
curl --fail --location --proto '=https' --tlsv1.2 "$release_root/install-lancerlogin.sh" --output "$temporary/install-lancerlogin.sh"
curl --fail --location --proto '=https' --tlsv1.2 "$release_root/install-lancerlogin.sh.sha256" --output "$temporary/install-lancerlogin.sh.sha256"
(cd "$temporary" && sha256sum --check install-lancerlogin.sh.sha256)

LANCERLOGIN_VERSION="$version" /usr/bin/bash "$temporary/install-lancerlogin.sh" --install
