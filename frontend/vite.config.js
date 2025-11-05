// frontend/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import path from 'path';

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    https: false,
    host: 'localhost',
    port: 5173,
  },
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    // ⬇️ emit straight into the app-proxy’s public path
    outDir: path.resolve(__dirname, '../refina-backend/public/concierge'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,              // ⬅️ TEMP: avoid TDZ/cycle crashes
    cssCodeSplit: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/concierge/main.jsx'),
      output: {
        entryFileNames: 'concierge.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const ext = path.extname(assetInfo.name || '').toLowerCase();
          if (ext === '.css') return 'concierge.css';
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
    target: 'es2019',
  },
});
