#!/usr/bin/env bash
set -euo pipefail

VERSION="${LANCERLOGIN_VERSION:-0.10.1}"
MODE="${1:---dry-run}"
RELEASE_ROOT="https://github.com/isriah/LancerLogin/releases/download/v${VERSION}"
RELEASE_API="https://api.github.com/repos/isriah/LancerLogin/releases/tags/v${VERSION}"
SENSOR_PATH="${LANCERLOGIN_SENSOR_PATH:-/dev/serial0}"
SENSOR_PATH_EXPLICIT=false
[[ -z "${LANCERLOGIN_SENSOR_PATH+x}" ]] || SENSOR_PATH_EXPLICIT=true
SENSOR_OPTION="${2:-}"
[[ -z "$SENSOR_OPTION" || "$SENSOR_OPTION" == "--no-fingerprint-reader" || "$SENSOR_OPTION" == "--fingerprint-reader" ]] || { echo "Optional second argument must be --no-fingerprint-reader or --fingerprint-reader." >&2; exit 2; }
if [[ "$SENSOR_OPTION" == "--no-fingerprint-reader" ]]; then SENSOR_PATH=disabled; SENSOR_PATH_EXPLICIT=true; fi
if [[ "$SENSOR_OPTION" == "--fingerprint-reader" ]]; then SENSOR_PATH=/dev/serial0; SENSOR_PATH_EXPLICIT=true; fi

# Each release is extracted into its own directory under releases/ and activated by
# atomically renaming the `current` symlink. `previous` keeps the last healthy release
# for automatic rollback. `src` stays a stable entry point (current/src) for the root
# update helper and desktop launcher.
RUNTIME_ROOT=/opt/lancerlogin
RELEASES_DIR="$RUNTIME_ROOT/releases"
STATE_ROOT=/var/lib/lancerlogin
UNIT_DIR=/etc/systemd/system
DROPIN_DIR="$UNIT_DIR/lancerlogin-kiosk.service.d"
POLKIT_DIR=/etc/polkit-1/rules.d
HELPER_PATH=/usr/local/sbin/lancerlogin-install-release
LAUNCHER_PATH=/usr/local/bin/lancerlogin-open-kiosk
NODE=/usr/bin/node
HEALTH_URL=http://127.0.0.1:8788/health
HEALTH_ATTEMPTS=180
RELEASE_NAME_PATTERN='^[0-9A-Za-z][0-9A-Za-z._+-]*$'

architecture() {
  case "$(uname -m)" in
    aarch64) echo arm64 ;;
    armv7l) echo armv7 ;;
    *) echo unsupported ;;
  esac
}

# Runtime code is separate from owner-only pairing and attendance state.
# Refuse links before changing modes; release trees contain only directories and files.
normalize_tree_permissions() {
  local tree="$1"
  [[ -z "$(find "$tree" -xdev ! -type d ! -type f -print -quit)" ]] || { echo "Unexpected runtime file type. Review $tree before installing." >&2; return 1; }
  [[ -z "$(find "$tree" -xdev -type f -links +1 -print -quit)" ]] || { echo "Unexpected runtime hard link. Review $tree before installing." >&2; return 1; }
  find "$tree" -xdev -type d -exec chmod 0755 {} +
  find "$tree" -xdev -type f -exec chmod 0644 {} +
  [[ ! -d "$tree/scripts" ]] || find "$tree/scripts" -xdev -type f -name '*.sh' -exec chmod 0755 {} +
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

# Atomically point RUNTIME_ROOT/<name> at <target> (rename of a new symlink over the old one).
point_link() {
  local name="$1" target="$2" temporary_link
  temporary_link="$RUNTIME_ROOT/.link-$name.new"
  rm -f -- "$temporary_link"
  ln -s -- "$target" "$temporary_link"
  mv -T -f -- "$temporary_link" "$RUNTIME_ROOT/$name"
}

# Print the release directory name a layout link points at, or nothing when the link is absent.
linked_release() {
  local name="$1" target release
  [[ -L "$RUNTIME_ROOT/$name" ]] || { [[ ! -e "$RUNTIME_ROOT/$name" ]] && return 0; echo "Unexpected $RUNTIME_ROOT/$name. Review it before installing." >&2; return 1; }
  target="$(readlink -- "$RUNTIME_ROOT/$name")"
  release="${target#releases/}"
  if [[ "$target" != "releases/$release" || ! "$release" =~ $RELEASE_NAME_PATTERN || -L "$RELEASES_DIR/$release" || ! -d "$RELEASES_DIR/$release" ]]; then
    [[ "$name" == previous ]] && return 0 # A stale rollback pointer is replaced after the next healthy install.
    echo "Unexpected $RUNTIME_ROOT/$name link. Review it before installing." >&2; return 1
  fi
  printf '%s\n' "$release"
}

# A pre-versioned install keeps its code directly in RUNTIME_ROOT.
legacy_layout() {
  [[ ! -e "$RUNTIME_ROOT/current" && ! -L "$RUNTIME_ROOT/current" && -d "$RUNTIME_ROOT/src" && ! -L "$RUNTIME_ROOT/src" ]]
}

check_runtime_layout() {
  local entry name
  if legacy_layout; then
    [[ -f "$RUNTIME_ROOT/src/service.mjs" ]] || { echo "Unexpected content in $RUNTIME_ROOT. Review it before installing." >&2; return 1; }
    [[ ! -e "$RELEASES_DIR" ]] || [[ -d "$RELEASES_DIR" && ! -L "$RELEASES_DIR" ]] || { echo "Unexpected $RELEASES_DIR. Review it before installing." >&2; return 1; }
    local legacy_entry
    for legacy_entry in "$RUNTIME_ROOT"/* "$RUNTIME_ROOT"/.[!.]*; do
      [[ -e "$legacy_entry" || -L "$legacy_entry" ]] || continue
      [[ "${legacy_entry##*/}" == releases ]] || normalize_tree_permissions "$legacy_entry"
    done
    return 0
  fi
  for entry in "$RUNTIME_ROOT"/* "$RUNTIME_ROOT"/.[!.]*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name="${entry##*/}"
    case "$name" in
      releases) [[ -d "$entry" && ! -L "$entry" ]] || { echo "Unexpected $entry. Review it before installing." >&2; return 1; } ;;
      current | previous) linked_release "$name" >/dev/null ;;
      src) [[ -L "$entry" && "$(readlink -- "$entry")" == current/src ]] || { echo "Unexpected $entry. Review it before installing." >&2; return 1; } ;;
      .link-*.new) rm -f -- "$entry" ;;
      *) echo "Unexpected $entry. Review it before installing." >&2; return 1 ;;
    esac
  done
  [[ -L "$RUNTIME_ROOT/current" || ! -e "$RUNTIME_ROOT/src" ]] || { echo "Unexpected $RUNTIME_ROOT/src without a current release. Review it before installing." >&2; return 1; }
}

installed_version_label() {
  local label=""
  if [[ -f "$DROPIN_DIR/10-version.conf" ]]; then
    label="$(sed -n 's/^Environment=LANCERLOGIN_VERSION=//p' "$DROPIN_DIR/10-version.conf" | head -n 1)"
  fi
  label="$(printf '%s' "$label" | tr -c '0-9A-Za-z.-' '_' | cut -c1-64)"
  printf '%s\n' "${label:-unknown}"
}

# Move a pre-versioned install into releases/legacy_<version> and point `current` at it.
# Every move is a same-filesystem rename; a failed move puts earlier entries back.
migrate_legacy_layout() {
  local name entry moved=() item
  name="legacy_$(installed_version_label)"
  install -d -m 0755 "$RELEASES_DIR"
  [[ ! -e "$RELEASES_DIR/$name" ]] || name="${name}_$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -m 0755 -- "$RELEASES_DIR/$name"
  for entry in "$RUNTIME_ROOT"/* "$RUNTIME_ROOT"/.[!.]*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    [[ "${entry##*/}" != releases ]] || continue
    if mv -- "$entry" "$RELEASES_DIR/$name/"; then
      moved+=("${entry##*/}")
    else
      for item in "${moved[@]}"; do mv -- "$RELEASES_DIR/$name/$item" "$RUNTIME_ROOT/" || true; done
      rmdir -- "$RELEASES_DIR/$name" || true
      echo "The existing installation could not be moved into $RELEASES_DIR. It was left in place." >&2
      return 1
    fi
  done
  point_link current "releases/$name"
  point_link src current/src
  echo "Moved the existing installation into $RELEASES_DIR/$name."
}

# Check syntax as root without executing code, then import the service as an unprivileged
# account with isolated state, the way release packaging verifies each archive.
smoke_release() {
  local tree="$1" file smoke_state key
  for file in "$tree"/src/*.mjs; do
    "$NODE" --check "$file" || { echo "The new release failed its syntax check: ${file##*/}." >&2; return 1; }
  done
  id nobody >/dev/null 2>&1 || { echo "Warning: no nobody account; skipped the unprivileged import check."; return 0; }
  smoke_state="$(mktemp -d)"
  chown nobody "$smoke_state"
  local environment=(PATH=/usr/bin:/bin NODE_ENV=test LANCERLOGIN_SENSOR_PATH=disabled LANCERLOGIN_KIOSK_PORT=0)
  for key in CONFIG BRANDING NETWORK_PIN AUTHENTICATION CREDENTIAL_MAPPINGS ROSTER_CACHE QUEUE MAPPINGS FINGERPRINT_RESET FINGERPRINT_REVIEW FINGERPRINT_SYNC FINGERPRINT_VAULT; do
    environment+=("LANCERLOGIN_${key}=$smoke_state/${key}")
  done
  if ! (cd "$tree" && timeout 90 runuser -u nobody -- env -i "${environment[@]}" "$NODE" --input-type=module --eval 'await import(process.argv[1]); await import(process.argv[2]); process.exit(0);' "$tree/src/service.mjs" "$tree/src/resolve-kiosk-release.mjs" >/dev/null); then
    rm -rf -- "$smoke_state"
    echo "The new release failed its import check on this kiosk. The running release was not changed." >&2
    return 1
  fi
  rm -rf -- "$smoke_state"
}

# Extract into a staging directory, verify it, then rename it into releases/<name>.
stage_release() {
  local archive_path="$1" name="$2" staging file
  staging="$RELEASES_DIR/.staging-$name"
  install -d -m 0755 "$RELEASES_DIR"
  rm -rf -- "$staging"
  mkdir -m 0755 -- "$staging"
  tar --extract --gzip --file "$archive_path" --directory "$staging" --no-same-owner
  # tar can replace the destination mode with the archive root mode. Code must
  # remain traversable by the service account; private state stays 0700.
  chmod 0755 "$staging"
  normalize_tree_permissions "$staging"
  for file in src/service.mjs src/resolve-kiosk-release.mjs src/clean-version-overrides.mjs scripts/lancerlogin-install-release.sh scripts/lancerlogin-open-kiosk.sh systemd/lancerlogin-kiosk.service systemd/lancerlogin-update.service polkit/49-lancerlogin-network.rules polkit/49-lancerlogin-recovery.rules polkit/49-lancerlogin-update.rules; do
    [[ -f "$staging/$file" ]] || { echo "The new release is incomplete: $file is missing." >&2; return 1; }
  done
  smoke_release "$staging"
  mv -T -- "$staging" "$RELEASES_DIR/$name"
}

SYSTEM_FILES=("$UNIT_DIR/lancerlogin-kiosk.service" "$UNIT_DIR/lancerlogin-update.service" "$HELPER_PATH" "$POLKIT_DIR/49-lancerlogin-network.rules" "$POLKIT_DIR/49-lancerlogin-recovery.rules" "$POLKIT_DIR/49-lancerlogin-update.rules")

# Root-only copy of the system files a release installs, so rollback restores them exactly.
backup_system_files() {
  local backup="$1" index
  mkdir -m 0700 -- "$backup"
  for index in "${!SYSTEM_FILES[@]}"; do
    if [[ -e "${SYSTEM_FILES[$index]}" ]]; then cp -a -- "${SYSTEM_FILES[$index]}" "$backup/$index"; else : > "$backup/$index.absent"; fi
  done
  if [[ -d "$DROPIN_DIR" ]]; then cp -a -- "$DROPIN_DIR" "$backup/dropins"; else : > "$backup/dropins.absent"; fi
}

restore_system_files() {
  local backup="$1" index file
  for index in "${!SYSTEM_FILES[@]}"; do
    file="${SYSTEM_FILES[$index]}"
    if [[ -e "$backup/$index" ]]; then
      cp -a -- "$backup/$index" "$file.rollback"
      mv -f -- "$file.rollback" "$file"
    elif [[ -e "$backup/$index.absent" ]]; then
      rm -f -- "$file"
    fi
  done
  if [[ -d "$backup/dropins" ]]; then
    rm -rf -- "$DROPIN_DIR"
    cp -a -- "$backup/dropins" "$DROPIN_DIR"
  elif [[ -e "$backup/dropins.absent" ]]; then
    rm -rf -- "$DROPIN_DIR"
  fi
}

# Replace a file with a rename so a running script (such as the update helper) keeps its old bytes.
install_atomic() {
  local mode="$1" source="$2" destination="$3" temporary_file
  temporary_file="${destination%/*}/.${destination##*/}.new"
  rm -f -- "$temporary_file"
  install -m "$mode" -- "$source" "$temporary_file"
  mv -f -- "$temporary_file" "$destination"
}

kiosk_healthy() {
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$HEALTH_URL" >/dev/null 2>&1
}

# Healthy means /health answers, then still answers a few seconds later (no crash loop).
wait_until_healthy() {
  local attempt
  for ((attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++)); do
    if kiosk_healthy; then
      sleep 3
      kiosk_healthy && systemctl is-active --quiet lancerlogin-kiosk.service && return 0
    fi
    sleep 0.5
  done
  return 1
}

# Remove releases other than the active one and the rollback target, and stale staging directories.
prune_releases() {
  local keep_current="$1" keep_previous="$2" entry name
  for entry in "$RELEASES_DIR"/* "$RELEASES_DIR"/.[!.]*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name="${entry##*/}"
    [[ "$name" == "$keep_current" || ( -n "$keep_previous" && "$name" == "$keep_previous" ) ]] && continue
    rm -rf -- "$entry"
  done
}

phase=prepare
kiosk_was_active=false
previous_release=""
new_release=""
temporary=""

rollback_release() {
  echo "The new release did not become healthy. Restoring ${previous_release:-the previous system files}." >&2
  systemctl status lancerlogin-kiosk.service --no-pager -l >&2 || true
  journalctl -u lancerlogin-kiosk.service -n 30 --no-pager >&2 || true
  [[ -z "$previous_release" ]] || point_link current "releases/$previous_release"
  restore_system_files "$temporary/system-backup"
  systemctl daemon-reload || true
  # The failed release was already started, so restart whatever is current now.
  systemctl restart lancerlogin-kiosk.service || true
  if wait_until_healthy; then echo "The previous release is running again." >&2; else echo "The previous release did not become healthy either. Review the kiosk locally." >&2; fi
  [[ -z "$new_release" || "$new_release" == "$previous_release" ]] || rm -rf -- "${RELEASES_DIR:?}/$new_release"
}

on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 ]]; then
    if [[ "$phase" == switched && -n "$previous_release" ]]; then
      rollback_release || echo "Automatic rollback did not complete. Review $RUNTIME_ROOT locally." >&2
    elif [[ "$phase" == switched ]]; then
      echo "LancerLogin was installed, but its local service did not become healthy." >&2
      systemctl status lancerlogin-kiosk.service --no-pager -l >&2 || true
      journalctl -u lancerlogin-kiosk.service -n 30 --no-pager >&2 || true
    elif [[ "$phase" == stopped && "$kiosk_was_active" == true ]]; then
      systemctl start lancerlogin-kiosk.service || true
    fi
    # A release that was never activated is removed; `current` still points at the running release.
    if [[ ( "$phase" == prepare || "$phase" == stopped ) && -n "$new_release" ]]; then
      rm -rf -- "${RELEASES_DIR:?}/.staging-$new_release" "${RELEASES_DIR:?}/$new_release"
    fi
  fi
  [[ -z "$temporary" ]] || rm -rf -- "$temporary"
  exit "$status"
}

if [[ "$MODE" == "--dry-run" ]]; then
  echo "LancerLogin guided installer preview"
  echo "1. Verify Raspberry Pi 3B+/4/5, >=1 GB RAM, network, display, and UART when fingerprint authentication is used."
  echo "   For RFID, NFC, member ID, or QR-only hardware, add --no-fingerprint-reader when installing."
  echo "2. Download the fixed v${VERSION} kiosk artifact and verify it against the immutable GitHub release digest."
  echo "3. Install into a new release directory under /opt/lancerlogin/releases with a dedicated system user, keeping the previous release for automatic rollback."
  echo "4. Ask once for the dashboard-generated, time-limited pairing key."
  echo "5. Store the resulting kiosk credential owner-only and start the local service."
  echo "6. Configure an installed Chromium browser to open the local touch kiosk at desktop login and from a desktop relaunch shortcut."
  echo "Dry-run complete: no files, services, hardware, accounts, or network were changed."
  exit 0
fi

[[ "$MODE" == "--install" ]] || { echo "Use --dry-run to preview or --install to proceed. Add --no-fingerprint-reader as the second argument when no R503 is installed." >&2; exit 2; }
[[ "${EUID}" -eq 0 ]] || { echo "Run the installer as root with sudo." >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "LANCERLOGIN_VERSION must be a release version." >&2; exit 2; }
[[ "$SENSOR_PATH" == disabled || "$SENSOR_PATH" =~ ^/dev/[A-Za-z0-9._/-]+$ ]] || { echo "LANCERLOGIN_SENSOR_PATH must be disabled or an absolute /dev path." >&2; exit 2; }
check_hardware
for command in curl sha256sum tar systemctl runuser ss nmcli cmp stat timeout df readlink; do command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 2; }; done
[[ -x /usr/bin/flock ]] || { echo "The util-linux flock command is required at /usr/bin/flock." >&2; exit 2; }
[[ -x /usr/bin/node ]] || { echo "Node.js 18 or newer must be installed at /usr/bin/node." >&2; exit 2; }
node_major="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 18 ]] || { echo "Node.js 18 or newer is required." >&2; exit 2; }

# One installer at a time, whether started by the update unit or by an operator.
exec 9>/run/lancerlogin-install.lock
/usr/bin/flock --nonblock 9 || { echo "Another LancerLogin install is already running." >&2; exit 1; }

arch="$(architecture)"
archive="lancerlogin-kiosk-${VERSION}-linux-${arch}.tar.gz"
temporary="$(mktemp -d)"
trap on_exit EXIT
trap 'exit 143' TERM INT HUP
curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 --retry 1 "$RELEASE_ROOT/$archive" --output "$temporary/$archive"

# Trust the archive only through GitHub's digest for an asset of an immutable release.
# The root update helper passes the digests it already verified; a manual install asks the API.
case "$arch" in
  arm64) expected_sha256="${LANCERLOGIN_ARCHIVE_SHA256_ARM64:-}" ;;
  armv7) expected_sha256="${LANCERLOGIN_ARCHIVE_SHA256_ARMV7:-}" ;;
esac
if [[ -z "$expected_sha256" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 --retry 2 --header 'Accept: application/vnd.github+json' --header 'User-Agent: LancerLogin-installer' "$RELEASE_API" --output "$temporary/release.json"
  expected_sha256="$(/usr/bin/node -e '
    const [file, tag, name] = process.argv.slice(1);
    const release = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const assets = Array.isArray(release.assets) ? release.assets.filter((asset) => asset && asset.name === name) : [];
    const digest = assets.length === 1 && typeof assets[0].digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(assets[0].digest) : null;
    if (release.tag_name !== tag || release.draft !== false || release.immutable !== true || release.prerelease !== tag.includes("-beta.") || !digest) process.exit(1);
    process.stdout.write(digest[1]);
  ' "$temporary/release.json" "v${VERSION}" "$archive")" || { echo "v${VERSION} is not a complete immutable official release with a GitHub asset digest." >&2; exit 1; }
fi
[[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || { echo "The expected kiosk archive digest is malformed." >&2; exit 1; }
printf '%s  %s\n' "$expected_sha256" "$archive" > "$temporary/$archive.sha256"
(cd "$temporary" && sha256sum --check --strict "$archive.sha256") || { echo "The downloaded kiosk archive does not match the immutable release digest." >&2; exit 1; }

id lancerlogin >/dev/null 2>&1 || useradd --system --home "$STATE_ROOT" --shell /usr/sbin/nologin lancerlogin
usermod --append --groups dialout lancerlogin
[[ "$SENSOR_PATH" == disabled || -e "$SENSOR_PATH" ]] || echo "Warning: $SENSOR_PATH is unavailable. Enable the Pi UART before starting fingerprint authentication."
install -d -m 0755 -o root -g root "$RUNTIME_ROOT"
install -d -m 0700 -o lancerlogin -g lancerlogin "$STATE_ROOT"
check_runtime_layout

# Keep room for the new release next to the current and previous ones.
archive_kb="$(( ($(stat -c %s "$temporary/$archive") + 1023) / 1024 ))"
available_kb="$(df -Pk "$RUNTIME_ROOT" | awk 'NR == 2 { print $4 }')"
[[ "$available_kb" =~ ^[0-9]+$ && "$available_kb" -ge $(( archive_kb * 6 + 20480 )) ]] || { echo "Not enough free space under $RUNTIME_ROOT for a new release and rollback copy." >&2; exit 1; }

# Stage and check the new release while the current one keeps running.
new_release="${VERSION}_$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$RELEASES_DIR/$new_release" ]] || new_release="${new_release}_$$"
stage_release "$temporary/$archive" "$new_release"
backup_system_files "$temporary/system-backup"

if systemctl is-active --quiet lancerlogin-kiosk.service; then kiosk_was_active=true; fi
phase=stopped
systemctl stop lancerlogin-kiosk.service 2>/dev/null || true
if ss -H -ltn 'sport = :8788' | grep -q .; then
  echo "Port 8788 is already used by another service. LancerLogin did not disable or replace that service." >&2
  echo "Stop the conflicting kiosk service, then run this installer again:" >&2
  ss -H -ltnp 'sport = :8788' >&2 || true
  exit 1
fi
if legacy_layout; then migrate_legacy_layout; fi
previous_release="$(linked_release current)"

phase=switched
point_link current "releases/$new_release"
point_link src current/src
install_atomic 0644 "$RUNTIME_ROOT/current/systemd/lancerlogin-kiosk.service" "$UNIT_DIR/lancerlogin-kiosk.service"
install_atomic 0644 "$RUNTIME_ROOT/current/systemd/lancerlogin-update.service" "$UNIT_DIR/lancerlogin-update.service"
install_atomic 0755 "$RUNTIME_ROOT/current/scripts/lancerlogin-install-release.sh" "$HELPER_PATH"
cmp --silent "$RUNTIME_ROOT/current/scripts/lancerlogin-install-release.sh" "$HELPER_PATH" || { echo "Installed official update helper verification failed." >&2; exit 1; }
[[ "$(stat -c '%U:%G:%a' "$HELPER_PATH")" == "root:root:755" ]] || { echo "Installed official update helper ownership/mode verification failed." >&2; exit 1; }
install -d -m 0755 "$POLKIT_DIR"
for rules in 49-lancerlogin-network.rules 49-lancerlogin-recovery.rules 49-lancerlogin-update.rules; do
  install_atomic 0644 "$RUNTIME_ROOT/current/polkit/$rules" "$POLKIT_DIR/$rules"
done
install -d -m 0755 "$DROPIN_DIR"
printf '[Service]\nEnvironment=LANCERLOGIN_VERSION=%s\n' "$VERSION" > "$DROPIN_DIR/10-version.conf"
chmod 0644 "$DROPIN_DIR/10-version.conf"
# Use the resolved release path: the script runs only when it is the main module.
"$NODE" "$RELEASES_DIR/$new_release/src/clean-version-overrides.mjs"
# An existing desktop launcher is updated now, so it also works with a rolled-back release.
[[ ! -e "$LAUNCHER_PATH" ]] || install_atomic 0755 "$RUNTIME_ROOT/current/scripts/lancerlogin-open-kiosk.sh" "$LAUNCHER_PATH"
if [[ "$SENSOR_PATH_EXPLICIT" == true ]]; then
  printf '[Service]\nEnvironment=LANCERLOGIN_SENSOR_PATH=%s\n' "$SENSOR_PATH" > "$DROPIN_DIR/11-sensor.conf"
  chmod 0644 "$DROPIN_DIR/11-sensor.conf"
fi
systemctl daemon-reload
systemctl enable lancerlogin-kiosk.service
systemctl restart lancerlogin-kiosk.service
wait_until_healthy || exit 1

phase=done
if [[ -n "$previous_release" && "$previous_release" != "$new_release" ]]; then
  point_link previous "releases/$previous_release"
else
  rm -f -- "$RUNTIME_ROOT/previous"
fi
prune_releases "$new_release" "$previous_release"
host_name="$(hostname)"
local_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "LancerLogin is installed and healthy. Existing pairing, mappings, and queued scans are retained."
[[ -z "$previous_release" ]] || echo "The previous release is kept at $RUNTIME_ROOT/previous for automatic rollback."
echo "On the same network, open http://${host_name}.local:8788/. Enter a dashboard one-time pairing key only if the kiosk shows the pairing screen."
[[ -z "$local_ip" ]] || echo "If the .local address does not open, use http://${local_ip}:8788/ instead."
browser_path="$(command -v chromium || command -v chromium-browser || true)"
if [[ -n "$browser_path" ]]; then
  install -d -m 0755 /usr/local/bin
  install_atomic 0755 "$RUNTIME_ROOT/current/scripts/lancerlogin-open-kiosk.sh" /usr/local/bin/lancerlogin-open-kiosk
  cmp --silent "$RUNTIME_ROOT/current/scripts/lancerlogin-open-kiosk.sh" /usr/local/bin/lancerlogin-open-kiosk || { echo "Installed kiosk launcher verification failed." >&2; exit 1; }

  install -d -m 0755 /etc/xdg/autostart
  printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=LancerLogin Kiosk' 'Exec=/usr/local/bin/lancerlogin-open-kiosk' 'X-GNOME-Autostart-enabled=true' > /etc/xdg/autostart/lancerlogin-kiosk.desktop
  chmod 0644 /etc/xdg/autostart/lancerlogin-kiosk.desktop

  # PCManFM launches links to installed applications without treating the
  # desktop shortcut as an executable script. Keep global execution prompts.
  install -d -m 0755 /usr/local/share/applications
  application_file="/usr/local/share/applications/lancerlogin-kiosk.desktop"
  printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=LancerLogin Kiosk' 'Comment=Open the local LancerLogin attendance screen full-screen' 'Exec=/usr/local/bin/lancerlogin-open-kiosk' 'Icon=chromium' 'Terminal=false' 'Categories=Utility;' > "$application_file"
  chown root:root "$application_file"
  chmod 0644 "$application_file"

  desktop_user="${SUDO_USER:-}"
  if [[ -n "$desktop_user" && "$desktop_user" != root ]] && id "$desktop_user" >/dev/null 2>&1; then
    desktop_home="$(getent passwd "$desktop_user" | cut -d: -f6)"
    if [[ -n "$desktop_home" && -d "$desktop_home" ]]; then
      install -d -m 0755 -o "$desktop_user" -g "$desktop_user" "$desktop_home/Desktop"
      desktop_file="$desktop_home/Desktop/LancerLogin Kiosk.desktop"
      printf '%s\n' '[Desktop Entry]' 'Type=Link' 'Name=LancerLogin Kiosk' 'Icon=chromium' "URL=$application_file" > "$desktop_file"
      chown "$desktop_user:$desktop_user" "$desktop_file"
      chmod 0644 "$desktop_file"
      echo "A LancerLogin Kiosk relaunch shortcut was added to ${desktop_user}'s desktop."
    fi
  fi
  echo "Chromium will open LancerLogin in kiosk mode at the next desktop login."
else
  echo "Chromium was not found. Install it with Raspberry Pi OS software management, then open http://127.0.0.1:8788/ locally."
fi
echo "The kiosk can also open http://127.0.0.1:8788/ locally to scan, enroll, and verify service state."
