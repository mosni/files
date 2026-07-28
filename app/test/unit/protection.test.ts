import { describe, expect, it } from "vitest";
import {
  isListedFor,
  mostRestrictive,
  PROTECTION_ORDER,
  readablePathResolves,
  type Protection,
} from "../../src/lib/protection.ts";

const PROTECTIONS: readonly Protection[] = ["public", "unlisted", "secret", "private"];
const NON_PUBLIC: readonly Protection[] = ["unlisted", "secret", "private"];

const anon = { sub: null, isAdmin: false };
const admin = { sub: "user:admin", isAdmin: true };
const owner = { sub: "user:owner", isAdmin: false };
const otherUser = { sub: "user:other", isAdmin: false };

// D-101/D-103: isListedFor() now takes the EFFECTIVE protection level (never the stored column - that is
// the caller's job to resolve) and a `granted` flag (an ACL grant is DB I/O, resolved by the storage
// layer and handed in as a value, same pattern as the protection chain itself). It returns the reason a
// listing includes the row, or null when it does not - the browser needs the reason anyway, and one
// function producing both keeps them from disagreeing.
describe("isListedFor()", () => {
  describe("anonymous viewer sees only public", () => {
    it.each([
      ["owned collection", "user:owner"],
      ["unowned collection", null],
    ] as const)("%s", (_label, ownerSub) => {
      expect(isListedFor("public", anon, ownerSub, false)).toBe("public");
      for (const protection of NON_PUBLIC) {
        expect(isListedFor(protection, anon, ownerSub, false)).toBeNull();
      }
    });
  });

  describe("the owner sees all four levels of their own files, reason 'own'", () => {
    it.each(PROTECTIONS)("%s", (protection) => {
      expect(isListedFor(protection, owner, "user:owner", false)).toBe("own");
    });
  });

  describe("an admin sees everything, including an unowned collection, reason 'admin'", () => {
    it.each(PROTECTIONS)("%s, owned", (protection) => {
      expect(isListedFor(protection, admin, "user:owner", false)).toBe("admin");
    });

    it.each(PROTECTIONS)("%s, unowned", (protection) => {
      expect(isListedFor(protection, admin, null, false)).toBe("admin");
    });
  });

  describe("a signed-in non-owner, non-admin, non-granted viewer sees only public", () => {
    it("public is visible, reason 'public'", () => {
      expect(isListedFor("public", otherUser, "user:owner", false)).toBe("public");
    });

    it.each(NON_PUBLIC)("%s is hidden", (protection) => {
      expect(isListedFor(protection, otherUser, "user:owner", false)).toBeNull();
    });

    it("still sees nothing non-public in an unowned collection - there is no owner to match", () => {
      for (const protection of NON_PUBLIC) {
        expect(isListedFor(protection, otherUser, null, false)).toBeNull();
      }
    });
  });

  describe("an ACL grant, reason 'granted' (D-103: unreachable in-product until E7, directly testable now)", () => {
    it.each(PROTECTIONS)("%s is listed for a grantee", (protection) => {
      expect(isListedFor(protection, otherUser, "user:owner", true)).toBe("granted");
    });

    it("own takes precedence over granted", () => {
      expect(isListedFor("private", owner, "user:owner", true)).toBe("own");
    });

    it("granted takes precedence over admin", () => {
      expect(isListedFor("private", admin, "user:owner", true)).toBe("granted");
    });
  });
});

// D-96: the ordering table itself, and mostRestrictive()'s fold over it - the core of effective
// protection. Exhaustive: every ordered pair, plus the single-element and (deliberately erroring)
// empty-array cases.
describe("PROTECTION_ORDER", () => {
  it("is strictly increasing in restrictiveness: public < unlisted < secret < private", () => {
    expect(PROTECTION_ORDER.public).toBeLessThan(PROTECTION_ORDER.unlisted);
    expect(PROTECTION_ORDER.unlisted).toBeLessThan(PROTECTION_ORDER.secret);
    expect(PROTECTION_ORDER.secret).toBeLessThan(PROTECTION_ORDER.private);
  });
});

describe("mostRestrictive()", () => {
  it("a single-element chain returns that element", () => {
    for (const protection of PROTECTIONS) {
      expect(mostRestrictive([protection])).toBe(protection);
    }
  });

  it.each([
    [["public", "unlisted"], "unlisted"],
    [["unlisted", "public"], "unlisted"],
    [["public", "secret"], "secret"],
    [["public", "private"], "private"],
    [["unlisted", "secret"], "secret"],
    [["unlisted", "private"], "private"],
    [["secret", "private"], "private"],
    [["public", "public"], "public"],
    [["private", "private"], "private"],
  ] as const)("mostRestrictive(%j) === %s", (levels, expected) => {
    expect(mostRestrictive(levels)).toBe(expected);
  });

  it("folds a longer ancestor chain plus the file's own level down to the single worst", () => {
    expect(mostRestrictive(["public", "unlisted", "public", "secret", "public"])).toBe("secret");
    expect(mostRestrictive(["private", "public", "public", "public"])).toBe("private");
  });

  it("order within the array does not matter", () => {
    expect(mostRestrictive(["private", "public", "secret"])).toBe("private");
    expect(mostRestrictive(["secret", "private", "public"])).toBe("private");
  });

  it("throws on an empty chain rather than silently picking a default", () => {
    expect(() => mostRestrictive([])).toThrow(/requires at least one level/);
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
