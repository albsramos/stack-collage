import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// `vite` / `vite build --mode demo` serve and build the demo page; `vite build` builds the library.
export default defineConfig(({ command, mode }) => {
  if (command === 'serve' || mode === 'demo') {
    return {
      root: here('./demo'),
      base: './',
      plugins: [react()],
      build: { outDir: here('./demo-dist'), emptyOutDir: true },
    };
  }
  return {
    plugins: [react()],
    build: {
      lib: {
        entry: here('./src/index.ts'),
        formats: ['es', 'cjs'],
        fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
      },
      rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime'] },
      sourcemap: true,
      emptyOutDir: true,
    },
  };
});
