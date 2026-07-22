import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSpaShell, initSpaShell } from "../../src/storage/spaShell.ts";

describe("storage/spaShell.ts", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("throws if read before initSpaShell() is called", () => {
    // Vitest isolates the module registry per test file, and this is the first test in this file, so the
    // module-level singleton is still genuinely uninitialised here.
    expect(() => getSpaShell()).toThrow(/initSpaShell\(\) must be called before use/);
  });

  it("reads a real web/dist/index.html once and returns its contents", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "spa-shell-test-"));
    await writeFile(path.join(dir, "index.html"), "<!doctype html><html><head></head><body>real</body></html>");

    initSpaShell(dir);
    expect(getSpaShell()).toBe("<!doctype html><html><head></head><body>real</body></html>");
  });

  it("falls back to a minimal built-in shell when index.html is missing", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "spa-shell-test-"));

    initSpaShell(dir);
    const shell = getSpaShell();
    expect(shell).toContain("<div id=\"root\"></div>");
    expect(shell).toContain("</head>");
  });
});
