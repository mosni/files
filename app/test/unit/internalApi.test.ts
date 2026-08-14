import { afterEach, describe, expect, it, vi } from "vitest";
import { listAccounts, mintInviteLink, setAccountRole } from "../../src/auth/internalApi.ts";

// E7 Wave 0.2: this module is the one place this app talks to auth's internal API for sharing. Every
// failure mode must degrade to `{ ok: false, error, status }`, never throw and never surface the minted
// URL - a dead auth must become a visible dialog error, not a 500, and invariant 11 (never log a minted
// URL) binds here first.
describe("auth/internalApi.ts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("listAccounts()", () => {
    it("2xx: returns the directory unchanged", async () => {
      const accounts = [{ sub: "google:1", name: "Alice", picture: "https://auth.mosni.dev/avatar/google:1" }];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(accounts), { status: 200 })));
      const result = await listAccounts();
      expect(result).toEqual({ ok: true, value: accounts });
    });

    it("a non-2xx status becomes ok:false with the status passed through", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
      const result = await listAccounts();
      expect(result).toEqual({ ok: false, error: "auth_error", status: 503 });
    });

    it("a thrown fetch becomes auth_unreachable, status 0", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      const result = await listAccounts();
      expect(result).toEqual({ ok: false, error: "auth_unreachable", status: 0 });
    });

    // Review session 045: "it never throws" is the module's load-bearing rule, and a 200 is exactly where
    // it was still breakable - a proxy or error page answering 200 with HTML made res.json() reject, which
    // 500s GET /api/shares and (worse) 500s POST /api/shares AFTER the ACL row is already written.
    it("a 2xx with a non-JSON body becomes ok:false rather than throwing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>gateway</html>", { status: 200 })));
      await expect(listAccounts()).resolves.toEqual({ ok: false, error: "auth_error", status: 200 });
    });

    it("a 2xx whose JSON is not an array becomes ok:false rather than handing back a non-list", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 200 })));
      await expect(listAccounts()).resolves.toEqual({ ok: false, error: "auth_error", status: 200 });
    });
  });

  describe("setAccountRole()", () => {
    it("2xx: resolves ok:true", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));
      const result = await setAccountRole("link:abc123", "files:read", "remove");
      expect(result).toEqual({ ok: true, value: undefined });
    });

    it("a non-2xx JSON error body passes auth's code through verbatim", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "unknown_account" }), { status: 400 })),
      );
      const result = await setAccountRole("google:1", "files:read", "add");
      expect(result).toEqual({ ok: false, error: "unknown_account", status: 400 });
    });

    it("a thrown fetch becomes auth_unreachable, status 0, and still succeeds as best-effort for the caller", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      const result = await setAccountRole("google:1", "files:read", "remove");
      expect(result).toEqual({ ok: false, error: "auth_unreachable", status: 0 });
    });

    it("sends namespace/sub/role/action exactly", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      await setAccountRole("google:1", "files:read", "remove");
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://auth:3001/internal/roles");
      expect(JSON.parse(init.body as string)).toEqual({
        namespace: "files",
        sub: "google:1",
        role: "files:read",
        action: "remove",
      });
    });
  });

  describe("mintInviteLink()", () => {
    const MINTED_URL = "https://auth.mosni.dev/i/super-secret-token";

    it("2xx: returns url/id/expiresAt", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ url: MINTED_URL, id: "link1", expires_at: "2026-08-13T00:00:00.000Z" }), {
            status: 201,
          }),
        ),
      );
      const result = await mintInviteLink({
        roles: ["files:read"],
        ttlSeconds: 86400,
        destination: "https://files.mosni.dev/f/photo.jpg",
        label: "files: photo.jpg",
        allowRegister: true,
      });
      expect(result).toEqual({
        ok: true,
        value: { url: MINTED_URL, id: "link1", expiresAt: "2026-08-13T00:00:00.000Z" },
      });
    });

    it("sends the exact params, in auth's snake_case shape, with allow_register passed through as given", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ url: MINTED_URL, id: "link1", expires_at: "x" }), { status: 201 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await mintInviteLink({
        roles: ["files:read"],
        ttlSeconds: 3600,
        destination: "https://files.mosni.dev/f/photo.jpg",
        label: "files: photo.jpg",
        allowRegister: true,
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://auth:3001/internal/links");
      expect(JSON.parse(init.body as string)).toEqual({
        namespace: "files",
        roles: ["files:read"],
        ttl_seconds: 3600,
        destination: "https://files.mosni.dev/f/photo.jpg",
        label: "files: photo.jpg",
        allow_register: true,
      });
    });

    // E7-QA1 §B1.7/D-198: allowRegister is now a real caller-supplied parameter, not a hardcoded `true` -
    // this is the guard that a `false` choice actually reaches auth, not just that `true` does.
    it("passes allowRegister: false through as allow_register: false", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ url: MINTED_URL, id: "link2", expires_at: "x" }), { status: 201 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await mintInviteLink({
        roles: ["files:read"],
        ttlSeconds: 3600,
        destination: "https://files.mosni.dev/f/photo.jpg",
        label: "files: photo.jpg",
        allowRegister: false,
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((JSON.parse(init.body as string) as { allow_register: boolean }).allow_register).toBe(false);
    });

    it("a non-2xx JSON error (e.g. ttl_too_long) passes the code through and NEVER contains a minted url", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "ttl_too_long" }), { status: 400 })),
      );
      const result = await mintInviteLink({
        roles: ["files:read"],
        ttlSeconds: 999_999,
        destination: "https://files.mosni.dev/f/photo.jpg",
        label: "files: photo.jpg",
        allowRegister: true,
      });
      expect(result).toEqual({ ok: false, error: "ttl_too_long", status: 400 });
      expect(JSON.stringify(result)).not.toContain("http");
    });

    it("a thrown fetch becomes auth_unreachable, status 0, and never contains a minted url", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      const result = await mintInviteLink({
        roles: ["files:read"],
        ttlSeconds: 86400,
        destination: "https://files.mosni.dev/f/photo.jpg",
        label: "files: photo.jpg",
        allowRegister: true,
      });
      expect(result).toEqual({ ok: false, error: "auth_unreachable", status: 0 });
      expect(JSON.stringify(result)).not.toContain("http");
    });
  });
});
