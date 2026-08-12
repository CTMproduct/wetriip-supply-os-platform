import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5180,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3100', changeOrigin: true },
    },
  },
});
