import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGrantableRoles } from "../../src/auth/grantable-roles.ts";

describe("registerGrantableRoles() (D-32)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers both roles against auth's internal API (files:admin dropped session 007)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await registerGrantableRoles();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const roles = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).role);
    expect(roles.sort()).toEqual(["files:delete", "files:write"]);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.namespace).toBe("files");
      expect(body.action).toBe("add");
    }
  });

  it("an unreachable auth (rejected fetch) does not throw and does not stop other roles registering", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(registerGrantableRoles()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a non-ok response does not throw", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "forbidden_namespace" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(registerGrantableRoles()).resolves.toBeUndefined();
  });
});
