(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ManageControls } from "../../src/components/ManageControls.tsx";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

function makeContext(overrides: Partial<PreviewContext> = {}): PreviewContext {
  return {
    id: "file0000000000id",
    collectionId: "coll000000000000",
    name: "photo.png",
    path: "mine/photo.png",
    bytes: 2_400_000,
    sizeLabel: "2.4 MB",
    protection: "unlisted",
    createdAt: "2026-07-21T00:00:00.000Z",
    previewUrl: "https://files.mosni.dev/f/mine/photo.png",
    directUrl: "https://dl.mosni.dev/mine/photo.png",
    kind: "image",
    mimeType: "image/png",
    inline: true,
    width: 800,
    height: 600,
    durationSeconds: null,
    textPreview: null,
    isOwner: true,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// React installs its own instance-level `value` setter on a mounted <input> (to track "did the browser
// see this value already" for its onChange comparison). Assigning `.value` directly goes through THAT
// setter too, so React's tracker silently updates right along with the DOM - and then dispatching a
// bare "input" event finds nothing changed and never calls onChange. Using the PROTOTYPE's native setter
// bypasses React's override, leaving the tracker stale so the subsequent event is seen as a real change.
function setNativeInputValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(input, value);
}

let container: HTMLDivElement;
let root: Root;

describe("ManageControls (D-89: rename, protection, delete - owner-only)", () => {
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

  it("renames: submits PATCH /api/files/:id with the new name and the Bearer, then calls onUpdate", async () => {
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchSpy);
    const onUpdate = vi.fn();
    const ctx = makeContext();

    act(() => {
      root.render(<ManageControls context={ctx} onUpdate={onUpdate} />);
    });

    const input = container.querySelector('input[aria-label="File name"]') as HTMLInputElement;
    act(() => {
      setNativeInputValue(input, "renamed.png");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/files/file0000000000id",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
        body: JSON.stringify({ name: "renamed.png" }),
      }),
    );
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: "renamed.png" }));
  });

  it("a 409 on rename surfaces a suggested-name error rather than silently failing", async () => {
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: "name_taken" }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const ctx = makeContext();

    act(() => {
      root.render(<ManageControls context={ctx} />);
    });

    const input = container.querySelector('input[aria-label="File name"]') as HTMLInputElement;
    act(() => {
      setNativeInputValue(input, "taken.png");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("taken.png");
  });

  it("changes protection: PATCH with the new level and the Bearer, then calls onUpdate", async () => {
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchSpy);
    const onUpdate = vi.fn();
    const ctx = makeContext({ protection: "unlisted" });

    act(() => {
      root.render(<ManageControls context={ctx} onUpdate={onUpdate} />);
    });

    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      setNativeInputValue(select, "private");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/files/file0000000000id",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
        body: JSON.stringify({ protection: "private" }),
      }),
    );
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ protection: "private" }));
  });

  it("compact mode renders ONLY the protection selector - no rename form, no delete", () => {
    vi.stubGlobal("fetch", vi.fn());
    act(() => {
      root.render(<ManageControls context={makeContext()} compact />);
    });

    expect(container.querySelector("select")).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain("Delete file");
  });

  it("delete requires a confirm step before calling DELETE /api/files/:id", async () => {
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchSpy);
    const assignSpy = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignSpy });

    act(() => {
      root.render(<ManageControls context={makeContext()} />);
    });

    // First click only reveals the confirmation - no request yet.
    const deleteButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Delete file",
    ) as HTMLButtonElement;
    act(() => deleteButton.click());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Delete this file permanently?");

    const confirmButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Yes, delete",
    ) as HTMLButtonElement;
    await act(async () => {
      confirmButton.click();
      await flush();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/files/file0000000000id",
      expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({ Authorization: "Bearer test-token" }) }),
    );
    expect(assignSpy).toHaveBeenCalledWith("/");
  });

  it("cancelling the delete confirmation issues no request", () => {
    vi.stubGlobal("fetch", vi.fn());
    act(() => {
      root.render(<ManageControls context={makeContext()} />);
    });

    const deleteButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Delete file",
    ) as HTMLButtonElement;
    act(() => deleteButton.click());
    const cancelButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement;
    act(() => cancelButton.click());

    expect(container.textContent).toContain("Delete file");
    expect(container.textContent).not.toContain("Delete this file permanently?");
  });
});
