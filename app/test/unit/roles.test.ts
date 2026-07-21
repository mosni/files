import { describe, expect, it } from "vitest";
import { can, isSuperuser, type Claims } from "../../src/lib/roles.ts";

const claims = (partial: Partial<Claims>): Claims => ({ sub: "user:1", ...partial });

describe("can() (files:admin dropped session 007 - no implication anymore)", () => {
  it("a held role exactly matching the asked role is true", () => {
    expect(can(claims({ roles: ["files:write"] }), "files:write")).toBe(true);
    expect(can(claims({ roles: ["files:delete"] }), "files:delete")).toBe(true);
  });

  it("files:write does NOT grant files:delete and vice versa (no implication)", () => {
    expect(can(claims({ roles: ["files:write"] }), "files:delete")).toBe(false);
    expect(can(claims({ roles: ["files:delete"] }), "files:write")).toBe(false);
  });

  it("an admin is simply a user assigned both lower roles", () => {
    const admin = claims({ roles: ["files:write", "files:delete"] });
    expect(can(admin, "files:write")).toBe(true);
    expect(can(admin, "files:delete")).toBe(true);
  });

  it("mosni_owner is true for every role, even with an empty or absent roles array", () => {
    expect(can(claims({ mosni_owner: true, roles: [] }), "files:write")).toBe(true);
    expect(can(claims({ mosni_owner: true, roles: [] }), "files:delete")).toBe(true);
    expect(can(claims({ mosni_owner: true, roles: undefined }), "files:write")).toBe(true);
  });

  it("null claims is false for every role", () => {
    expect(can(null, "files:write")).toBe(false);
    expect(can(null, "files:delete")).toBe(false);
  });

  it("roles absent or not an array returns false without throwing", () => {
    expect(() => can(claims({ roles: undefined }), "files:write")).not.toThrow();
    expect(can(claims({ roles: undefined }), "files:write")).toBe(false);
    expect(can(claims({ roles: "files:write" }), "files:write")).toBe(false);
    expect(can(claims({ roles: { role: "files:write" } }), "files:write")).toBe(false);
  });

  it("ignores non-string entries in roles without throwing", () => {
    expect(() => can(claims({ roles: [42, null, { x: 1 }] }), "files:write")).not.toThrow();
    expect(can(claims({ roles: [42, null, { x: 1 }] }), "files:write")).toBe(false);
  });
});

describe("isSuperuser()", () => {
  it("is true only for mosni_owner === true", () => {
    expect(isSuperuser(claims({ mosni_owner: true }))).toBe(true);
    expect(isSuperuser(claims({ mosni_owner: false }))).toBe(false);
    expect(isSuperuser(claims({ roles: ["files:write", "files:delete"] }))).toBe(false);
    expect(isSuperuser(null)).toBe(false);
  });
});
