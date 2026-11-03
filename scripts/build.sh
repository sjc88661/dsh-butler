#!/usr/bin/env bash
# Compatibility launcher only. Prefer node scripts/build.mjs on Windows.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${DSH_NODE:-node}"
if ! command -v "$NODE" >/dev/null 2>&1; then NODE="node.exe"; fi
if ! command -v "$NODE" >/dev/null 2>&1 && [ -x /mnt/e/nodejs/node.exe ]; then NODE="/mnt/e/nodejs/node.exe"; fi
if ! command -v "$NODE" >/dev/null 2>&1 && [ ! -x "$NODE" ]; then
  echo 'build: pinned Node unavailable; run node scripts/build.mjs from a native terminal' >&2
  exit 1
fi
SCRIPT="$ROOT/scripts/build.mjs"
if [ "$("$NODE" -p 'process.platform')" = win32 ] && command -v wslpath >/dev/null 2>&1; then
  SCRIPT="$(wslpath -w "$SCRIPT")"
  if [ -n "${DSH_CHECKOUT:-}" ] && [[ "$DSH_CHECKOUT" == /mnt/* ]]; then export DSH_CHECKOUT="$(wslpath -w "$DSH_CHECKOUT")"; fi
fi
exec "$NODE" "$SCRIPT" "$@"
