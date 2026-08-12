import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvite, fetchAccounts, fetchShareState, grantShare, revokeShare } from "../../src/lib/share.ts";

// E7 Wave D1: the typed fetch helpers behind ShareDialog.tsx. ShareDialog's own tests mock this module
// entirely, so this file is what actually exercises the request shapes (method, headers, body) these
// helpers send - the same reason filePatch.ts and uploads.ts each get their own direct coverage.
describe("web/src/lib/share.ts", () => {
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

  it("fetchAccounts() GETs /api/accounts with the bearer", async () => {
    const fetchMock = stubFetch();
    await fetchAccounts();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/accounts");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("fetchShareState() GETs /api/shares with the type/id query and the bearer", async () => {
    const fetchMock = stubFetch();
    await fetchShareState("collection", "c 1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/shares?type=collection&id=${encodeURIComponent("c 1")}`);
  });

  it("grantShare() POSTs the body, omitting canUpload when not passed", async () => {
    const fetchMock = stubFetch();
    await grantShare("file", "f1", "google:1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/shares");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ type: "file", id: "f1", sub: "google:1" });
  });

  it("grantShare() includes canUpload when passed (collection grants)", async () => {
    const fetchMock = stubFetch();
    await grantShare("collection", "c1", "google:1", true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ type: "collection", id: "c1", sub: "google:1", canUpload: true });
  });

  it("revokeShare() POSTs /api/shares/revoke with type/id/sub", async () => {
    const fetchMock = stubFetch();
    await revokeShare("file", "f1", "google:1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/shares/revoke");
    expect(JSON.parse(init.body as string)).toEqual({ type: "file", id: "f1", sub: "google:1" });
  });

  it("createInvite() POSTs /api/invites, omitting canUpload when not passed", async () => {
    const fetchMock = stubFetch();
    await createInvite("file", "f1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/invites");
    expect(JSON.parse(init.body as string)).toEqual({ type: "file", id: "f1" });
  });

  it("createInvite() includes canUpload when passed", async () => {
    const fetchMock = stubFetch();
    await createInvite("collection", "c1", false);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ type: "collection", id: "c1", canUpload: false });
  });

  it("works with no bearer (window.mosni undefined) - no Authorization header", async () => {
    delete (window as unknown as { mosni?: unknown }).mosni;
    const fetchMock = stubFetch();
    await fetchAccounts();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
