// admin-ui/vite.config.js — production-ready env injection + fail-fast
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Prefer VITE_SHOPIFY_API_KEY; fall back to SHOPIFY_API_KEY (Render env)
const API_KEY = process.env.VITE_SHOPIFY_API_KEY || process.env.SHOPIFY_API_KEY;
if (!API_KEY) {
  throw new Error(
    '[admin-ui build] Missing VITE_SHOPIFY_API_KEY (or SHOPIFY_API_KEY). ' +
    'Set it in the environment so App Bridge can initialize.'
  );
}

export default defineConfig({
  plugins: [react()],
  base: '/admin-ui/',
  build: {
    outDir: resolve(__dirname, '../refina-backend/admin-ui-dist'),
    emptyOutDir: true,
    sourcemap: true,
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: { dedupe: ['react', 'react-dom'] },

  // ✅ Inline API key as a compile-time global (browser-safe)
  define: {
    __APP_BRIDGE_API_KEY__: JSON.stringify(API_KEY),
  },
});
