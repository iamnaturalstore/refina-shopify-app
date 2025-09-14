// admin-ui/vite.config.js — Option A (build into refina-backend/admin-ui-dist)
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  // Ensure all asset URLs in index.html point to /admin-ui/*
  base: '/admin-ui/',
  build: {
    // Build straight into the backend so server.js can serve it from ADMIN_UI_DIR
    outDir: resolve(__dirname, '../refina-backend/admin-ui-dist'),
    emptyOutDir: true,
    sourcemap: true,              // helpful for prod debugging
    assetsDir: 'assets',          // keep hashed assets under /assets
    rollupOptions: {
      output: {
        // Fingerprinted filenames under /admin-ui/assets/* to match server static path
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: {
    // Prevent duplicate React in monorepo/dev
    dedupe: ['react', 'react-dom'],
  },
});
