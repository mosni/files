// Live-testing addition (2026-08-06): content-based text detection - Hannah's rule that whether a file
// previews as text is decided by its BYTES, not its extension.
import { describe, expect, it } from "vitest";
import { looksLikeText, TEXT_DETECT_SAMPLE_BYTES } from "../../src/lib/textDetect.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("looksLikeText() - reads bytes, never a filename", () => {
  it("accepts plain ASCII prose", () => {
    expect(looksLikeText(utf8("Hello, world!\nSecond line.\n"))).toBe(true);
  });

  it("accepts an empty file - an empty text file is still a text file", () => {
    expect(looksLikeText(bytes())).toBe(true);
  });

  it("accepts source code with tabs, newlines and carriage returns", () => {
    expect(looksLikeText(utf8("function f() {\r\n\tif (x) return 1;\r\n}\r\n"))).toBe(true);
  });

  it("accepts multi-byte UTF-8 - emoji, accents and CJK are human-readable characters", () => {
    expect(looksLikeText(utf8("héllo wörld — 日本語 — 🎉"))).toBe(true);
  });

  it("accepts markdown, which is what prompted this (README.md)", () => {
    expect(looksLikeText(utf8("# Title\n\n- a list\n- of things\n\n`code`\n"))).toBe(true);
  });

  it("rejects anything containing a NUL byte", () => {
    expect(looksLikeText(bytes(0x68, 0x69, 0x00, 0x68, 0x69))).toBe(false);
  });

  it("rejects a real PNG header", () => {
    expect(looksLikeText(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d))).toBe(false);
  });

  it("rejects a real PDF (has a NUL in its binary comment line early on)", () => {
    const pdf = new Uint8Array([...utf8("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0x0a]);
    expect(looksLikeText(pdf)).toBe(false);
  });

  it("rejects a byte sequence that is not valid UTF-8, even with no NUL", () => {
    // 0xff/0xfe never appear in valid UTF-8 at all.
    expect(looksLikeText(bytes(0x68, 0x69, 0xff, 0xfe, 0x68))).toBe(false);
  });

  it("rejects a continuation byte with no lead byte", () => {
    expect(looksLikeText(bytes(0x41, 0x80, 0x42))).toBe(false);
  });

  it("rejects an overlong encoding (a classic way to smuggle bytes past a naive check)", () => {
    // 0xc0 0xaf is an overlong "/" - valid-shaped but forbidden.
    expect(looksLikeText(bytes(0x41, 0xc0, 0xaf, 0x42))).toBe(false);
  });

  it("rejects a UTF-16 surrogate encoded as UTF-8 (CESU-8)", () => {
    expect(looksLikeText(bytes(0xed, 0xa0, 0x80))).toBe(false);
  });

  it("rejects text peppered with stray control characters", () => {
    const noisy = new Uint8Array(200);
    noisy.fill(0x41);
    for (let i = 0; i < 20; i++) noisy[i * 10] = 0x01; // 10% control bytes
    expect(looksLikeText(noisy)).toBe(false);
  });

  it("tolerates a rare stray control character in otherwise clean text (an ANSI escape in a log)", () => {
    const log = new Uint8Array(500);
    log.fill(0x41);
    log[100] = 0x1b; // one escape in 500 bytes - well under the ratio
    expect(looksLikeText(log)).toBe(true);
  });

  // The sampling-boundary case the hand-rolled validator exists for: a multi-byte character cut in half by
  // the fixed-size read window is an artifact of sampling, not a malformed file. TextDecoder({fatal:true})
  // cannot tell those apart and would call every such file binary.
  it("accepts a multi-byte character truncated by the sample window", () => {
    const full = utf8("aaa日"); // the CJK char is 3 bytes
    expect(looksLikeText(full.subarray(0, full.length - 1))).toBe(true);
    expect(looksLikeText(full.subarray(0, full.length - 2))).toBe(true);
  });

  it("still rejects a malformed sequence that is NOT at the boundary", () => {
    const truncatedMidway = new Uint8Array([...utf8("aaa"), 0xe6, 0x97, ...utf8("bbbbbbbb")]);
    expect(looksLikeText(truncatedMidway)).toBe(false);
  });

  it("exposes the sample size probe.ts reads", () => {
    expect(TEXT_DETECT_SAMPLE_BYTES).toBe(4096);
  });
});
