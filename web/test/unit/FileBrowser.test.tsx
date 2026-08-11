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

// E4.1 Wave E findings (C3): a real MouseEvent so isPlainLeftClick's modifier/button checks have
// something to read - jsdom's synthetic click() doesn't set these unless asked to.
function clickWith(el: Element, init: Partial<MouseEventInit> = {}) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
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
    thumbUrl: null,
    kind: "other" as const,
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
    canUpload: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 404) {
  return { ok, status, json: () => Promise.resolve(body) };
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

  it("signed out: fetches scope=visible with no Bearer and renders collections then files", async () => {
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
      expect.stringContaining("/api/browse?scope=visible"),
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

  // Finding 2 (A1): on a COLLECTION-ROUTE mount `scope` is fixed at "visible" for the component's whole
  // lifetime (see the header comment), so the scope-effect never fires a second time on login the way the
  // root-mounted case's scope switch does - the browse effect itself must refetch once identity changes,
  // or the listing stays the anonymous snapshot after a sign-in with nothing else to trigger a refetch.
  it("logging in after a cold anonymous load refetches the listing with the new identity, with no tab switch (finding 2)", async () => {
    let changeCb: ((user: unknown) => void) | undefined;
    let currentToken: string | null = null;
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => null,
      token: () => currentToken,
      onChange: (cb: (u: unknown) => void) => {
        changeCb = cb;
        cb(null);
      },
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

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenNthCalledWith(1, expect.stringContaining("scope=visible"), undefined);

    // Simulate a login completing after mount: the SDK fires onChange again with a real user, exactly as
    // it does after a real sign-in redirect resolves.
    currentToken = "tok";
    await act(async () => {
      changeCb!({ sub: "user:a", roles: ["files:write"] });
      await flush();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("scope=visible"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) }),
    );
  });

  // D-116/D-121: exactly two tabs for every signed-in viewer including an admin, and the Browse tab
  // issues the SAME scope=visible regardless of role - no client-side isFilesAdmin branch anywhere.
  it.each([
    ["a non-admin", { sub: "user:a", roles: ["files:write"] }],
    ["an admin", { sub: "user:admin", roles: ["files:write", "files:delete"] }],
  ])("exactly two tabs - My files / Browse - render for a signed-in viewer (%s), Browse issues scope=visible", async (_label, claims) => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => claims,
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb(claims),
    };
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(makeResponse()));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const tabs = container.querySelectorAll("mosni-tab");
    expect(tabs).toHaveLength(2);
    expect(Array.from(tabs).map((t) => t.getAttribute("label"))).toEqual(["My files", "Browse"]);
    expect(Array.from(tabs).some((t) => t.getAttribute("label") === "All files")).toBe(false);

    const tabsEl = container.querySelector("mosni-tabs")!;
    await act(async () => {
      tabsEl.dispatchEvent(new CustomEvent("mosni-tab-change", { detail: { index: 1 } }));
      await flush();
    });
    expect(fetchSpy).toHaveBeenLastCalledWith(expect.stringContaining("scope=visible"), expect.anything());
  });

  it("a signed-out visitor gets no tab bar and a scope=visible request", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(makeResponse()));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    expect(container.querySelector("mosni-tabs")).toBeNull();
    expect(fetchSpy).toHaveBeenLastCalledWith(expect.stringContaining("scope=visible"), undefined);
  });

  // C4/D-121: a collection's name is a real <a href>, not a <button> with no href at all.
  it("a collection row renders its name as a real <a href> carrying the pathname of its previewUrl, not a <button>", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(makeResponse({ collections: [makeCollection({ reason: "public", previewUrl: "https://files.mosni.dev/f/Photos" })] })),
      ),
    );

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    const link = Array.from(row.querySelectorAll("a")).find((a) => a.textContent === "Photos") as HTMLAnchorElement;
    expect(link).not.toBeUndefined();
    expect(link.getAttribute("href")).toBe("/f/Photos");
    expect(Array.from(row.querySelectorAll("button")).some((b) => b.textContent === "Photos")).toBe(false);
  });

  it("clicking a collection's name with a plain left click navigates to its previewUrl's pathname (E4.1 Wave C, D-100: no URL construction)", async () => {
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

    const link = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Photos") as HTMLAnchorElement;
    await act(async () => {
      clickWith(link);
      await flush();
    });

    expect(locations.at(-1)).toBe("/f/Photos");
  });

  // C3/D-121: a modified or non-primary click on a collection name must not be swallowed - the browser's
  // own open-in-new-tab/middle-click behaviour is the whole point of it being a real <a href>.
  it("a ctrl-click and a middle-click on a collection name do not navigate() and do not preventDefault(); a plain left click does both", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(makeResponse({ collections: [makeCollection({ reason: "public", previewUrl: "https://files.mosni.dev/f/Photos" })] })),
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

    const link = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Photos") as HTMLAnchorElement;

    const ctrlEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    const ctrlPrevented = !link.dispatchEvent(ctrlEvent);
    await flush();
    expect(ctrlPrevented).toBe(false); // preventDefault() was NOT called
    expect(locations.at(-1)).not.toBe("/f/Photos");

    const middleEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 });
    const middlePrevented = !link.dispatchEvent(middleEvent);
    await flush();
    expect(middlePrevented).toBe(false);
    expect(locations.at(-1)).not.toBe("/f/Photos");

    await act(async () => {
      clickWith(link);
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

  it("owner row (reason=own) gets a Protection menu item and a Delete item; a non-owner row gets neither, and the trigger's accessible name includes the row's name", async () => {
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

    // C7: the row's trigger carries an accessible name that includes the row's own name.
    expect(mineRow.querySelector("mosni-dropdown")?.getAttribute("label")).toBe("Actions for mine.png");
    expect(theirsRow.querySelector("mosni-dropdown")?.getAttribute("label")).toBe("Actions for theirs.png");

    await selectRowAction(mineRow, "protection");
    // Scoped to the protection control's own select - A2/D-8 made MoveModal's destination <select>
    // always-mounted (closed) for every row, so an unscoped query would pass even if this panel never
    // opened at all.
    expect(mineRow.parentElement!.querySelector('select[id^="protection-select-"]')).not.toBeNull();
  });

  it("a files:delete holder (not the owner) sees Delete on someone else's row in Browse, but not Rename or Protection (D-115)", async () => {
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
      root.render(<MemoryRouter><FileBrowser initialScope="visible" /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector('[data-row-id="theirs"]')!;
    const values = Array.from(row.querySelectorAll("mosni-dropdown-item")).map((item) => item.getAttribute("value")!);
    expect(values).toContain("delete");
    expect(values).not.toContain("rename");
    expect(values).not.toContain("protection");
  });

  // C7: every row's icon-only trigger, regardless of glyph, still opens the right menu - verifies the
  // dropdown wiring survived the icon-only switch (mosnicat.js itself, and its rendered glyph, are Wave
  // 0's job and covered there / by the D-79 visual check).
  it("the row action trigger is icon-only, carrying more-vertical as its glyph", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [makeFile({ reason: "public" })] }))));
    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const dropdown = container.querySelector("[data-row-id] mosni-dropdown")!;
    expect(dropdown.getAttribute("icon-only")).toBe("more-vertical");
  });

  // D-118/C10: the permanent form is gone; a small button inserts a client-side-only placeholder row.
  it('"New collection" renders no form until clicked; the placeholder row\'s confirm is disabled while empty; cancel issues no fetch; confirm POSTs and reloads', async () => {
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

    // No form, no placeholder input, until the button is clicked.
    expect(container.querySelector('input[aria-label="New collection name"]')).toBeNull();
    const newCollectionButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("New collection"),
    ) as HTMLButtonElement;
    expect(newCollectionButton).not.toBeUndefined();
    expect(newCollectionButton.disabled).toBe(false);

    act(() => newCollectionButton.click());

    const input = container.querySelector('input[aria-label="New collection name"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const confirmButton = container.querySelector('button[aria-label="Create collection"]') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true); // empty name - disabled

    // Cancel: no fetch at all.
    const cancelButton = container.querySelector('button[aria-label="Cancel new collection"]') as HTMLButtonElement;
    act(() => cancelButton.click());
    expect(container.querySelector('input[aria-label="New collection name"]')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the initial listing - cancel touched nothing

    // Re-open, type a name, confirm becomes enabled, and confirming POSTs + reloads.
    act(() => newCollectionButton.click());
    const input2 = container.querySelector('input[aria-label="New collection name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input2, "New");
      input2.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirmButton2 = container.querySelector('button[aria-label="Create collection"]') as HTMLButtonElement;
    expect(confirmButton2.disabled).toBe(false);

    await act(async () => {
      confirmButton2.click();
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
    expect(fetchSpy).toHaveBeenCalledTimes(3); // + the reload
    expect(container.querySelector('input[aria-label="New collection name"]')).toBeNull(); // row closed
  });

  it("the New collection button is disabled while a placeholder row is already open", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: ["files:write"] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse())));

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const newCollectionButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("New collection"),
    ) as HTMLButtonElement;
    act(() => newCollectionButton.click());
    expect(newCollectionButton.disabled).toBe(true);
  });

  it("Escape on the placeholder row's name field cancels it without issuing a fetch", async () => {
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

    const newCollectionButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("New collection"),
    ) as HTMLButtonElement;
    act(() => newCollectionButton.click());

    const input = container.querySelector('input[aria-label="New collection name"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('input[aria-label="New collection name"]')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the initial listing
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

    // Tab order is "My files" (0), "Browse" (1) - exactly two tabs now (D-116).
    const tabs = container.querySelector("mosni-tabs")!;
    await act(async () => {
      tabs.dispatchEvent(new CustomEvent("mosni-tab-change", { detail: { index: 1, label: "Browse" } }));
      await flush();
    });

    expect(fetchSpy).toHaveBeenLastCalledWith(expect.stringContaining("scope=visible"), expect.anything());
  });

  // C8: rename swaps the NAME CELL to an input, in place - no extra <tr>, and the actions cell swaps to
  // confirm/cancel icon buttons.
  it("rename: swaps the name cell to an input with no extra <tr>, submits the new name on confirm, and reloads", async () => {
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

    const table = container.querySelector("table")!;
    const rowCountBefore = table.querySelectorAll("tbody > tr").length;

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "rename");

    expect(table.querySelectorAll("tbody > tr").length).toBe(rowCountBefore); // no extra <tr>
    const input = container.querySelector('input[aria-label="New name"]') as HTMLInputElement;
    expect(row.contains(input)).toBe(true); // the input lives INSIDE the same row

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "renamed.png");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = row.querySelector('button[aria-label="Save name"]') as HTMLButtonElement;
    await act(async () => {
      saveButton.click();
      await flush();
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/api/files/file0000000000id",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "renamed.png" }) }),
    );
    expect(container.querySelector('input[aria-label="New name"]')).toBeNull(); // closed after save
  });

  it("rename: Enter submits from the keyboard, without clicking Save", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => ({ sub: "user:a" }), token: () => "tok", onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a" }) };
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

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await flush();
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/api/files/file0000000000id",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "renamed.png" }) }),
    );
  });

  it("rename: Escape cancels without issuing a PATCH, and closes the input", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => ({ sub: "user:a" }), token: () => "tok", onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a" }) };
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "rename");
    const input = container.querySelector('input[aria-label="New name"]') as HTMLInputElement;

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });

    expect(container.querySelector('input[aria-label="New name"]')).toBeNull();
    expect(fetchSpy.mock.calls.filter((c) => c[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("rename: the Cancel icon button also closes the field without issuing a PATCH", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => ({ sub: "user:a" }), token: () => "tok", onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a" }) };
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "rename");
    const cancelButton = row.querySelector('button[aria-label="Cancel rename"]') as HTMLButtonElement;
    act(() => cancelButton.click());

    expect(container.querySelector('input[aria-label="New name"]')).toBeNull();
    expect(fetchSpy.mock.calls.filter((c) => c[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("rename: a collection row submits to its own PATCH endpoint, closes, and reloads - no extra <tr>", async () => {
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

    const table = container.querySelector("table")!;
    const rowCountBefore = table.querySelectorAll("tbody > tr").length;
    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "rename");
    expect(table.querySelectorAll("tbody > tr").length).toBe(rowCountBefore);

    const input = container.querySelector('input[aria-label="New name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "Renamed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const saveButton = row.querySelector('button[aria-label="Save name"]') as HTMLButtonElement;
    await act(async () => {
      saveButton.click();
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

  // C2/C3/D-121: every breadcrumb crumb - Home, every ancestor, AND the current location - is a real
  // <a href>. A ctrl-click / middle-click on any of them must not navigate() or preventDefault(); a plain
  // left click does both.
  it("breadcrumb: every crumb including the current location is an <a> with a non-empty href", async () => {
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
          <FileBrowser initialCollectionId="child-id" />
          <LocationSpy onLocation={(p) => locations.push(p)} />
        </MemoryRouter>,
      );
    });
    await flush();

    const nav = container.querySelector('nav[aria-label="Breadcrumb"]')!;
    const home = Array.from(nav.querySelectorAll("a")).find((a) => a.textContent === "Home") as HTMLAnchorElement;
    const rootLink = Array.from(nav.querySelectorAll("a")).find((a) => a.textContent === "Root") as HTMLAnchorElement;
    const childLink = Array.from(nav.querySelectorAll("a")).find((a) => a.textContent === "Child") as HTMLAnchorElement;

    for (const link of [home, rootLink, childLink]) {
      expect(link).not.toBeUndefined();
      expect(link.getAttribute("href")).toBeTruthy();
    }
    expect(home.getAttribute("href")).toBe("/");
    expect(rootLink.getAttribute("href")).toBe("/f/Root");
    expect(childLink.getAttribute("href")).toBe("/f/Root/Child");
    expect(childLink.getAttribute("aria-current")).toBe("location");
    // no non-anchor control anywhere in the breadcrumb (the old plain-text current crumb is gone, AC9 struck)
    expect(nav.querySelectorAll("button, span[role]").length).toBe(0);

    await act(async () => {
      clickWith(rootLink);
      await flush();
    });
    expect(locations.at(-1)).toBe("/f/Root");

    await act(async () => {
      clickWith(childLink);
      await flush();
    });
    expect(locations.at(-1)).toBe("/f/Root/Child");

    await act(async () => {
      clickWith(home);
      await flush();
    });
    expect(locations.at(-1)).toBe("/");
  });

  it("breadcrumb: a ctrl-click and a middle-click on a crumb do not navigate() and do not preventDefault(); a plain left click does both", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          makeResponse({
            breadcrumb: [{ id: "root-id", name: "Root", previewUrl: "https://files.mosni.dev/f/Root" }],
          }),
        ),
      ),
    );

    const locations: string[] = [];
    act(() => {
      root.render(
        <MemoryRouter>
          <FileBrowser initialCollectionId="root-id" />
          <LocationSpy onLocation={(p) => locations.push(p)} />
        </MemoryRouter>,
      );
    });
    await flush();

    const rootLink = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Root") as HTMLAnchorElement;

    const ctrlEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    const ctrlPrevented = !rootLink.dispatchEvent(ctrlEvent);
    expect(ctrlPrevented).toBe(false);

    const middleEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 });
    const middlePrevented = !rootLink.dispatchEvent(middleEvent);
    expect(middlePrevented).toBe(false);

    await act(async () => {
      clickWith(rootLink);
      await flush();
    });
    expect(locations.at(-1)).toBe("/f/Root");
  });

  it("breadcrumb: at root, Home is still an <a href='/'> carrying aria-current=location", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse())));

    act(() => {
      root.render(
        <MemoryRouter>
          <FileBrowser initialScope="visible" />
        </MemoryRouter>,
      );
    });
    await flush();

    const home = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Home") as HTMLAnchorElement;
    expect(home).not.toBeUndefined();
    expect(home.getAttribute("href")).toBe("/");
    expect(home.getAttribute("aria-current")).toBe("location");
  });

  it("a failed protection PATCH on a file row does not reload the listing, and toasts why (D-128)", async () => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a" }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a" }),
      toast,
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })))
      .mockResolvedValueOnce(jsonResponse({ error: "below_parent_protection" }, false, 400));
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "protection");

    // Scoped to the protection control's own select, not just "the" select in the document - A2/D-8
    // made MoveModal's destination <select> always-mounted (closed) alongside every row too.
    const select = container.querySelector('select[id^="protection-select-"]') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(select, "public");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2); // the initial listing + the failed PATCH - no reload fetch followed
    expect(select.value).toBe("unlisted"); // reverted
    // D-128 (E4.1 live-testing findings, Wave F): PICKER-SILENT-400 instance 2 - the reason is stated,
    // not just a silent revert. Names the parent collection's relationship, not just "failed".
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("stricter"), { variant: "error" });
  });

  // C5: the protection control renders inside a .field wrapper (mosni-chrome's input chrome), independent
  // of any .panel ancestor - Wave B moved this into a bare <td>, where it used to render unstyled.
  it("the protection control renders inside a .field wrapper", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => ({ sub: "user:a" }), token: () => "tok", onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a" }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] }))));

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "protection");

    // Scoped for the same reason as the test above (A2/D-8: MoveModal's select is always mounted now).
    const select = container.querySelector('select[id^="protection-select-"]') as HTMLSelectElement;
    expect(select.closest(".field")).not.toBeNull();
  });

  // C5: the rename input renders inside a .field wrapper too.
  it("the rename input renders inside a .field wrapper", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => ({ sub: "user:a" }), token: () => "tok", onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a" }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] }))));

    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const row = container.querySelector("[data-row-id]")!;
    await selectRowAction(row, "rename");

    const input = container.querySelector('input[aria-label="New name"]') as HTMLInputElement;
    expect(input.closest(".field")).not.toBeNull();
  });

  it("Browse (scope=visible) shows no collection-create button, even for a signed-in admin", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: ["files:write", "files:delete"] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write", "files:delete"] }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse())));

    act(() => {
      root.render(<MemoryRouter><FileBrowser initialScope="visible" /></MemoryRouter>);
    });
    await flush();

    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("New collection"))).toBe(false);
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

  // D-137/AC9: a row with a thumbnail renders it instead of the generic file icon; a row with none keeps
  // the icon. The server already gated thumbUrl identically to the file itself (delivery.test.ts), so the
  // client has nothing left to decide beyond "render what I was given, or not".
  it("a file row with a thumbnail renders it instead of the file icon; one with none keeps the icon", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          makeResponse({
            files: [
              makeFile({ id: "with-thumb", reason: "public", thumbUrl: "https://dl.mosni.dev/thumb/photo.png" }),
              makeFile({ id: "no-thumb", name: "notes.txt", reason: "public", thumbUrl: null }),
            ],
          }),
        ),
      ),
    );
    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    const withThumbRow = container.querySelector('[data-row-id="with-thumb"]')!;
    const iconCell = withThumbRow.querySelector("td:first-child")!;
    const img = iconCell.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://dl.mosni.dev/thumb/photo.png");
    expect(iconCell.querySelector("mosni-icon")).toBeNull();

    const noThumbRow = container.querySelector('[data-row-id="no-thumb"]')!;
    const noThumbIconCell = noThumbRow.querySelector("td:first-child")!;
    expect(noThumbIconCell.querySelector("img")).toBeNull();
    expect(noThumbIconCell.querySelector("mosni-icon")?.getAttribute("name")).toBe("file");
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

  // D-117: the heading is removed entirely, not moved (strikes E4.1's Wave B5).
  it("no <h2>Files and collections</h2> is rendered anywhere", async () => {
    (window as unknown as { mosni: unknown }).mosni = { user: () => null, token: () => null, onChange: (cb: (u: unknown) => void) => cb(null) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse())));
    act(() => {
      root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
    });
    await flush();

    expect(container.querySelector("h2")).toBeNull();
  });

  // E4.1 Wave C: mounted via pages/Preview.tsx on a collection route (D-107 client half).
  describe("initialCollectionId / initialToken (collection-route mount)", () => {
    it("fetches scope=visible for the given collectionId, never mine, regardless of who is signed in", async () => {
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
        expect.stringMatching(/^\/api\/browse\?scope=visible&collectionId=coll-x/),
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

    it("renders no scope-switcher tabs, and no create-collection button when the server says canUpload is false", async () => {
      (window as unknown as { mosni: unknown }).mosni = {
        user: () => ({ sub: "user:a", roles: ["files:write"] }),
        token: () => "tok",
        onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse({ canUpload: false }))));

      act(() => {
        root.render(
          <MemoryRouter>
            <FileBrowser initialCollectionId="coll-x" />
          </MemoryRouter>,
        );
      });
      await flush();

      expect(container.querySelector("mosni-tabs")).toBeNull();
      expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("New collection"))).toBe(false);
    });

    // Finding 9 (A3): line 704 forces scope="visible" for every collection route, so the OLD
    // `scope === "mine"` gate could never hold there and the button never rendered inside a collection at
    // all - even for the collection's own owner. The server already computes canUpload for that specific
    // collection (Wave C4/G2); a collection route must gate on THAT instead of the tab scope.
    it('"New collection" renders inside a collection the viewer may upload to (finding 9)', async () => {
      (window as unknown as { mosni: unknown }).mosni = {
        user: () => ({ sub: "user:a", roles: ["files:write"] }),
        token: () => "tok",
        onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse({ canUpload: true }))));

      act(() => {
        root.render(
          <MemoryRouter>
            <FileBrowser initialCollectionId="coll-x" />
          </MemoryRouter>,
        );
      });
      await flush();

      expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("New collection"))).toBe(true);
    });

    it('a nested collection created from inside a collection is created under that parent (finding 9, AC-A4)', async () => {
      (window as unknown as { mosni: unknown }).mosni = {
        user: () => ({ sub: "user:a", roles: ["files:write"] }),
        token: () => "tok",
        onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
      };
      // canUpload: true also renders the compact upload box (G2), which independently fetches
      // /api/config (D-10) - a URL-keyed mock is used rather than positional Once-chaining so this test
      // does not depend on exactly when that unrelated call happens to interleave.
      const fetchSpy = vi.fn().mockImplementation((url: string) => {
        if (url === "/api/collections") return Promise.resolve(jsonResponse({ id: "newcoll", name: "New", parentId: "coll-x" }, true));
        return Promise.resolve(jsonResponse(makeResponse({ canUpload: true })));
      });
      vi.stubGlobal("fetch", fetchSpy);

      act(() => {
        root.render(
          <MemoryRouter>
            <FileBrowser initialCollectionId="coll-x" />
          </MemoryRouter>,
        );
      });
      await flush();

      const newCollectionButton = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("New collection"),
      ) as HTMLButtonElement;
      act(() => newCollectionButton.click());

      const input = container.querySelector('input[aria-label="New collection name"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(input, "New");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const confirmButton = container.querySelector('button[aria-label="Create collection"]') as HTMLButtonElement;
      await act(async () => {
        confirmButton.click();
        await flush();
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/collections",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "New", parentId: "coll-x" }),
        }),
      );
    });
  });

  // G3/G4 (E4.1 live-testing findings, Wave G, finding 12): move in the row overflow menu.
  describe("Move (G3)", () => {
    function installMosni() {
      (window as unknown as { mosni: unknown }).mosni = {
        user: () => ({ sub: "user:a", roles: ["files:write"] }),
        token: () => "tok",
        onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
        toast: vi.fn(),
      };
    }

    it("the Move item appears only for a manageable row", async () => {
      installMosni();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse(
            makeResponse({
              files: [makeFile({ id: "mine", reason: "own" }), makeFile({ id: "theirs", reason: "public" })],
            }),
          ),
        ),
      );

      act(() => {
        root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
      });
      await flush();

      const rows = container.querySelectorAll("[data-row-id]");
      const ownRow = Array.from(rows).find((r) => r.getAttribute("data-row-id") === "mine")!;
      const strangerRow = Array.from(rows).find((r) => r.getAttribute("data-row-id") === "theirs")!;
      expect(ownRow.querySelector('mosni-dropdown-item[value="move"]')).not.toBeNull();
      expect(strangerRow.querySelector('mosni-dropdown-item[value="move"]')).toBeNull();
    });

    // Finding 11 / D-8: MoveModal used to render NO children while closed and only add them once `open`
    // flips true - the same class of bug as mosni-code wiping JSX children and the mosni-tab crash. The
    // fix renders the modal's children unconditionally and toggles only the `open` attribute, exactly as
    // the Delete modal beside it already does.
    it("the Move modal's destination select is a DOM descendant of the mosni-modal element (finding 11, D-8)", async () => {
      installMosni();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })))
          .mockResolvedValueOnce(jsonResponse([{ id: "dest-1", name: "Vacation" }])),
      );

      act(() => {
        root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
      });
      await flush();

      const row = container.querySelector("[data-row-id]")!;
      await selectRowAction(row, "move");
      await flush();

      const modal = container.querySelector('mosni-modal[heading^="Move"]');
      expect(modal).not.toBeNull();
      const select = container.querySelector("select");
      expect(select).not.toBeNull();
      // Not merely "select is somewhere in the document" - it must be a real descendant of the modal
      // element itself, or it has landed in the table cell instead (the bug's actual production symptom).
      expect(modal!.contains(select)).toBe(true);
    });

    // E5.1 Wave H (H7, working-conventions.md §8): a mount-only assertion cannot catch a teardown that only
    // shows up on the NEXT render - D-8, D-112 and D-164 are all this shape. Forces one unrelated re-render
    // (root.render() of an equivalent tree, the createRoot equivalent of `rerender(<Same />)`) while the
    // modal is open, and re-asserts containment rather than trusting the mount-time assertion above.
    it("the Move modal's destination select stays inside mosni-modal after an unrelated re-render (H7)", async () => {
      installMosni();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })))
          .mockResolvedValueOnce(jsonResponse([{ id: "dest-1", name: "Vacation" }])),
      );

      act(() => {
        root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
      });
      await flush();

      const row = container.querySelector("[data-row-id]")!;
      await selectRowAction(row, "move");
      await flush();

      expect(container.querySelector('mosni-modal[heading^="Move"]')!.contains(container.querySelector("select"))).toBe(true);

      // The unrelated re-render: same element tree, same props from this test's own point of view -
      // exactly what a parent-driven refetch/reload elsewhere on the page would trigger while this modal
      // stays open.
      act(() => {
        root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
      });
      await flush();

      const modal = container.querySelector('mosni-modal[heading^="Move"]');
      const select = container.querySelector("select");
      expect(modal).not.toBeNull();
      expect(select).not.toBeNull();
      expect(modal!.contains(select)).toBe(true);
    });

    it("the picker lists Root plus the caller's collections; confirming PATCHes collectionId and reloads", async () => {
      installMosni();
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })))
        .mockResolvedValueOnce(jsonResponse([{ id: "dest-1", name: "Vacation" }]))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })));
      vi.stubGlobal("fetch", fetchSpy);

      act(() => {
        root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
      });
      await flush();

      const row = container.querySelector("[data-row-id]")!;
      await selectRowAction(row, "move");
      await flush();

      const select = container.querySelector("select") as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => ({ value: o.value, text: o.textContent }))).toEqual([
        { value: "", text: "Root" },
        { value: "dest-1", text: "Vacation" },
      ]);

      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(select, "dest-1");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const confirmButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Move")!;
      await act(async () => {
        confirmButton.click();
        await flush();
      });

      expect(fetchSpy).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining("/api/files/"),
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ collectionId: "dest-1" }) }),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(4); // initial listing + collections + PATCH + reload
    });

    it("a 400 on move toasts the reason and leaves the row in place", async () => {
      installMosni();
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(makeResponse({ files: [makeFile({ reason: "own" })] })))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse({ error: "below_parent_protection" }, false, 400));
      vi.stubGlobal("fetch", fetchSpy);

      act(() => {
        root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
      });
      await flush();

      const row = container.querySelector("[data-row-id]")!;
      await selectRowAction(row, "move");
      await flush();

      const confirmButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Move")!;
      await act(async () => {
        confirmButton.click();
        await flush();
      });

      expect(fetchSpy).toHaveBeenCalledTimes(3); // no reload fetch followed the failed PATCH
      const mosni = (window as unknown as { mosni: { toast: ReturnType<typeof vi.fn> } }).mosni;
      expect(mosni.toast).toHaveBeenCalledWith(expect.stringContaining("stricter"), { variant: "error" });
    });
  });

  // G2/G4: the compact collection-page upload box - server-decided (`canUpload`), never inferred from
  // the user object.
  describe("compact collection-page upload box (G2)", () => {
    it("renders only on a collection route, and only when the server says canUpload is true", async () => {
      (window as unknown as { mosni: unknown }).mosni = {
        user: () => ({ sub: "user:a", roles: ["files:write"] }),
        token: () => "tok",
        onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse({ canUpload: true }))));

      act(() => {
        root.render(
          <MemoryRouter>
            <FileBrowser initialCollectionId="coll-x" />
          </MemoryRouter>,
        );
      });
      await flush();

      expect(container.textContent).toContain("Drop files here");
    });

    it("does not render when canUpload is false, even on a collection route", async () => {
      (window as unknown as { mosni: unknown }).mosni = {
        user: () => ({ sub: "user:a", roles: [] }),
        token: () => "tok",
        onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: [] }),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse({ canUpload: false }))));

      act(() => {
        root.render(
          <MemoryRouter>
            <FileBrowser initialCollectionId="coll-x" />
          </MemoryRouter>,
        );
      });
      await flush();

      expect(container.textContent).not.toContain("Drop files here");
    });

    it("never renders on the root-mounted browser, even if canUpload were somehow true", async () => {
      (window as unknown as { mosni: unknown }).mosni = {
        user: () => ({ sub: "user:a", roles: ["files:write"] }),
        token: () => "tok",
        onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse({ canUpload: true }))));

      act(() => {
        root.render(<MemoryRouter><FileBrowser /></MemoryRouter>);
      });
      await flush();

      expect(container.textContent).not.toContain("Drop files here");
    });
  });
});
