#!/usr/bin/env bash
set -euo pipefail

# This installer intentionally does not clone a repository or contact a service.
# The release version will download signed kiosk artifacts after explicit pairing.
if [ "${1:-}" = "--dry-run" ]; then
  echo "LancerLogin kiosk installer dry-run: no files, services, hardware, or network changed."
  exit 0
fi
echo "This development installer is dry-run only. Use --dry-run."
exit 2
