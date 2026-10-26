import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// `npm run dev` alone serves the UI in a browser, talking to `quire serve` through /api.
// Inside Tauri the same UI calls the Rust commands directly.
export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:7878", changeOrigin: true } },
  },
  build: { target: "safari15", outDir: "dist" },
});
