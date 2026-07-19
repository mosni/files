import { describe, expect, it } from "vitest";
import { can, type Claims } from "../../src/lib/roles.ts";

const claims = (partial: Partial<Claims>): Claims => ({ sub: "user:1", ...partial });

describe("can()", () => {
  it("files:admin implies files:write (D-22 - the vendored snippet does not provide this)", () => {
    expect(can(claims({ roles: ["files:admin"] }), "files:write")).toBe(true);
  });

  it("files:admin implies files:delete", () => {
    expect(can(claims({ roles: ["files:admin"] }), "files:delete")).toBe(true);
  });

  it("files:write does NOT imply files:delete", () => {
    expect(can(claims({ roles: ["files:write"] }), "files:delete")).toBe(false);
  });

  it("mosni_owner is true for every role, even with an empty roles array", () => {
    const owner = claims({ mosni_owner: true, roles: [] });
    expect(can(owner, "files:write")).toBe(true);
    expect(can(owner, "files:delete")).toBe(true);
    expect(can(owner, "files:admin")).toBe(true);
  });

  it("mosni_owner is true even when roles is absent", () => {
    expect(can(claims({ mosni_owner: true, roles: undefined }), "files:admin")).toBe(true);
  });

  it("null claims is false for every role", () => {
    expect(can(null, "files:write")).toBe(false);
    expect(can(null, "files:delete")).toBe(false);
    expect(can(null, "files:admin")).toBe(false);
  });

  it("roles absent returns false without throwing", () => {
    expect(() => can(claims({ roles: undefined }), "files:write")).not.toThrow();
    expect(can(claims({ roles: undefined }), "files:write")).toBe(false);
  });

  it("roles not an array returns false without throwing", () => {
    expect(() => can(claims({ roles: "files:write" }), "files:write")).not.toThrow();
    expect(can(claims({ roles: "files:write" }), "files:write")).toBe(false);
    expect(can(claims({ roles: { role: "files:write" } }), "files:write")).toBe(false);
  });

  it("an unrelated held role grants nothing", () => {
    expect(can(claims({ roles: ["files:write"] }), "files:admin")).toBe(false);
  });

  it("a held role exactly matching the asked role is true", () => {
    expect(can(claims({ roles: ["files:delete"] }), "files:delete")).toBe(true);
  });

  it("ignores non-string entries in roles without throwing", () => {
    expect(() => can(claims({ roles: [42, null, { x: 1 }] }), "files:write")).not.toThrow();
    expect(can(claims({ roles: [42, null, { x: 1 }] }), "files:write")).toBe(false);
  });

  // A role string that happens to name an Object.prototype key must be treated as just an unknown role.
  // The implication table is looked up by held-role name, so a prototype-chain hit would resolve to a
  // function rather than an array. `can()` is the app-wide authorization gate - it fails closed, but it
  // must fail closed by returning false, not by throwing a 500 out of every route that checks a role.
  it.each(["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"])(
    "treats the prototype-chain name %s as an unknown role, without throwing",
    (held) => {
      expect(() => can(claims({ roles: [held] }), "files:write")).not.toThrow();
      expect(can(claims({ roles: [held] }), "files:write")).toBe(false);
      expect(can(claims({ roles: [held] }), "files:admin")).toBe(false);
    },
  );
});
