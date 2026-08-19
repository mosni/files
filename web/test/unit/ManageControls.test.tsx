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
    directUrlExpiresAt: null,
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
    canManage: true,
    canDelete: true,
    ancestors: [],
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

describe("ManageControls (D-89: protection - owner-only)", () => {
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

  // E5.1 live-testing round 2: rename moved out of this component entirely, into PreviewCard.tsx's own
  // header - see web/test/unit/Preview.test.tsx's "rename (header)" block for that coverage now.

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

  // E5.1 live-testing round 2 ("move trash next to pencil"): delete moved out of this component
  // entirely too, into PreviewCard.tsx's own header next to rename - see Preview.test.tsx's "delete
  // (header)" block for that coverage now. This component renders only the protection selector.
  it("renders only the protection selector, nothing else", () => {
    vi.stubGlobal("fetch", vi.fn());
    act(() => {
      root.render(<ManageControls context={makeContext()} />);
    });

    expect(container.querySelector("select")).not.toBeNull();
    expect(container.querySelector('button[aria-label="Delete file"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Rename"]')).toBeNull();
  });
});
