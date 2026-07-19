import { defineConfig } from "@playwright/test";

// D-53 (reverses D-28): browser-driven e2e tests. E1 ships no real UI yet, so `e2e/` holds only a smoke
// test proving the pipeline works; real coverage of browser-only behaviour (drag/drop, clipboard, upload
// resume, mobile pickers) lands with the epics that ship it.
export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    screenshot: "only-on-failure",
  },
});
