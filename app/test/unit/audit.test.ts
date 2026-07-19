import { describe, expect, it } from "vitest";
import { formatAuditLine, type AuditEvent, type WriteAction } from "../../src/lib/audit.ts";

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
    const line = formatAuditLine(base({ action: "upload", protection: "semi-private" }));
    expect(line).toContain("(semi-private)");
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
