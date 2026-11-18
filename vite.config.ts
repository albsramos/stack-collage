import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

// Which build a bug report came from: the commit, plus the time it was built.
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return process.env.GITHUB_SHA?.slice(0, 7) ?? 'unknown';
  }
})();
const build = `${commit} ${new Date().toISOString().slice(0, 16)}Z`;

// BASE is set by the GitHub Pages workflow (e.g. "/stack-collage/"); "/" for local dev.
const base = process.env.BASE ?? '/';
// ARTIFACT=1 builds a copy for a claude.ai artifact: relative paths, no service worker (the sandbox blocks it).
const artifact = !!process.env.ARTIFACT;

export default defineConfig({
  define: { __BUILD__: JSON.stringify(build) },
  base: artifact ? './' : base,
  plugins: [
    react(),
    !artifact && VitePWA({
      // 'prompt', not 'autoUpdate': a new service worker waits until the app is closed instead of taking over the
      // open page and deleting the files it still lazy-loads (the exporter, mediabunny), which broke the first
      // export or video after every deploy. The next launch gets the new version.
      registerType: 'prompt',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'Stack — photo & video collages',
        short_name: 'Stack',
        description: 'Stack 2 or 3 photos or videos into a story or post.',
        theme_color: '#fbfbfa',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        skipWaiting: false,
        clientsClaim: false,
      },
    }),
  ],
});
