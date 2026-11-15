import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';

// The commit this UI was built from. A page compares it with the server's and reloads
// itself after an update, so nobody is left on an old page.
let commit = '';
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  // not a git checkout
}

// Both Macs run Tahoe; Safari 15 stays as a conservative floor for other browsers on the network.
export default defineConfig({
  plugins: [react()],
  define: { __GCC_COMMIT__: JSON.stringify(commit) },
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
