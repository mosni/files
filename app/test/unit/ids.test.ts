import { describe, expect, it } from "vitest";
import { generateId, ID_LENGTH, randomBase62 } from "../../src/lib/ids.ts";

describe("generateId() (D-81: base62 surrogate ids)", () => {
  it("produces an id of exactly ID_LENGTH base62 characters", () => {
    const shape = new RegExp(`^[A-Za-z0-9]{${ID_LENGTH}}$`);
    for (let i = 0; i < 200; i++) {
      expect(generateId()).toMatch(shape);
    }
  });

  it("has no duplicates across a few thousand draws", () => {
    const ids = Array.from({ length: 3000 }, () => generateId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("randomBase62()", () => {
  it("respects the requested length and alphabet", () => {
    expect(randomBase62(0)).toBe("");
    expect(randomBase62(1)).toMatch(/^[A-Za-z0-9]$/);
    expect(randomBase62(40)).toMatch(/^[A-Za-z0-9]{40}$/);
  });
});
