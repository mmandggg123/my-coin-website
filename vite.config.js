import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * coinportal/vite.config.js
 *
 * The proxy block rewrites any request from the React dev server that starts
 * with /api to http://localhost:3001, where the indexer's built-in HTTP server
 * is listening.  This means the frontend calls fetch("/api/wallet") — a plain
 * relative URL — and Vite forwards it to the Node process with no CORS issues
 * and no hardcoded port in the React code.
 *
 * In production (after `vite build`) you would point your reverse-proxy /
 * static file server at the same backend port instead.
 */
export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    proxy: {
      "/api": {
        target:       "http://localhost:3001",
        changeOrigin: true,
        // No rewrite needed — the backend already serves /api/wallet
      },
    },
  },

  // Tells Vite where the React entry-point lives
  root: ".",
  build: {
    outDir: "dist-ui",
  },
});
