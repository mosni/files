import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAuditQueueForTests, emitAuditEvent, initAudit } from "../../src/storage/audit.ts";
import type { AuditEvent } from "../../src/lib/audit.ts";

const event: AuditEvent = { action: "upload", actor: "hannah", target: "photo.png" };

describe("emitAuditEvent() (D-43)", () => {
  beforeEach(() => {
    initAudit("http://bot-core:8080");
    __resetAuditQueueForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  // Live-testing addition (2026-08-06): a bulk action (recursive collection delete, upload grouping)
  // calls emitAuditEvent() once per row in a tight synchronous loop - this proves those calls no longer
  // reach the network all at once, which is what a burst-rate-limited relay could otherwise silently drop
  // some of ("bulk operations... may not send a notification for each action").
  it("serializes a burst of calls instead of firing them all at once", async () => {
    __resetAuditQueueForTests({ spacingMs: 60 }); // shrunk so this test does not run at production speed
    const callTimes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callTimes.push(Date.now());
        return Promise.resolve(new Response("{}"));
      }),
    );

    for (let i = 0; i < 3; i++) emitAuditEvent({ ...event, target: `file-${i}` });

    await vi.waitFor(() => expect(callTimes).toHaveLength(3), { timeout: 3000 });
    expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(55);
    expect(callTimes[2]! - callTimes[1]!).toBeGreaterThanOrEqual(55);
  });

  it("one send timing out does not stop the rest of the queue from going out", async () => {
    __resetAuditQueueForTests({ spacingMs: 0, timeoutMs: 100 }); // shrunk so this test does not run at production speed
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        calls++;
        if (calls === 1) {
          // Simulate a hung request - never resolves on its own; only the AbortSignal ends it.
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return Promise.resolve(new Response("{}"));
      }),
    );

    emitAuditEvent({ ...event, target: "hangs" });
    emitAuditEvent({ ...event, target: "should-still-send" });

    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 2000 });
  });
});
