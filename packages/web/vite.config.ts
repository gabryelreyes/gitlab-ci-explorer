import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@gce/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
  server: { fs: { allow: ['../..'] } },
  build: { chunkSizeWarningLimit: 1500 },
});
