import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAuditEvent } from "../../src/storage/audit.ts";
import type { AuditEvent } from "../../src/lib/audit.ts";

const event: AuditEvent = { action: "upload", actor: "hannah", target: "photo.png" };

describe("emitAuditEvent() (D-43)", () => {
  beforeEach(() => {
    process.env.BOT_API = "http://bot-core:8080";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BOT_API;
  });

  it("posts to {BOT_API}/say with the correct payload shape and silent: true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    emitAuditEvent(event);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://bot-core:8080/say");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      channel: "server-notifications",
      content: expect.stringContaining("hannah"),
      silent: true,
    });
  });

  it("is void, not a promise the caller could accidentally await-and-fail on", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    const result = emitAuditEvent(event);
    expect(result).toBeUndefined();
  });

  it("a rejected fetch does not throw or reject out of emitAuditEvent - the actual invariant", () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(() => emitAuditEvent(event)).not.toThrow();
  });

  it("does nothing (and does not throw) when BOT_API is not configured", () => {
    delete process.env.BOT_API;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => emitAuditEvent(event)).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
