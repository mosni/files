import { describe, expect, it } from "vitest";
import { isListedFor, readablePathResolves, type Protection } from "../../src/lib/protection.ts";

const PROTECTIONS: readonly Protection[] = ["public", "unlisted", "secret", "private"];
const NON_PUBLIC: readonly Protection[] = ["unlisted", "secret", "private"];

const anon = { sub: null, isAdmin: false };
const admin = { sub: "user:admin", isAdmin: true };
const owner = { sub: "user:owner", isAdmin: false };
const otherUser = { sub: "user:other", isAdmin: false };

describe("isListedFor()", () => {
  describe("anonymous viewer sees only public", () => {
    it.each([
      ["owned collection", "user:owner"],
      ["unowned collection", null],
    ] as const)("%s", (_label, ownerSub) => {
      expect(isListedFor("public", anon, ownerSub)).toBe(true);
      for (const protection of NON_PUBLIC) {
        expect(isListedFor(protection, anon, ownerSub)).toBe(false);
      }
    });
  });

  describe("the owner sees all four levels of their own files", () => {
    it.each(PROTECTIONS)("%s", (protection) => {
      expect(isListedFor(protection, owner, "user:owner")).toBe(true);
    });
  });

  describe("an admin sees everything, including an unowned collection", () => {
    it.each(PROTECTIONS)("%s, owned", (protection) => {
      expect(isListedFor(protection, admin, "user:owner")).toBe(true);
    });

    it.each(PROTECTIONS)("%s, unowned", (protection) => {
      expect(isListedFor(protection, admin, null)).toBe(true);
    });
  });

  describe("a signed-in non-owner, non-admin viewer sees only public", () => {
    it("public is visible", () => {
      expect(isListedFor("public", otherUser, "user:owner")).toBe(true);
    });

    it.each(NON_PUBLIC)("%s is hidden", (protection) => {
      expect(isListedFor(protection, otherUser, "user:owner")).toBe(false);
    });

    it("still sees nothing non-public in an unowned collection - there is no owner to match", () => {
      for (const protection of NON_PUBLIC) {
        expect(isListedFor(protection, otherUser, null)).toBe(false);
      }
    });
  });
});

describe("readablePathResolves()", () => {
  it("secret does NOT resolve - it must 404, not 403 (D-59)", () => {
    expect(readablePathResolves("secret")).toBe(false);
  });

  it.each(["public", "unlisted", "private"] as const)("%s resolves", (protection) => {
    expect(readablePathResolves(protection)).toBe(true);
  });
});
