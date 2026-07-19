import { expect, test } from "@playwright/test";

// Proves the e2e pipeline itself works end-to-end (real browser, real running server) - not a real
// product-behaviour test. E1 ships no drop zone/browser/admin UI yet, so there is nothing to click.
test("the SPA shell loads in a real browser", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("files.mosni.dev");
  await expect(page.locator("#root")).toBeAttached();
});

test("GET /health returns ok", async ({ request }) => {
  const res = await request.get("/health");
  expect(res.ok()).toBeTruthy();
  await expect(res.json()).resolves.toEqual({ status: "ok" });
});

// Acceptance criterion 3 / D-44, and the reason this belongs in the e2e tier specifically: `app-e2e` runs
// the real production image (`node app/dist/server.js`), so this asserts the BUILT server renders a .tsx
// view. The equivalent integration test proves the same thing through Vitest's transform, which is not
// the pipeline that ships - only this one exercises `vite build --config vite.ssr.config.ts`.
test("the built server renders a .tsx view (D-44)", async ({ page }) => {
  const res = await page.goto("/no-such-path");

  expect(res?.status()).toBe(404);
  await expect(page.locator("h1")).toHaveText("Not found");
});
