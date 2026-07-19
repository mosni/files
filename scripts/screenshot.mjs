#!/usr/bin/env node
// Debug entrypoint for review sessions (HANDOFF.md's review-session rule): grab a screenshot of the
// running app - optionally after performing an action - without driving a browser by hand. Requires the
// app already running somewhere reachable (docker compose up, or `npm run dev` for the SPA); this script
// only drives the browser and saves the result, it does not start the app itself.
//
// Usage:
//   npm run screenshot -- [urlPath] [outFile] [actions...]
//
// Actions run in order, after the page loads, before the screenshot:
//   --click <selector>            click an element
//   --fill <selector> <value>     fill an input
//   --wait <selector>             wait for an element to appear (e.g. after an async action)
//   --eval <jsExpression>         run arbitrary JS in the page (page.evaluate)
//
// Example - click a button, wait for its result, then capture:
//   npm run screenshot -- / after-click.png --click "#copy-link" --wait ".toast"
//
// BASE_URL env var overrides the default http://localhost:3000 (e.g. the box-time port, 33001 in dev).
// Requires Chromium to be installed once: npx playwright install chromium

import { chromium } from "playwright";
import path from "node:path";

function parseArgs(argv) {
  const [urlPath = "/", outFile = "screenshot.png", ...rest] = argv;
  const actions = [];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--click") {
      actions.push({ type: "click", selector: rest[++i] });
    } else if (flag === "--fill") {
      actions.push({ type: "fill", selector: rest[++i], value: rest[++i] });
    } else if (flag === "--wait") {
      actions.push({ type: "wait", selector: rest[++i] });
    } else if (flag === "--eval") {
      actions.push({ type: "eval", js: rest[++i] });
    } else {
      throw new Error(`Unknown flag: ${flag} (expected --click, --fill, --wait, or --eval)`);
    }
  }
  return { urlPath, outFile, actions };
}

async function runAction(page, action) {
  switch (action.type) {
    case "click":
      return page.click(action.selector);
    case "fill":
      return page.fill(action.selector, action.value);
    case "wait":
      return page.waitForSelector(action.selector);
    case "eval":
      // eslint-disable-next-line no-eval -- deliberate: a debug tool running caller-supplied Playwright JS
      return page.evaluate(action.js);
  }
}

const { urlPath, outFile, actions } = parseArgs(process.argv.slice(2));
const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const target = new URL(urlPath, baseUrl).toString();
const outPath = path.resolve(outFile);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(target, { waitUntil: "networkidle" });

  for (const action of actions) {
    await runAction(page, action);
  }

  await page.screenshot({ path: outPath, fullPage: true });
  console.log(`Saved screenshot of ${target} to ${outPath}${actions.length > 0 ? ` (after ${actions.length} action(s))` : ""}`);
} finally {
  await browser.close();
}
