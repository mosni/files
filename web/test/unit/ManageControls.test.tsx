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
    thumbUrl: null,
    kind: "image",
    mimeType: "image/png",
    inline: true,
    width: 800,
    height: 600,
    durationSeconds: null,
    textPreview: null,
    uploaderName: null,
    uploaderAvatarUrl: null,
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

  // G2 (E5.1 Wave D, finding 8): rename parity with the collection page's C8 interaction - a pencil
  // trigger (D-111: btn-icon, never a bare <button>), not an always-visible input+button form.
  it("rename starts collapsed behind a pencil icon button, and reveals the shared inline-rename control on click", async () => {
    vi.stubGlobal("fetch", vi.fn());
    act(() => {
      root.render(<ManageControls context={makeContext()} />);
    });

    // Collapsed: name as plain text, no input, no form.
    expect(container.textContent).toContain("photo.png");
    expect(container.querySelector('input[aria-label="File name"]')).toBeNull();
    const renameButton = container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement;
    expect(renameButton).not.toBeNull();
    expect(renameButton.className).toContain("btn-icon");

    act(() => renameButton.click());

    // Expanded: the shared InlineRename control (RenameInput + IconConfirmCancel), not a plain form.
    const input = container.querySelector('input[aria-label="File name"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("photo.png");
    expect(container.querySelector('button[aria-label="Save name"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Cancel rename"]')).not.toBeNull();
  });

  it("cancelling the inline rename collapses back to the pencil trigger with no request issued", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    act(() => {
      root.render(<ManageControls context={makeContext()} />);
    });

    act(() => (container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement).click());
    const input = container.querySelector('input[aria-label="File name"]') as HTMLInputElement;
    act(() => {
      setNativeInputValue(input, "changed.png");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    act(() => (container.querySelector('button[aria-label="Cancel rename"]') as HTMLButtonElement).click());

    expect(container.querySelector('input[aria-label="File name"]')).toBeNull();
    expect(container.textContent).toContain("photo.png"); // the ORIGINAL name, edit discarded
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submitting the inline rename via the confirm icon PATCHes and calls onUpdate", async () => {
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeContext({ name: "renamed.png" })),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const onUpdate = vi.fn();

    act(() => {
      root.render(<ManageControls context={makeContext()} onUpdate={onUpdate} />);
    });

    act(() => (container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement).click());
    const input = container.querySelector('input[aria-label="File name"]') as HTMLInputElement;
    act(() => {
      setNativeInputValue(input, "renamed.png");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      (container.querySelector('button[aria-label="Save name"]') as HTMLButtonElement).click();
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
    // Collapses back on success.
    expect(container.querySelector('input[aria-label="File name"]')).toBeNull();
  });

  it("pressing Enter in the rename input submits, same as the confirm icon", async () => {
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeContext({ name: "renamed.png" })),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const onUpdate = vi.fn();
    const ctx = makeContext();

    act(() => {
      root.render(<ManageControls context={ctx} onUpdate={onUpdate} />);
    });

    act(() => (container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement).click());
    const input = container.querySelector('input[aria-label="File name"]') as HTMLInputElement;
    act(() => {
      setNativeInputValue(input, "renamed.png");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
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

    act(() => (container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement).click());
    const input = container.querySelector('input[aria-label="File name"]') as HTMLInputElement;
    act(() => {
      setNativeInputValue(input, "taken.png");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('button[aria-label="Save name"]') as HTMLButtonElement).click();
      await flush();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("taken.png");
    // Stays open on failure - the edit is not silently discarded.
    expect(container.querySelector('input[aria-label="File name"]')).not.toBeNull();
  });

  it("changes protection: PATCH with the new level and the Bearer, then calls onUpdate", async () => {
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeContext({ protection: "private" })),
    });
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

  // D-128 (E4.1 live-testing findings, Wave F): PICKER-SILENT-400 instance 1 - a rejected protection
  // change now toasts why, in addition to ProtectionControl's own silent revert.
  it("a 400 on a protection change toasts the reason", async () => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token", toast };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ error: "below_parent_protection" }) }),
    );
    const ctx = makeContext({ protection: "unlisted" });

    act(() => {
      root.render(<ManageControls context={ctx} />);
    });

    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      setNativeInputValue(select, "public");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    expect(select.value).toBe("unlisted"); // reverted
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("stricter"), { variant: "error" });
  });

  // Review session 017: the PATCH response carries the whole updated context, and it must be applied
  // wholesale. Patching only the field we sent left CopyLink showing the URL the change had just retired
  // - most visibly on a switch to `secret`, where both links move onto /t/<token>, and on a switch to
  // `private`, where the image needs the freshly signed directUrl to keep rendering.
  it("applies the URLs the server returns, not a locally patched copy of the old ones", async () => {
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
    const serverContext = makeContext({
      protection: "secret",
      previewUrl: "https://files.mosni.dev/t/Ab3xY",
      directUrl: "https://dl.mosni.dev/t/Ab3xY",
    });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(serverContext) });
    vi.stubGlobal("fetch", fetchSpy);
    const onUpdate = vi.fn();

    act(() => {
      root.render(<ManageControls context={makeContext({ protection: "unlisted" })} onUpdate={onUpdate} />);
    });

    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      setNativeInputValue(select, "secret");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        protection: "secret",
        previewUrl: "https://files.mosni.dev/t/Ab3xY",
        directUrl: "https://dl.mosni.dev/t/Ab3xY",
      }),
    );
  });

  it("a 400 on rename explains the name was rejected, rather than reporting a generic failure", async () => {
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "invalid_name" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(<ManageControls context={makeContext()} />);
    });

    act(() => (container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement).click());
    const input = container.querySelector('input[aria-label="File name"]') as HTMLInputElement;
    act(() => {
      setNativeInputValue(input, "a/b.png");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('button[aria-label="Save name"]') as HTMLButtonElement).click();
      await flush();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("slashes");
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
