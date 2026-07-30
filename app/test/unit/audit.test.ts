import { describe, expect, it } from "vitest";
import { actorLabel, formatAuditLine, type AuditEvent, type WriteAction } from "../../src/lib/audit.ts";

const base = (overrides: Partial<AuditEvent> & Pick<AuditEvent, "action">): AuditEvent => ({
  actor: "hannah",
  target: "photo.png",
  ...overrides,
});

describe("formatAuditLine()", () => {
  const actions: WriteAction[] = [
    "upload",
    "rename",
    "delete",
    "protection-change",
    "share-change",
    "invite-create",
    "invite-revoke",
  ];

  it.each(actions)("formats a bare %s event with no optional fields", (action) => {
    const line = formatAuditLine(base({ action }));
    expect(line).toContain("hannah");
    expect(line).toContain('"photo.png"');
    expect(line).not.toContain("(");
  });

  it("includes protection level when present", () => {
    // D-59: "semi-private" split into unlisted/secret - protection now tracks lib/protection.ts's
    // four-level Protection type.
    const line = formatAuditLine(base({ action: "upload", protection: "unlisted" }));
    expect(line).toContain("(unlisted)");
  });

  it("includes size when present, human-readable", () => {
    const line = formatAuditLine(base({ action: "upload", bytes: 1_572_864 }));
    expect(line).toContain("1.5 MB");
  });

  it("includes collection when present", () => {
    const line = formatAuditLine(base({ action: "upload", collection: "vacation" }));
    expect(line).toContain("in vacation");
  });

  it("combines all optional fields, comma-separated, in one parenthetical", () => {
    const line = formatAuditLine(
      base({ action: "upload", protection: "public", bytes: 2048, collection: "vacation" }),
    );
    expect(line).toBe('hannah uploaded "photo.png" (public, 2.0 KB, in vacation)');
  });

  it("small byte counts stay in bytes with no decimal", () => {
    expect(formatAuditLine(base({ action: "upload", bytes: 512 }))).toContain("512 B");
  });

  it("omits optional fields cleanly - no stray parentheses or commas", () => {
    const line = formatAuditLine(base({ action: "delete" }));
    expect(line).toBe('hannah deleted "photo.png"');
  });
});

describe("actorLabel()", () => {
  // The audit channel is an internal ops Discord channel, not public - unlike the default collection name
  // (controllers/upload.ts), showing the sub here is not a privacy leak, just less readable than a name.
  it("prefers the name claim when present", () => {
    expect(actorLabel({ sub: "google:138543663", name: "Hannah" })).toBe("Hannah");
  });

  it("falls back to sub when there is no name claim", () => {
    expect(actorLabel({ sub: "google:138543663" })).toBe("google:138543663");
  });

  it("falls back to sub when name is blank or not a string", () => {
    expect(actorLabel({ sub: "eve:123", name: "   " })).toBe("eve:123");
    expect(actorLabel({ sub: "eve:123", name: 42 })).toBe("eve:123");
  });
});
