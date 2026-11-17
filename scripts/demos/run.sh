#!/usr/bin/env bash
# Rebuilds the README's "How it feels" recordings (docs/start.png, edit.png, export.png): animated PNGs of the
# app in an iPhone frame on a transparent background.
#
# Needs: Node with Playwright and Chromium, Python 3 with Pillow and NumPy, and ffmpeg (for the demo clip).
# Run from the repo root: scripts/demos/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'kill "${server:-}" 2>/dev/null || true; rm -rf "${work:?}"' EXIT

mkdir -p "$work/media" "$work/out"
python3 -I "$here/make_media.py" "$work/media"

(cd "$root" && exec node_modules/.bin/vite --port 5199 --strictPort >/dev/null 2>&1) &
server=$!
sleep 4
node "$here/record.cjs" http://localhost:5199/ "$work/media" "$work/out"

for scene in start edit export; do
  python3 -I "$here/compose.py" "$work/out/$scene" "$root/docs/$scene.png" 15
done
echo "Done."
