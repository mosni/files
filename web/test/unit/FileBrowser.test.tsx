(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileBrowser } from "../../src/components/FileBrowser.tsx";
import type { BrowseCollection, BrowseFile, BrowseResponse } from "../../../app/src/lib/browseContext.ts";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeCollection(overrides: Partial<BrowseCollection> = {}): BrowseCollection {
  return {
    id: "coll0000000000id",
    name: "Photos",
    effectiveProtection: "unlisted",
    defaultProtection: "unlisted",
    reason: "own",
    previewUrl: "https://files.mosni.dev/f/Photos",
    ...overrides,
  };
}

function makeFile(overrides: Partial<BrowseFile> = {}): BrowseFile {
  return {
    id: "file0000000000id",
    name: "photo.png",
    bytes: 2048,
    createdAt: "2026-07-28T00:00:00.000Z",
    effectiveProtection: "unlisted",
    reason: "own",
    previewUrl: "https://files.mosni.dev/f/photo.png",
    directUrl: "https://dl.mosni.dev/photo.png",
    width: 800,
    height: 600,
    durationSeconds: null,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<BrowseResponse> = {}): BrowseResponse {
  return {
    breadcrumb: [],
    collections: [],
    files: [],
    nextOffset: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 404, json: () => Promise.resolve(body) };
}

let container: HTMLDivElement;
let root: Root;

describe("FileBrowser (E4 waves D: the browser component)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { mosni?: unknown }).mosni;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("signed out: fetches scope=public with no Bearer and renders collections then files", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => null,
      token: () => null,
      onChange: (cb: (u: unknown) => void) => cb(null),
    };
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(
        makeResponse({
          collections: [makeCollection({ reason: "public" })],
          files: [makeFile({ reason: "public" })],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/browse?scope=public"),
      expect.not.objectContaining({ headers: expect.anything() }),
    );
    expect(container.textContent).toContain("Photos");
    expect(container.textContent).toContain("photo.png");
    // collections render before files in DOM order (D-102)
    expect(container.textContent!.indexOf("Photos")).toBeLessThan(container.textContent!.indexOf("photo.png"));
  });

  it("signed in with files:write: defaults to scope=mine with a Bearer", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: ["files:write"] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
    };
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(makeResponse()));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/browse?scope=mine"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) }),
    );
  });

  it("clicking a collection row drills in, refetching with collectionId set and showing the breadcrumb", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => null,
      token: () => null,
      onChange: (cb: (u: unknown) => void) => cb(null),
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeResponse({ collections: [makeCollection({ reason: "public" })] })))
      .mockResolvedValueOnce(
        jsonResponse(
          makeResponse({
            breadcrumb: [{ id: "coll0000000000id", name: "Photos" }],
            files: [makeFile({ reason: "public" })],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();

    const collectionButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Photos"),
    ) as HTMLButtonElement;
    await act(async () => {
      collectionButton.click();
      await flush();
    });

    // anonymous (no token) - same "no headers arg at all" shape the first test pins down.
    expect(fetchSpy).toHaveBeenLastCalledWith(expect.stringContaining("collectionId=coll0000000000id"), undefined);
    expect(container.textContent).toContain("Photos"); // now in the breadcrumb
    expect(container.textContent).toContain("photo.png");
  });

  it('"load more" appends the next page without discarding the current one', async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => null,
      token: () => null,
      onChange: (cb: (u: unknown) => void) => cb(null),
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(makeResponse({ files: [makeFile({ id: "f1", name: "one.png", reason: "public" })], nextOffset: 100 })),
      )
      .mockResolvedValueOnce(
        jsonResponse(makeResponse({ files: [makeFile({ id: "f2", name: "two.png", reason: "public" })], nextOffset: null })),
      );
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();
    expect(container.textContent).toContain("one.png");

    const loadMore = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Load more") as HTMLButtonElement;
    await act(async () => {
      loadMore.click();
      await flush();
    });

    expect(fetchSpy).toHaveBeenLastCalledWith(expect.stringContaining("offset=100"), undefined);
    expect(container.textContent).toContain("one.png");
    expect(container.textContent).toContain("two.png");
    expect(container.querySelector("button[disabled]")).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Load more")).toBe(false);
  });

  it("shows the visibility badge for each row's reason", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [makeFile({ reason: "public" })] }))),
    );
    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();
    expect(container.querySelector(".badge.success")?.textContent).toBe("Public");
  });

  it("owner row (reason=own) gets a protection control and a delete button; a non-owner row gets neither", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: [] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: [] }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          makeResponse({
            files: [
              makeFile({ id: "mine", name: "mine.png", reason: "own" }),
              makeFile({ id: "theirs", name: "theirs.png", reason: "public" }),
            ],
          }),
        ),
      ),
    );

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();

    const rows = Array.from(container.querySelectorAll("[data-row-id]"));
    const mineRow = rows.find((r) => r.getAttribute("data-row-id") === "mine")!;
    const theirsRow = rows.find((r) => r.getAttribute("data-row-id") === "theirs")!;
    expect(mineRow.querySelector("select")).not.toBeNull();
    expect(Array.from(mineRow.querySelectorAll("button")).some((b) => b.textContent === "Delete")).toBe(true);
    expect(theirsRow.querySelector("select")).toBeNull();
    expect(Array.from(theirsRow.querySelectorAll("button")).some((b) => b.textContent === "Delete")).toBe(false);
  });

  it("collection create form posts to /api/collections with the current collectionId as parentId and reloads", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: ["files:write"] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeResponse())) // initial listing
      .mockResolvedValueOnce(jsonResponse({ id: "newcoll", name: "New" }, true)) // POST /api/collections
      .mockResolvedValueOnce(jsonResponse(makeResponse({ collections: [makeCollection({ name: "New" })] }))); // reload
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();

    const input = container.querySelector('input[aria-label="New collection name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "New");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/api/collections",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        body: JSON.stringify({ name: "New" }),
      }),
    );
  });

  it("collection delete asks for a dryRun count first and only deletes for real after confirming", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: [] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: [] }),
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeResponse({ collections: [makeCollection({ reason: "own" })] })))
      .mockResolvedValueOnce(jsonResponse({ collectionCount: 3, fileCount: 5 }))
      .mockResolvedValueOnce({ ok: true, status: 204, json: () => Promise.resolve(undefined) })
      .mockResolvedValueOnce(jsonResponse(makeResponse()));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();

    const deleteButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Delete") as HTMLButtonElement;
    await act(async () => {
      deleteButton.click();
      await flush();
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/api/collections/coll0000000000id?dryRun=true"),
      expect.anything(),
    );
    expect(container.textContent).toContain("2 nested collections");
    expect(container.textContent).toContain("5 files");

    const confirmButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Yes, delete") as HTMLButtonElement;
    await act(async () => {
      confirmButton.click();
      await flush();
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "/api/collections/coll0000000000id",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("dispatching mosni-tab-change on the tab bar switches scope and resets to the root", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: ["files:write"] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
    };
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(makeResponse()));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();
    expect(fetchSpy).toHaveBeenLastCalledWith(expect.stringContaining("scope=mine"), expect.anything());

    // Tab order is "My files" (0), "Browse" (1), "All files" absent (no admin role) - index 1 is public.
    const tabs = container.querySelector("mosni-tabs")!;
    await act(async () => {
      tabs.dispatchEvent(new CustomEvent("mosni-tab-change", { detail: { index: 1, label: "Browse" } }));
      await flush();
    });

    expect(fetchSpy).toHaveBeenLastCalledWith(expect.stringContaining("scope=public"), expect.anything());
  });

  it("rename: submits the new name to the row's own PATCH endpoint and reloads", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: [] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: [] }),
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })))
      .mockResolvedValueOnce(jsonResponse({ ...makeFile({ reason: "own" }), name: "renamed.png" }))
      .mockResolvedValueOnce(jsonResponse(makeResponse({ files: [makeFile({ reason: "own", name: "renamed.png" })] })));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();

    const renameButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Rename") as HTMLButtonElement;
    act(() => renameButton.click());

    const input = container.querySelector('input[aria-label="New name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "renamed.png");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = Array.from(container.querySelectorAll("form")).find((f) => f.querySelector('input[aria-label="New name"]')) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/api/files/file0000000000id",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "renamed.png" }) }),
    );
  });

  it("breadcrumb: a crumb navigates there, and Home returns to the root", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(
        makeResponse({
          breadcrumb: [
            { id: "root-id", name: "Root" },
            { id: "child-id", name: "Child" },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser initialScope="public" />);
    });
    await flush();

    const rootCrumb = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Root") as HTMLButtonElement;
    await act(async () => {
      rootCrumb.click();
      await flush();
    });
    expect(fetchSpy).toHaveBeenLastCalledWith(expect.stringContaining("collectionId=root-id"), undefined);

    const home = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Home") as HTMLButtonElement;
    await act(async () => {
      home.click();
      await flush();
    });
    expect(fetchSpy).toHaveBeenLastCalledWith("/api/browse?scope=public", undefined);
  });

  it("rename: cancelling closes the field without issuing a PATCH", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => ({ sub: "user:a" }), token: () => "tok", onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a" }) };
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();

    const renameButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Rename") as HTMLButtonElement;
    act(() => renameButton.click());
    const cancelButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement;
    act(() => cancelButton.click());

    expect(container.querySelector('input[aria-label="New name"]')).toBeNull();
    expect(fetchSpy.mock.calls.filter((c) => c[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("collection delete: Cancel on the descendant-count confirmation deletes nothing", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => ({ sub: "user:a" }), token: () => "tok", onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a" }) };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeResponse({ collections: [makeCollection({ reason: "own" })] })))
      .mockResolvedValueOnce(jsonResponse({ collectionCount: 1, fileCount: 0 }));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();

    const deleteButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Delete") as HTMLButtonElement;
    await act(async () => {
      deleteButton.click();
      await flush();
    });
    expect(container.textContent).toContain('Delete "Photos"? This can\'t be undone.');

    const cancelButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement;
    await act(async () => {
      cancelButton.click();
      await flush();
    });

    expect(fetchSpy.mock.calls.filter((c) => c[1]?.method === "DELETE" && !String(c[0]).includes("dryRun"))).toHaveLength(0);
  });

  it("a failed protection PATCH on a file row does not reload the listing", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => ({ sub: "user:a" }), token: () => "tok", onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a" }) };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })))
      .mockResolvedValueOnce(jsonResponse({ error: "below_parent_protection" }, false));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<FileBrowser />);
    });
    await flush();

    const select = container.querySelector("select") as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(select, "public");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2); // the initial listing + the failed PATCH - no reload fetch followed
    expect(select.value).toBe("unlisted"); // reverted
  });

  it("the public scope shows no collection-create form even when signed in as an admin browsing scope=public", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: ["files:write", "files:delete"] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write", "files:delete"] }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse())));

    act(() => {
      root.render(<FileBrowser initialScope="public" />);
    });
    await flush();

    expect(container.querySelector('input[aria-label="New collection name"]')).toBeNull();
  });
});
