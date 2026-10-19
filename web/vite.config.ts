import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:3001', changeOrigin: false },
      '/.well-known/oauth-': { target: process.env.API_URL ?? 'http://localhost:3001', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
