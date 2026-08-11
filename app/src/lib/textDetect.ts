// Live-testing addition (2026-08-06, Hannah): "this should not be determined by file ending but by
// whether it's human readable characters or random bytes instead, syntax highlighting should be derived
// by ending after."
//
// Pure and I/O-free (technical-baseline.md §2) - the caller supplies bytes already read from disk
// (storage/probe.ts, once per file at ingest). This is the same content-over-filename shift D-143 already
// made for metadata stripping, applied to the other place a filename was making a decision it should not.
//
// ⚠ SECURITY, and the reason this can widen the inline allowlist safely (security invariant 3): a file
// detected here is served as `text/plain` and NOTHING ELSE - never text/html, never image/svg+xml - with
// `nosniff` already set on delivery. So a `.html` or `.svg` upload detected as text renders in the browser
// as its own SOURCE, exactly like any other text file, and is never parsed as markup. That property is
// what makes "readable text" a safe question to answer from bytes; it is enforced in lib/mime.ts's
// contentTypeForRecord(), not here, and must not be weakened there without revisiting this comment.

// 4 KiB is plenty to classify by, and is what probe.ts already reads for its snippet - a file whose first
// 4 KiB are clean text and whose tail is binary is vanishingly rare and, served as text/plain, harmless.
export const TEXT_DETECT_SAMPLE_BYTES = 4096;

// A NUL byte is the single strongest binary signal there is - no text encoding this app cares about emits
// one, and essentially every binary container (PNG, JPEG, PDF, ZIP, ELF, Office) has one early.
const NUL = 0x00;

// Control characters that legitimately appear in text: tab, newline, carriage return, and form feed.
// Everything else below 0x20, plus DEL, counts as a binary signal.
const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0d, 0x0c]);

// Even without a NUL, a scattering of stray control bytes means this is not something a human reads.
// Deliberately loose rather than zero-tolerance: a stray 0x1b (ANSI escape) in a terminal log, or a lone
// 0x07, should not disqualify an otherwise perfectly readable file.
const MAX_CONTROL_RATIO = 0.02;

/**
 * True when `sample` (the first bytes of a file) reads as human-readable text rather than random bytes.
 *
 * Deliberately conservative - it answers "is this SAFE and SENSIBLE to show in a code block", not "could
 * this conceivably be decoded as text by something". Anything it is unsure about is binary, which simply
 * means the file downloads instead of previewing: the failure direction that costs a user nothing.
 *
 * An empty file is text (an empty .txt is a perfectly ordinary thing to upload and should preview as an
 * empty document, not download as an octet-stream).
 */
export function looksLikeText(sample: Uint8Array): boolean {
  if (sample.length === 0) return true;

  let controls = 0;
  for (const byte of sample) {
    if (byte === NUL) return false;
    if (byte < 0x20 && !ALLOWED_CONTROLS.has(byte)) controls++;
    else if (byte === 0x7f) controls++;
  }
  if (controls / sample.length > MAX_CONTROL_RATIO) return false;

  return isValidUtf8(sample);
}

// Strict UTF-8 validation, with ONE deliberate allowance: the sample is a fixed-size window cut at an
// arbitrary byte offset, so a multi-byte character straddling the end is an artifact of sampling, not a
// property of the file. A truncated sequence in the final 3 bytes is therefore accepted; anywhere else it
// is a genuine encoding error and the file is binary.
//
// Hand-rolled rather than TextDecoder({fatal:true}) precisely because of that boundary case - the decoder
// cannot distinguish "invalid" from "cut off mid-character", and would call every sampled UTF-8 file with
// a multi-byte character at the boundary binary.
function isValidUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i]!;
    let width: number;
    let min: number;
    let codePoint: number;

    if (byte <= 0x7f) {
      i++;
      continue;
    } else if ((byte & 0xe0) === 0xc0) {
      width = 2;
      min = 0x80;
      codePoint = byte & 0x1f;
    } else if ((byte & 0xf0) === 0xe0) {
      width = 3;
      min = 0x800;
      codePoint = byte & 0x0f;
    } else if ((byte & 0xf8) === 0xf0) {
      width = 4;
      min = 0x10000;
      codePoint = byte & 0x07;
    } else {
      return false; // a continuation byte with no lead, or an invalid 5/6-byte lead
    }

    if (i + width > bytes.length) {
      // Cut off by the sampling window rather than malformed - accept and stop (see the note above).
      return true;
    }

    for (let k = 1; k < width; k++) {
      const cont = bytes[i + k]!;
      if ((cont & 0xc0) !== 0x80) return false;
      codePoint = (codePoint << 6) | (cont & 0x3f);
    }

    // Reject overlong encodings, surrogates, and anything past the Unicode maximum - all of which are
    // signals of binary data that happens to pass the shape check.
    if (codePoint < min) return false;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    if (codePoint > 0x10ffff) return false;

    i += width;
  }
  return true;
}
