// Review 060/SEC-2: the one wrapper every ffmpeg/ffprobe invocation in this app goes through.
//
// These tools parse ATTACKER-CONTROLLED bytes at ingest, and every call site used a bare
// `promisify(execFile)` with Node's defaults - which means no timeout at all and a 1 MB stdout ceiling.
// Two concrete failures came out of that:
//
//   - No timeout. A container crafted to make ffmpeg spin (or simply a pathological remux) held an
//     `onUploadFinish` hook, its tus temp file and a request open indefinitely, with nothing to reap it.
//     The box is an Atom N2800 (D-78); it does not have processes to spare.
//   - The default `maxBuffer` of 1 MB. ffprobe's `-show_streams` JSON for a file with many streams
//     exceeds it, execFile then rejects, and storage/strip.ts's classify() caught that rejection and
//     answered `{ kind: "unknown" }` - which means NO STRIP, i.e. an unstripped photo/video stored
//     verbatim. D-143/A6.4 says a detectable photo or video that cannot be stripped is never stored, and
//     that branch quietly violated it. Fail-open in a security invariant, reached by a large-but-ordinary
//     file rather than by an attack.
//
// So: real limits, and a distinguishable error for the two cases a caller must NEVER swallow.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Generous against real work on a weak box (a stream-copy remux of a multi-GB video is I/O-bound, not
// CPU-bound, and finishes well inside this), tight enough that a hung tool is reaped rather than held.
export const MEDIA_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

// 64 MB. ffprobe JSON for a pathological stream count is the only output that gets anywhere near this;
// ffmpeg writes its file to disk and only logs to stderr.
export const MEDIA_TOOL_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Thrown when a tool was KILLED by the timeout or overran maxBuffer - i.e. when this module, not the
 * tool, ended the run.
 *
 * The distinction is load-bearing: "ffprobe looked at the file and could not identify it" is an ordinary
 * answer callers are right to swallow, while "we never got an answer" must fail the upload closed. A
 * caller that treats the second as the first re-opens exactly the D-143 hole described above.
 */
export class MediaToolAbortedError extends Error {
  constructor(
    readonly tool: string,
    readonly cause: unknown,
  ) {
    super(`storage/mediaExec: ${tool} was aborted (timed out or overran its output buffer)`);
    this.name = "MediaToolAbortedError";
  }
}

// `killed` is set by Node whenever IT ended the process - which covers both the timeout and the maxBuffer
// overrun - and ERR_CHILD_PROCESS_STDIO_MAXBUFFER names the second case explicitly. `signal` matches
// `killSignal` below. A tool that ran and exited non-zero on its own carries none of these, which is
// exactly the distinction callers branch on. Note a spawn failure (ENOENT: the tool is not installed) is
// also NOT an abort - it is an ordinary error, and the caller treating it as "could not identify this
// file" is correct, since a missing ffprobe genuinely cannot identify anything.
function isAbort(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { killed?: boolean; code?: unknown; signal?: unknown };
  return e.killed === true || e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || e.signal === "SIGKILL";
}

// `limits` exists so the abort path is provable in bounded time - a test cannot wait out a five-minute
// timeout, and reliably overrunning a 64 MB buffer needs an hour of ffprobe output. Both callers in
// production omit it and take the constants above; this is a real parameter of a bounded-execution
// wrapper, not a hatch.
export type MediaToolLimits = { timeoutMs?: number; maxBuffer?: number };

export async function runMediaTool(
  tool: "ffmpeg" | "ffprobe",
  args: readonly string[],
  limits: MediaToolLimits = {},
): Promise<{ stdout: string }> {
  try {
    // Argument ARRAY, never a shell string - no shell is spawned, so a filename can never be interpreted
    // as anything but a filename. (Already true of every call site this replaces; restated because this is
    // now the single place it has to stay true.)
    const { stdout } = await execFileAsync(tool, [...args], {
      timeout: limits.timeoutMs ?? MEDIA_TOOL_TIMEOUT_MS,
      maxBuffer: limits.maxBuffer ?? MEDIA_TOOL_MAX_BUFFER,
      killSignal: "SIGKILL",
    });
    return { stdout };
  } catch (err) {
    if (isAbort(err)) throw new MediaToolAbortedError(tool, err);
    throw err;
  }
}
