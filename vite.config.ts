import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// BASE is set by the GitHub Pages workflow (e.g. "/stack-collage/"); "/" for local dev.
const base = process.env.BASE ?? '/';
// ARTIFACT=1 builds a copy for a claude.ai artifact: relative paths, no service worker (the sandbox blocks it).
const artifact = !!process.env.ARTIFACT;

export default defineConfig({
  base: artifact ? './' : base,
  plugins: [
    react(),
    !artifact && VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'Stack — photo & video collages',
        short_name: 'Stack',
        description: 'Stack 2 or 3 photos or videos into a story or post.',
        theme_color: '#09090b',
        background_color: '#09090b',
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
      },
    }),
  ],
});
