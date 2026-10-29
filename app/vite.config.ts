import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// `npm run dev` alone serves the UI in a browser, talking to `quire serve` through /api.
// Inside Tauri the same UI calls the Rust commands directly.
// QUIRE_UI_PORT / QUIRE_API_PORT move both, so several checkouts can run side by side.
const uiPort = Number(process.env.QUIRE_UI_PORT ?? 5173);
const apiPort = Number(process.env.QUIRE_API_PORT ?? 7878);

// `--mode web` (`npm run dev:web`, `npm run build:web`) is the web version: the engine as
// WebAssembly from web-public/ (`npm run wasm` builds it), and paths relative to the page so
// it works wherever it is served (GitHub Pages puts it under /quire/).
export default defineConfig(({ mode }) => ({
  plugins: [solid()],
  base: mode === "web" ? "./" : "/",
  publicDir: mode === "web" ? "web-public" : "public",
  clearScreen: false,
  server: {
    port: uiPort,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
  build: { target: "safari15", outDir: mode === "web" ? "dist-web" : "dist" },
  // `npm test`: unit tests next to the modules they cover, in a simulated DOM
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
}));
