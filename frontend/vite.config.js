// frontend/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import path from 'path';

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    https: false, // For HMR via a public tunnel, the tunnel terminates TLS.
    host: 'localhost',
    port: 5173,
  },
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: 'dist-concierge',
    emptyOutDir: true,
    sourcemap: true,
    cssCodeSplit: false, // Emit a single CSS file we can link predictably
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
  },
});
