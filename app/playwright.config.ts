import { defineConfig, devices } from "@playwright/test";

// `npm run e2e`: the UI in WebKit (the engine of the macOS app) against `quire serve`.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  webServer: [
    {
      command: "cargo run -q -p quire-cli -- serve --port 7878",
      cwd: "..",
      url: "http://127.0.0.1:7878/api/library",
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
    { command: "npm run dev", url: "http://localhost:5173", reuseExistingServer: !process.env.CI },
  ],
});
