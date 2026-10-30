import { defineConfig, devices } from "@playwright/test";

// `npm run e2e`: the UI in WebKit (the engine of the macOS app) against `quire serve`.
// QUIRE_UI_PORT / QUIRE_API_PORT pick other ports (see vite.config.ts).
const uiPort = Number(process.env.QUIRE_UI_PORT ?? 5173);
const apiPort = Number(process.env.QUIRE_API_PORT ?? 7878);
// the web version (WebAssembly engine, no server) on its own port: e2e/web.spec.ts
const webPort = Number(process.env.QUIRE_WEB_PORT ?? uiPort + 1);

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: `http://localhost:${uiPort}`, trace: "retain-on-failure" },
  projects: [
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testIgnore: "web.spec.ts" },
    {
      name: "web",
      use: { ...devices["Desktop Safari"], baseURL: `http://localhost:${webPort}` },
      testMatch: "web.spec.ts",
    },
  ],
  webServer: [
    {
      command: `cargo run -q -p quire-cli -- serve --port ${apiPort}`,
      cwd: "..",
      url: `http://127.0.0.1:${apiPort}/api/library`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
    { command: "npm run dev", url: `http://localhost:${uiPort}`, reuseExistingServer: !process.env.CI },
    {
      command: `npm run dev:web -- --port ${webPort}`,
      url: `http://localhost:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
