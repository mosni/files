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
