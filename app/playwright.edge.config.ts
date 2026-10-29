import { defineConfig } from "@playwright/test";

// `npx playwright test -c playwright.edge.config.ts`: the e2e tests in Edge (Chromium, the
// engine of the Windows app, WebView2), against already running `quire serve` and `npm run dev`.
export default defineConfig({
  testDir: "e2e",
  reporter: "list",
  workers: 1,
  use: { baseURL: `http://localhost:${process.env.QUIRE_UI_PORT ?? 5173}`, channel: "msedge", viewport: { width: 1280, height: 900 } },
});
