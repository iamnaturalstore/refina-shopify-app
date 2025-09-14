// admin-ui/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: '/admin-ui/',
  build: {
    outDir: path.resolve(__dirname, '../refina-backend/admin-ui-dist'),
    emptyOutDir: true,
  },
});