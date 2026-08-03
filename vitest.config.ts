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
    // .claude/worktrees/ holds other agents' isolated checkouts of this same repo (see agent-docs)) -
    // without this exclusion Vitest's default include glob walks into them too, double-running (and
    // double-counting against the shared redis rate-limit store) whatever tests happen to exist there.
    exclude: ["**/node_modules/**", "e2e/**", ".claude/worktrees/**"],
    // E4 session 019/020: scope=all (D-101) sweeps EVERY root-level collection regardless of owner, and
    // its ACL-chain walk (hasAclGrantOnChain) throws on a dangling parent_id rather than silently
    // returning false - a deliberate fail-loud invariant, not a bug. Running integration test FILES in
    // parallel means every other file's own root-level collections (created/deleted concurrently against
    // the SAME shared MariaDB, per D-45) are fair game for that sweep to encounter mid-flight, and
    // occasionally catches one mid-delete: a genuinely dangling parent_id that is a test-parallelism
    // artifact, not a real data-integrity fault. Serializing test files removes the race without touching
    // the invariant. Flagged for the review session - the trade-off is a slower `npm run verify`.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["app/src/**/*.{ts,tsx}", "web/src/**/*.{ts,tsx}"],
      // web/src/main.tsx: untestable DOM-mount glue - it mounts eagerly against document#root and drives
      // BrowserRouter, so importing it in a test drags in routing rather than the thing under test. Same
      // headroom the baseline grants server bootstrap/config loading. The one guarantee it DOES carry -
      // D-1/D-93's DropZone-then-FileBrowser order on "/" - is asserted on that exact composition by
      // web/test/unit/mainLayout.test.tsx instead.
      // web/src/embed.tsx (E5 Wave H): the same class of DOM-mount glue, for the same reason - it mounts
      // eagerly against document#root at import time. VideoPreview.tsx (the thing it mounts) carries its
      // own full test coverage; this file has nothing left to assert beyond "did it call createRoot",
      // which is exactly main.tsx's own excluded territory.
      exclude: ["**/*.test.{ts,tsx}", "web/src/main.tsx", "web/src/embed.tsx"],
      thresholds: { lines: 90 },
    },
  },
});
