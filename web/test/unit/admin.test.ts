import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGrants, fetchUsage, revokeGrant } from "../../src/lib/admin.ts";

// E8 Wave D1: the typed fetch helpers behind pages/Admin.tsx. Admin.test.tsx mocks this module entirely,
// so nothing exercised the request shapes these helpers actually send - the module scored 0% in the
// coverage report (review session 059). This is the same gap E7 hit with web/src/lib/share.ts and closed
// the same way; filePatch.ts and uploads.ts each carry their own direct coverage for the same reason.
describe("web/src/lib/admin.ts", () => {
  beforeEach(() => {
    (window as unknown as { mosni: unknown }).mosni = { token: () => "tok-123" };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { mosni?: unknown }).mosni;
  });

  function stubFetch() {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("fetchGrants() GETs /api/admin/grants with the bearer", async () => {
    const fetchMock = stubFetch();
    await fetchGrants();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/grants");
    expect(init.method).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("fetchUsage() GETs /api/admin/usage with the bearer", async () => {
    const fetchMock = stubFetch();
    await fetchUsage();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/usage");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("revokeGrant() POSTs the target triple as JSON, with the bearer and a JSON content type", async () => {
    const fetchMock = stubFetch();
    await revokeGrant("collection", "c1", "link:abc");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/grants/revoke");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer tok-123");
    expect(JSON.parse(init.body as string)).toEqual({ targetType: "collection", targetId: "c1", sub: "link:abc" });
  });

  // The sub is sent verbatim, never parsed or reshaped (security invariant 6) - a `link:` grantee is just
  // another string to these helpers.
  it("sends a raw sub through untouched", async () => {
    const fetchMock = stubFetch();
    await revokeGrant("file", "f1", "google:112233445566778899");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).sub).toBe("google:112233445566778899");
  });

  // Signed out (no token) the helpers still send a well-formed request - the server's 401 is what answers,
  // never a client-side guess about who the viewer is.
  it("omits the Authorization header when no token is available", async () => {
    (window as unknown as { mosni: unknown }).mosni = { token: () => null };
    const fetchMock = stubFetch();
    await fetchGrants();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
