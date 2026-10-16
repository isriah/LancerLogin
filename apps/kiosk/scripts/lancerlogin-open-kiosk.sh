#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 0 ]] || { echo "The kiosk launcher accepts no arguments." >&2; exit 2; }
browser_path="$(command -v chromium || command -v chromium-browser || true)"
[[ -n "$browser_path" ]] || { echo "Install Chromium, then relaunch the kiosk." >&2; exit 1; }
exec /usr/bin/node /opt/lancerlogin/src/desktop-launcher.mjs "$browser_path"
