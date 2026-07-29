(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { FileBrowser } from "../../src/components/FileBrowser.tsx";
import type { BrowseCollection, BrowseFile, BrowseResponse } from "../../../app/src/lib/browseContext.ts";

// E4.1 Wave C: FileBrowser no longer drills via local state - a collection click is a REAL navigation
// (useNavigate), and pages/Preview.tsx (not FileBrowser itself) re-resolves and remounts on the new URL.
// This spy observes what FileBrowser actually navigated to, the same way a real <Routes> consumer would.
function LocationSpy({ onLocation }: { onLocation: (pathname: string) => void }) {
  const location = useLocation();
  useEffect(() => {
    onLocation(location.pathname);
  }, [location.pathname, onLocation]);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// `<mosni-dropdown>` never actually upgrades in jsdom (mosnicat.js isn't loaded here - see
// technical-baseline.md §4), so there is no real click-to-open/keyboard-nav behavior to drive. Tests
// interact with it the same way the existing `mosni-tab-change` test already does with `<mosni-tabs>`:
// dispatch the CustomEvent the real component would emit on selection, directly on the element.
async function selectRowAction(row: Element, value: string) {
  const dropdown = row.querySelector("mosni-dropdown")!;
  await act(async () => {
    dropdown.dispatchEvent(new CustomEvent("mosni-dropdown-select", { detail: { value } }));
    await flush();
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
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
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
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/browse?scope=mine"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) }),
    );
  });

  it("clicking a collection row navigates to its previewUrl's pathname (E4.1 Wave C, D-100: no URL construction)", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => null,
      token: () => null,
      onChange: (cb: (u: unknown) => void) => cb(null),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          makeResponse({
            collections: [makeCollection({ reason: "public", previewUrl: "https://files.mosni.dev/f/Photos" })],
          }),
        ),
      ),
    );

    const locations: string[] = [];
    act(() => {
      root.render(
        <MemoryRouter>
          <FileBrowser />
          <LocationSpy onLocation={(p) => locations.push(p)} />
        </MemoryRouter>,
      );
    });
    await flush();

    const collectionButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Photos"),
    ) as HTMLButtonElement;
    await act(async () => {
      collectionButton.click();
      await flush();
    });

    expect(locations.at(-1)).toBe("/f/Photos");
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
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
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

  it("shows the visibility indicator for each row's reason", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [makeFile({ reason: "public" })] }))),
    );
    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();
    expect(container.querySelector('mosni-tooltip[text="Public"] mosni-icon[name="globe"]')).not.toBeNull();
  });

  it("owner row (reason=own) gets a Protection menu item and a Delete item; a non-owner row gets neither", async () => {
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
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const rows = Array.from(container.querySelectorAll("[data-row-id]"));
    const mineRow = rows.find((r) => r.getAttribute("data-row-id") === "mine")!;
    const theirsRow = rows.find((r) => r.getAttribute("data-row-id") === "theirs")!;

    function itemValues(row: Element): string[] {
      return Array.from(row.querySelectorAll("mosni-dropdown-item")).map((item) => item.getAttribute("value")!);
    }
    expect(itemValues(mineRow)).toEqual(expect.arrayContaining(["rename", "protection", "delete"]));
    expect(itemValues(theirsRow)).not.toEqual(expect.arrayContaining(["rename"]));
    expect(itemValues(theirsRow)).not.toEqual(expect.arrayContaining(["protection"]));
    expect(itemValues(theirsRow)).not.toEqual(expect.arrayContaining(["delete"]));

    await selectRowAction(mineRow, "protection");
    expect(mineRow.parentElement!.querySelector("select")).not.toBeNull();
  });

  it("a files:delete holder (not the owner) sees Delete on someone else's row in All files, but not Rename or Protection (D-115)", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:admin", roles: ["files:delete"] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:admin", roles: ["files:delete"] }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(makeResponse({ files: [makeFile({ id: "theirs", name: "theirs.png", reason: "public" })] })),
      ),
    );

    act(() => {
      root.render(<MemoryRouter><FileBrowser initialScope="all" /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector('[data-row-id="theirs"]')!;
    const values = Array.from(row.querySelectorAll("mosni-dropdown-item")).map((item) => item.getAttribute("value")!);
    expect(values).toContain("delete");
    expect(values).not.toContain("rename");
    expect(values).not.toContain("protection");
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
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
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
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "delete");

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/api/collections/coll0000000000id?dryRun=true"),
      expect.anything(),
    );
    // D-88's pluralization fix: 3 collections total means 2 OTHER nested ones, correctly plural.
    expect(container.textContent).toContain("2 nested collections");
    expect(container.textContent).toContain("5 files");

    const confirmButton = Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Yes, delete") as HTMLButtonElement;
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

  it("collection delete confirmation pluralizes 0 and 1 descendant correctly", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => ({ sub: "user:a" }), token: () => "tok", onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a" }) };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeResponse({ collections: [makeCollection({ reason: "own" })] })))
      .mockResolvedValueOnce(jsonResponse({ collectionCount: 2, fileCount: 1 }));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "delete");

    // collectionCount 2 total = 1 OTHER nested collection (singular), fileCount 1 (singular).
    expect(container.textContent).toContain("1 nested collection ");
    expect(container.textContent).not.toContain("1 nested collections");
    expect(container.textContent).toContain("1 file ");
    expect(container.textContent).not.toContain("1 files");
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
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
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
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "rename");

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

  it("rename: a collection row submits to its own PATCH endpoint, closes the panel, and reloads", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: [] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: [] }),
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeResponse({ collections: [makeCollection({ reason: "own" })] })))
      .mockResolvedValueOnce(jsonResponse({ ...makeCollection({ reason: "own" }), name: "Renamed" }))
      .mockResolvedValueOnce(jsonResponse(makeResponse({ collections: [makeCollection({ reason: "own", name: "Renamed" })] })));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "rename");

    const input = container.querySelector('input[aria-label="New name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "Renamed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = Array.from(container.querySelectorAll("form")).find((f) => f.querySelector('input[aria-label="New name"]')) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/api/collections/coll0000000000id",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3); // the PATCH triggered a reload fetch too
    expect(container.querySelector('input[aria-label="New name"]')).toBeNull(); // the panel closed
  });

  // C3: a PERMANENT root crumb - always present, even at "/" itself (where it reads as plain text, not a
  // link, since it IS the current location). C4: ancestor crumbs are real links; the deepest/current one
  // is plain text, never a control.
  it("breadcrumb: Home is permanent; ancestor crumbs are links; the deepest crumb is not interactive", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          makeResponse({
            breadcrumb: [
              { id: "root-id", name: "Root", previewUrl: "https://files.mosni.dev/f/Root" },
              { id: "child-id", name: "Child", previewUrl: "https://files.mosni.dev/f/Root/Child" },
            ],
          }),
        ),
      ),
    );

    const locations: string[] = [];
    act(() => {
      root.render(
        <MemoryRouter>
          {/* A non-root breadcrumb only happens for a collection-route mount (Preview.tsx passes
              initialCollectionId) - a root mount's collectionId never changes after mount (E4.1 Wave C:
              drilling is a real navigation, not local state), so it can never be "not at root" itself. */}
          <FileBrowser initialCollectionId="child-id" />
          <LocationSpy onLocation={(p) => locations.push(p)} />
        </MemoryRouter>,
      );
    });
    await flush();

    // Home is a LINK here (we are not at root - there is a breadcrumb).
    const home = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Home") as HTMLAnchorElement;
    expect(home).not.toBeUndefined();

    // "Root" (ancestor) is a link; "Child" (current/deepest) is plain text, not any kind of control.
    const rootLink = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Root") as HTMLAnchorElement;
    expect(rootLink).not.toBeUndefined();
    expect(rootLink.getAttribute("href")).toBe("/f/Root");
    expect(Array.from(container.querySelectorAll("a, button")).some((el) => el.textContent === "Child")).toBe(false);
    expect(container.textContent).toContain("Child");

    await act(async () => {
      rootLink.click();
      await flush();
    });
    // The crumb's own onClick preventDefault()s the real <a> navigation and calls useNavigate() instead,
    // landing exactly on the crumb's own previewUrl pathname (D-100) rather than a client-constructed one.
    expect(locations.at(-1)).toBe("/f/Root");

    await act(async () => {
      home.click();
      await flush();
    });
    expect(locations.at(-1)).toBe("/");
  });

  it("breadcrumb: at root, Home reads as plain text (the current location), not a link", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse())));

    act(() => {
      root.render(
        <MemoryRouter>
          <FileBrowser initialScope="public" />
        </MemoryRouter>,
      );
    });
    await flush();

    expect(Array.from(container.querySelectorAll("a")).some((a) => a.textContent === "Home")).toBe(false);
    expect(container.textContent).toContain("Home");
  });

  it("rename: cancelling closes the field without issuing a PATCH", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => ({ sub: "user:a" }), token: () => "tok", onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a" }) };
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "rename");
    // Scoped to the rename form itself - the row's (always-present-but-closed, per jsdom's lack of
    // mosni-modal upgrade) delete-confirmation modal has its own "Cancel" button too.
    const renameForm = Array.from(container.querySelectorAll("form")).find((f) =>
      f.querySelector('input[aria-label="New name"]'),
    )!;
    const cancelButton = Array.from(renameForm.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement;
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
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "delete");
    expect(row.querySelector("mosni-modal")?.getAttribute("heading")).toBe('Delete "Photos"?');

    const cancelButton = Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement;
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
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "protection");

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
      root.render(<MemoryRouter><FileBrowser initialScope="public" /></MemoryRouter>);
    });
    await flush();

    expect(container.querySelector('input[aria-label="New collection name"]')).toBeNull();
  });

  // E4.1 Wave B: the listing becomes one real <table> (D-108, AC1) with the six columns §2/B1 lists, one
  // row per item rather than a `.panel` card (AC2).
  it("renders the listing as a single table with one row per item, no .panel cards", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          makeResponse({ collections: [makeCollection({ reason: "public" })], files: [makeFile({ reason: "public" })] }),
        ),
      ),
    );
    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const table = container.querySelector("table.table.interactive");
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll("tbody > tr[data-row-id]")).toHaveLength(2);
    expect(container.querySelectorAll(".panel[data-row-id]")).toHaveLength(0);
  });

  // D-110: a collection is not a file - its size and "added" cells read a dash rather than fabricated
  // values, and no server field was added to BrowseCollection for either.
  it("a collection row's size and added cells both read —", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse({ collections: [makeCollection({ reason: "public" })] }))));
    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    const cells = Array.from(row.querySelectorAll("td")).map((td) => td.textContent);
    expect(cells[2]).toBe("—"); // size
    expect(cells[3]).toBe("—"); // added
  });

  // Defect 6 / AC4: collections and files are distinguishable at a glance by icon, not just by row shape.
  it("a collection row uses a folder icon and a file row uses a file icon", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(makeResponse({ collections: [makeCollection({ reason: "public" })], files: [makeFile({ reason: "public" })] })),
      ),
    );
    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const rows = container.querySelectorAll("[data-row-id]");
    expect(rows[0]!.querySelector("mosni-icon")?.getAttribute("name")).toBe("folder");
    expect(rows[1]!.querySelector("mosni-icon")?.getAttribute("name")).toBe("file");
  });

  // AC3's "Copy link" item, the one action every viewer gets regardless of ownership (unlike the old
  // always-visible CopyField, this is now the dropdown's first item rather than an inline input).
  it('the "Copy link" menu item writes previewUrl to the clipboard for a row the viewer does not own', async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [makeFile({ reason: "public", previewUrl: "https://files.mosni.dev/f/x.png" })] }))),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "copy");
    expect(writeText).toHaveBeenCalledWith("https://files.mosni.dev/f/x.png");
  });

  // Defect 13: the listing has its own heading, so it no longer reads as an unlabelled continuation of
  // the drop zone above it.
  it("the listing has its own section heading", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse())));
    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    expect(container.querySelector("h2")?.textContent).toBeTruthy();
  });

  // E4.1 Wave C: mounted via pages/Preview.tsx on a collection route (D-107 client half).
  describe("initialCollectionId / initialToken (collection-route mount)", () => {
    it("fetches scope=public for the given collectionId, never mine/all, regardless of who is signed in", async () => {
      (window as unknown as { mosni: unknown }).mosni = {
        user: () => ({ sub: "user:a", roles: ["files:write", "files:delete"] }),
        token: () => "tok",
        onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write", "files:delete"] }),
      };
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(makeResponse()));
      vi.stubGlobal("fetch", fetchSpy);

      act(() => {
        root.render(
          <MemoryRouter>
            <FileBrowser initialCollectionId="coll-x" />
          </MemoryRouter>,
        );
      });
      await flush();

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/browse\?scope=public&collectionId=coll-x/),
        expect.anything(),
      );
    });

    it("appends the supplied token to the browse fetch (D-98's anonymous secret-collection bypass)", async () => {
      (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(makeResponse()));
      vi.stubGlobal("fetch", fetchSpy);

      act(() => {
        root.render(
          <MemoryRouter>
            <FileBrowser initialCollectionId="coll-x" initialToken="secrettoken123" />
          </MemoryRouter>,
        );
      });
      await flush();

      // Anonymous (no Bearer) - same "no headers arg at all" shape the other anonymous tests pin down.
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("token=secrettoken123"), undefined);
    });

    it("renders no scope-switcher tabs and no create-collection form on a collection-route mount", async () => {
      (window as unknown as { mosni: unknown }).mosni = {
        user: () => ({ sub: "user:a", roles: ["files:write"] }),
        token: () => "tok",
        onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse())));

      act(() => {
        root.render(
          <MemoryRouter>
            <FileBrowser initialCollectionId="coll-x" />
          </MemoryRouter>,
        );
      });
      await flush();

      expect(container.querySelector("mosni-tabs")).toBeNull();
      expect(container.querySelector('input[aria-label="New collection name"]')).toBeNull();
    });
  });
});
