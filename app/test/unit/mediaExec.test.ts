// Review 060/SEC-2. These tools parse attacker-controlled bytes, and every call site used to run them
// with Node's execFile defaults: no timeout, and a 1 MB stdout ceiling. The maxBuffer half was the one
// with teeth - ffprobe output past 1 MB rejected, storage/strip.ts's classify() caught the rejection and
// answered `{ kind: "unknown" }`, and an unknown file is never stripped. That is D-143/A6.4's invariant
// ("a detectable photo or video that cannot be stripped is never stored") failing OPEN, reachable with a
// large-but-ordinary file rather than an attack.
//
// So the two failures a caller must never swallow have to be distinguishable from "the tool answered, and
// its answer was: I don't recognise this". That is MediaToolAbortedError, and this is its contract.

import { describe, expect, it } from "vitest";
import {
  MEDIA_TOOL_MAX_BUFFER,
  MEDIA_TOOL_TIMEOUT_MS,
  MediaToolAbortedError,
  runMediaTool,
} from "../../src/storage/mediaExec.ts";

describe("storage/mediaExec", () => {
  it("returns stdout for a tool that exits cleanly", async () => {
    // ffprobe's own -version is the cheapest real invocation available, and it proves the argv path works.
    const { stdout } = await runMediaTool("ffprobe", ["-version"]);
    expect(stdout).toContain("ffprobe");
  });

  it("rejects with an ORDINARY error - never MediaToolAbortedError - when the tool ran and failed", async () => {
    // A file that does not exist: ffprobe starts, looks, and exits non-zero. classify() is right to
    // swallow this; the assertion is that it is not dressed up as an abort.
    await expect(runMediaTool("ffprobe", ["/nonexistent-file-for-tests"])).rejects.toThrow();
    await expect(runMediaTool("ffprobe", ["/nonexistent-file-for-tests"])).rejects.not.toBeInstanceOf(
      MediaToolAbortedError,
    );
  });

  it("wraps a timeout kill as MediaToolAbortedError", async () => {
    // A real, long-running ffmpeg against a tiny timeout - the abort classification is what is under test,
    // not the constant (pinned separately below), so this proves it in a fraction of a second rather than
    // waiting out MEDIA_TOOL_TIMEOUT_MS.
    await expect(
      runMediaTool(
        "ffmpeg",
        ["-y", "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30", "-t", "600", "-f", "null", "-"],
        { timeoutMs: 300 },
      ),
    ).rejects.toBeInstanceOf(MediaToolAbortedError);
  }, 30_000);

  it("wraps a maxBuffer overrun as MediaToolAbortedError - the case that made classify() fail open", async () => {
    // ffprobe's own -version output is a few hundred bytes; a 1-byte ceiling overruns on the first chunk.
    // This is the shape of the real defect: ffprobe ANSWERED, the answer just did not fit, and swallowing
    // that as "unrecognised" stored a file nothing had inspected (D-143/A6.4).
    await expect(runMediaTool("ffprobe", ["-version"], { maxBuffer: 1 })).rejects.toBeInstanceOf(
      MediaToolAbortedError,
    );
  });

  it("pins the limits themselves, since both are load-bearing rather than incidental", () => {
    expect(MEDIA_TOOL_TIMEOUT_MS).toBe(5 * 60 * 1000);
    // Node's default is 1 MB, which is what the ffprobe overrun above demonstrates is too small.
    expect(MEDIA_TOOL_MAX_BUFFER).toBe(64 * 1024 * 1024);
    expect(MEDIA_TOOL_MAX_BUFFER).toBeGreaterThan(1024 * 1024);
  });
});
