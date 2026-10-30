import { defineConfig, devices } from "@playwright/test";

// `npm run screenshots`: the README's pictures, taken from the real app (the UI in WebKit
// against `quire serve`) and written to docs/images. Not part of `npm run e2e`.
const uiPort = Number(process.env.QUIRE_UI_PORT ?? 5173);
const apiPort = Number(process.env.QUIRE_API_PORT ?? 7878);

export default defineConfig({
  testDir: ".",
  reporter: "list",
  timeout: 60_000,
  use: {
    ...devices["Desktop Safari"],
    baseURL: `http://localhost:${uiPort}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  },
  webServer: [
    {
      command: `cargo run -q -p quire-cli -- serve --port ${apiPort}`,
      cwd: "../..",
      url: `http://127.0.0.1:${apiPort}/api/library`,
      reuseExistingServer: true,
      timeout: 300_000,
    },
    { command: "npm run dev", cwd: "..", url: `http://localhost:${uiPort}`, reuseExistingServer: true },
  ],
});
