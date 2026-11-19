import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// A browser bundle for the artifact page: React stays external (the page loads it from a CDN as a global).
export default defineConfig({
  resolve: { alias: { 'react/jsx-runtime': here('./artifact/jsx-shim.ts') } },
  build: {
    lib: { entry: here('./src/index.ts'), formats: ['iife'], name: 'LivingCityLib', fileName: () => 'living-city.iife.js' },
    rollupOptions: { external: ['react'], output: { globals: { react: 'React' } } },
    outDir: here('./artifact-dist'),
    emptyOutDir: true,
    minify: true,
  },
});
