# Stack

A small PWA for stacking **2 or 3 photos or videos** into a **9:16** or **3:4** frame, and exporting a high-quality file.

Everything runs on-device in the browser — nothing is uploaded.

## Flow

1. On the start screen pick 2 or 3 stacked (top) and 9:16 or 3:4 (bottom), then **Start**.
2. Slots always fill the frame edge to edge. Tap a slot (or **Add photos or videos**) to fill it. Drag to reposition, pinch / scroll to zoom. Use ↑ ↓ to reorder.
3. **Export** → **Save**. On iPhone this opens the share sheet, so you can pick *Save Image* / *Save Video*.

## Export quality

| | |
|---|---|
| Photos only | JPEG (q 0.95) at 1080 wide — or 2160 wide with **High · 2×** |
| Any video | H.264 MP4, 30 fps, ~16 Mbps at 1080×1920 (×4 at 2×), AAC audio |

- Video is encoded with WebCodecs via [Mediabunny](https://mediabunny.dev), frame by frame — no screen recording, so no dropped frames.
- Each video is decoded straight to the size it's drawn at, so there's no blurry double-scaling.
- Output length = the longest clip (max 60 s). Shorter clips loop.
- **Sound**: pick which video's audio to keep, or turn it off. If the browser can't encode AAC natively, a WASM AAC encoder is lazy-loaded.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173 (also exposed on your LAN for testing on a phone)
npm run build
```

Stack: Vite + React + TypeScript, `vite-plugin-pwa` (offline + installable), `mediabunny` for video decode/encode.

Code map:

- `src/layout.ts` — format sizes, slot geometry, pan/zoom math. Shared by preview and export, so the preview is exact.
- `src/media.ts` — loading photos/videos (dimensions, rotation, duration, audio).
- `src/exporter.ts` — canvas rendering, MP4 encoding, save/share.
- `src/App.tsx` — screens, editor, gestures.

## Deploy

Pushing to `main` builds the app and publishes it to the `gh-pages` branch (`.github/workflows/deploy.yml`), served at https://albsramos.github.io/stack-collage/. On iPhone open the Pages URL in Safari → Share → **Add to Home Screen**.

## Requirements / limits

- Video export needs WebCodecs: Safari 17+ (iOS 17+), Chrome/Edge 94+.
- iPhone HEVC/Dolby Vision clips decode where the browser supports HEVC (Safari does; desktop Chrome depends on hardware).
