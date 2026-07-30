import { describe, expect, it, vi } from "vitest";
import {
  generateLinkToken,
  isLinkTokenShaped,
  LINK_TOKEN_LENGTH,
  mintUniqueToken,
} from "../../src/lib/tokens.ts";

describe("generateLinkToken() (P5: short base62 tokens)", () => {
  it("produces a token of exactly LINK_TOKEN_LENGTH base62 characters", () => {
    const shape = new RegExp(`^[A-Za-z0-9]{${LINK_TOKEN_LENGTH}}$`);
    for (let i = 0; i < 200; i++) {
      expect(generateLinkToken()).toMatch(shape);
    }
  });

  it("uses a large enough space that a modest sample is essentially all-unique", () => {
    // 5 base62 chars is ~916M values; 500 samples colliding is vanishingly unlikely, but assert a loose
    // bound rather than strict uniqueness so the test can never flake on the astronomically rare dup.
    const tokens = Array.from({ length: 500 }, () => generateLinkToken());
    expect(new Set(tokens).size).toBeGreaterThanOrEqual(498);
  });
});

describe("mintUniqueToken() (D-98: the namespace is shared across files and collections)", () => {
  it("returns a well-shaped token on the first try when nothing collides", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const token = await mintUniqueToken(exists);
    expect(token).toMatch(new RegExp(`^[A-Za-z0-9]{${LINK_TOKEN_LENGTH}}$`));
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it("retries on collision until the existence check reports free", async () => {
    const exists = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const token = await mintUniqueToken(exists);
    expect(exists).toHaveBeenCalledTimes(3);
    expect(token).toMatch(new RegExp(`^[A-Za-z0-9]{${LINK_TOKEN_LENGTH}}$`));
  });

  it("gives up after 10 attempts rather than looping forever", async () => {
    const exists = vi.fn().mockResolvedValue(true);
    await expect(mintUniqueToken(exists)).rejects.toThrow(/could not mint/);
    expect(exists).toHaveBeenCalledTimes(10);
  });
});

describe("isLinkTokenShaped()", () => {
  it("accepts a freshly generated token", () => {
    expect(isLinkTokenShaped(generateLinkToken())).toBe(true);
  });

  it("rejects wrong lengths, the empty string, and non-base62 characters", () => {
    expect(isLinkTokenShaped("")).toBe(false);
    expect(isLinkTokenShaped("A".repeat(LINK_TOKEN_LENGTH - 1))).toBe(false);
    expect(isLinkTokenShaped("A".repeat(LINK_TOKEN_LENGTH + 1))).toBe(false);
    // base62 excludes the path/url-hostile characters entirely.
    expect(isLinkTokenShaped("ab/de")).toBe(false);
    expect(isLinkTokenShaped("ab-de")).toBe(false);
    expect(isLinkTokenShaped("ab_de")).toBe(false);
    expect(isLinkTokenShaped("ab+de")).toBe(false);
  });
});
