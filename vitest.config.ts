import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The 90% line-coverage gate is the mechanism of D-26 (TDD, hard-gated). Never lower it to make a
// change pass - if something is hard to test, pull it into `lib` as a pure function instead
// (technical-baseline.md §2).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // e2e/ holds Playwright specs (*.spec.ts), which register their own `test()` global via
    // @playwright/test - Vitest's default include pattern matches *.spec.ts too and tries to load them
    // as its own tests, which conflicts with Playwright's runner. Playwright tests run only via
    // `npx playwright test` (npm run test:e2e), never through Vitest.
    exclude: ["**/node_modules/**", "e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["app/src/**/*.{ts,tsx}", "web/src/**/*.{ts,tsx}"],
      // web/src/main.tsx: untestable DOM-mount glue (placeholder entry - E1 ships no real SPA UI yet),
      // same headroom the baseline grants server bootstrap/config loading.
      exclude: ["**/*.test.{ts,tsx}", "web/src/main.tsx"],
      thresholds: { lines: 90 },
    },
  },
});
