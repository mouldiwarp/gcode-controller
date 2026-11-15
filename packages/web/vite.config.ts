import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Both Macs run Tahoe; Safari 15 stays as a conservative floor for other browsers on the network.
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
