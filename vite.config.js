// vite.config.js (repo root) — neutral/root-only
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",         // ✅ not admin-ui-dist
    emptyOutDir: true,
  },
  resolve: { dedupe: ["react", "react-dom"] },
  server: { port: 5173 },
});
