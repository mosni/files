// E6 Wave E2: ensureCollectionPath - resolve-or-create each level of a folder path, memoised so a
// many-file folder creates each collection exactly once, and a 409 (a sibling already exists) re-lists and
// reuses it instead of failing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCollectionPathCacheForTests, ensureCollectionPath } from "../../src/lib/collections.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  __resetCollectionPathCacheForTests();
});

describe("ensureCollectionPath (Wave E2)", () => {
  it("returns the root parent unchanged for an empty path", async () => {
    const result = await ensureCollectionPath("tok", [], "root-id");
    expect(result).toBe("root-id");
  });

  it("creates each level in order under the given root, one POST per level", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        calls.push(JSON.parse(init.body as string));
        const body = JSON.parse(init.body as string) as { name: string };
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: `id-${body.name}` }) });
      }),
    );

    const result = await ensureCollectionPath("tok", ["photos", "2026"], null);

    expect(calls).toEqual([
      { parentId: "", name: "photos" },
      { parentId: "id-photos", name: "2026" },
    ]);
    expect(result).toBe("id-2026");
  });

  it("a 409 re-lists and reuses the existing sibling under the same parent, rather than failing", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve({ ok: false, status: 409 });
      }
      // GET /api/collections - the re-list
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ id: "existing-photos", name: "photos", parentId: "" }]),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureCollectionPath("tok", ["photos"], null);
    expect(result).toBe("existing-photos");
  });

  it("returns null when a level cannot be resolved or created (any failure other than 409)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    const result = await ensureCollectionPath("tok", ["bad name"], null);
    expect(result).toBeNull();
  });

  it("memoises across calls: two paths sharing a prefix create the shared level only ONCE", async () => {
    const postCalls: { parentId: string; name: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { parentId: string; name: string };
        postCalls.push(body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: `id-${body.parentId}/${body.name}` }) });
      }),
    );

    await ensureCollectionPath("tok", ["photos", "2026"], null);
    await ensureCollectionPath("tok", ["photos", "2027"], null);

    const photosCreations = postCalls.filter((c) => c.name === "photos");
    expect(photosCreations).toHaveLength(1); // NOT created twice, even though two paths both start with it
  });

  it("concurrent calls for the same level share the same in-flight promise (no duplicate POST)", async () => {
    let resolveFetch!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(() => pending);
    vi.stubGlobal("fetch", fetchMock);

    const first = ensureCollectionPath("tok", ["shared"], null);
    const second = ensureCollectionPath("tok", ["shared"], null);
    resolveFetch({ ok: true, json: () => Promise.resolve({ id: "id-shared" }) });

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBe("id-shared");
    expect(r2).toBe("id-shared");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
