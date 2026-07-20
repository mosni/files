import { describe, expect, it } from "vitest";
import { generateLinkToken, isLinkTokenShaped } from "../../src/lib/tokens.ts";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

describe("generateLinkToken()", () => {
  it("produces 1000 unique tokens - collision odds are negligible at 128 bits of entropy", () => {
    const tokens = Array.from({ length: 1000 }, () => generateLinkToken());
    expect(new Set(tokens).size).toBe(1000);
  });

  it("every token matches the base64url token shape - 22 chars, no padding, no +/", () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateLinkToken()).toMatch(TOKEN_SHAPE);
    }
  });
});

describe("isLinkTokenShaped() - mandatory, distinguishes token segments from filename/path segments", () => {
  it("rejects the empty string", () => {
    expect(isLinkTokenShaped("")).toBe(false);
  });

  it("rejects a 21-character valid-alphabet string - wrong length", () => {
    expect(isLinkTokenShaped("A".repeat(21))).toBe(false);
  });

  it("rejects a 22-character string containing / - standard base64, not base64url", () => {
    expect(isLinkTokenShaped(`${"A".repeat(21)}/`)).toBe(false);
  });

  it("rejects a 22-character string containing + - standard base64, not base64url", () => {
    expect(isLinkTokenShaped(`${"A".repeat(21)}+`)).toBe(false);
  });

  it("accepts an actual generateLinkToken() output", () => {
    expect(isLinkTokenShaped(generateLinkToken())).toBe(true);
  });
});
