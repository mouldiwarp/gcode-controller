import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The garage Mac runs Monterey, so target Safari 15.
export default defineConfig({
  plugins: [react()],
  build: {
    target: ['safari15', 'es2020'],
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
