#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 0 ]] || { echo "The kiosk launcher accepts no arguments." >&2; exit 2; }
browser_path="$(command -v chromium || command -v chromium-browser || true)"
[[ -n "$browser_path" ]] || { echo "Install Chromium, then relaunch the kiosk." >&2; exit 1; }
# /opt/lancerlogin/src links to the active release. Pass the resolved path so the
# launcher recognizes itself as the main module (Node resolves symlinks for import.meta.url).
launcher="$(readlink -f /opt/lancerlogin/src/desktop-launcher.mjs)"
exec /usr/bin/node "$launcher" "$browser_path"
