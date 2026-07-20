import { describe, expect, it, vi } from "vitest";
import { emitAuditEvent } from "../../src/storage/audit.ts";
import type { AuditEvent } from "../../src/lib/audit.ts";

// A dedicated file so the module's configured botApi starts fresh (vitest isolates module state per test
// file) - audit-emitter.test.ts's beforeEach already calls initAudit(), which would make this unreachable
// there. Mirrors db-guard.test.ts's precedent for the same reason.
describe("storage/audit.ts - emitAuditEvent() before initAudit() is ever called", () => {
  it("does nothing and does not throw when no target is configured", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const event: AuditEvent = { action: "upload", actor: "hannah", target: "photo.png" };
    expect(() => emitAuditEvent(event)).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
