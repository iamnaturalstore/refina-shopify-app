// admin-ui/vite.config.js — production-ready env injection + fail-fast
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Pull from OS env provided by CI (Render). Prefer VITE_ key; fall back to SHOPIFY_API_KEY.
const API_KEY = process.env.VITE_SHOPIFY_API_KEY || process.env.SHOPIFY_API_KEY;

// Fail the build clearly if missing (prevents silent "undefined" in the browser)
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

  // ✅ Inline the API key into the browser bundle at build time
  define: {
    'import.meta.env.VITE_SHOPIFY_API_KEY': JSON.stringify(API_KEY),
  },
});
