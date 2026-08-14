(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../src/lib/share.ts", () => ({
  fetchShareState: vi.fn(),
  fetchAccounts: vi.fn(),
  grantShare: vi.fn(),
  revokeShare: vi.fn(),
  createInvite: vi.fn(),
}));

import { ShareDialog } from "../../src/components/ShareDialog.tsx";
import { createInvite, fetchAccounts, fetchShareState, grantShare, revokeShare } from "../../src/lib/share.ts";
import type { DirectoryAccount, InviteMinted, ShareState } from "../../../app/src/lib/shareContext.ts";

const fetchShareStateMock = vi.mocked(fetchShareState);
const fetchAccountsMock = vi.mocked(fetchAccounts);
const grantShareMock = vi.mocked(grantShare);
const revokeShareMock = vi.mocked(revokeShare);
const createInviteMock = vi.mocked(createInvite);

// A fresh Response per call, always - Response.json() can only be consumed once, and several flows here
// (open -> load, grant -> refreshed state, invite -> refreshState) call the SAME mocked function more than
// once in one test.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const SHAREABLE_STATE: ShareState = {
  type: "file",
  id: "f1",
  name: "photo.jpg",
  effectiveProtection: "private",
  grants: [],
};

const ACCOUNTS: DirectoryAccount[] = [
  { sub: "google:alice", name: "Alice", picture: "https://auth.mosni.dev/avatar/google:alice" },
  { sub: "google:bob", name: "Bob", picture: "https://auth.mosni.dev/avatar/google:bob" },
];

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ShareDialog (E7/D-185)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchShareStateMock.mockReset().mockImplementation(async () => jsonResponse(SHAREABLE_STATE));
    fetchAccountsMock.mockReset().mockImplementation(async () => jsonResponse(ACCOUNTS));
    grantShareMock.mockReset().mockImplementation(async () => jsonResponse(SHAREABLE_STATE));
    revokeShareMock.mockReset().mockImplementation(async () => jsonResponse(SHAREABLE_STATE));
    createInviteMock
      .mockReset()
      .mockImplementation(async () => jsonResponse({ url: "https://auth.mosni.dev/i/default", expiresAt: "x", sub: "link:x" }, 201));
    (window as unknown as { mosni: unknown }).mosni = {
      token: () => "test-token",
      onChange: (cb: (user: { sub: string } | null) => void) => cb({ sub: "google:viewer" }),
      toast: vi.fn(),
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { mosni?: unknown }).mosni;
  });

  it("children are present in the tree even while closed (D-8 class - always mounted, only `open` toggles)", () => {
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open={false} onClose={vi.fn()} />);
    });
    const modal = container.querySelector("mosni-modal");
    expect(modal).not.toBeNull();
    // The footer Close button is real content projected into the modal's own DOM subtree, present
    // regardless of `open` - the D-8 containment check, not an attribute-string comparison.
    const closeButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Close");
    expect(closeButton).not.toBeUndefined();
    expect(modal!.contains(closeButton!)).toBe(true);
  });

  // E7-QA1 D-195: the refusal state is GONE - a non-private object gets an informational note instead,
  // and the picker is never hidden (§0.4.2's accepted consequence).
  it("a non-private file shows an informational note AND still renders the picker (D-195/§B1.6)", async () => {
    fetchShareStateMock.mockImplementation(async () => jsonResponse({ ...SHAREABLE_STATE, effectiveProtection: "unlisted" }));
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    expect(container.textContent).toContain("unlisted");
    expect(container.textContent).toContain("anyone with the link can already open it");
    expect(container.textContent).toContain("adds nothing"); // file wording: no upload half to mention
    expect(container.querySelector("#share-picker-filter-f1")).not.toBeNull();
    expect(fetchAccountsMock).toHaveBeenCalled();
  });

  it("a non-private COLLECTION's note mentions upload rights, not 'adds nothing' (it has an upload half)", async () => {
    fetchShareStateMock.mockImplementation(async () =>
      jsonResponse({ ...SHAREABLE_STATE, type: "collection", id: "c1", effectiveProtection: "public" }),
    );
    act(() => {
      root.render(<ShareDialog type="collection" id="c1" objectLabel="Vacation" open onClose={vi.fn()} />);
    });
    await flush();
    expect(container.textContent).toContain("public");
    expect(container.textContent).toContain("only controls who can upload");
  });

  it("a PRIVATE object shows no informational note", async () => {
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    expect(container.textContent).not.toContain("anyone with the link can already open it");
  });

  it("grant avatars render from auth.mosni.dev/avatar/<sub>, not a raw picture URL (F3)", async () => {
    fetchShareStateMock.mockImplementation(async () =>
      jsonResponse({ ...SHAREABLE_STATE, grants: [{ sub: "google:bob", name: "Bob", picture: "https://lh3.googleusercontent.com/evil", canUpload: false }] }),
    );
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    const img = container.querySelector("li img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe("https://auth.mosni.dev/avatar/google%3Abob");
    expect(img.src).not.toContain("googleusercontent");
  });

  it("a grant avatar that fails to load degrades to a placeholder, not a broken-image icon", async () => {
    fetchShareStateMock.mockImplementation(async () =>
      jsonResponse({ ...SHAREABLE_STATE, grants: [{ sub: "google:bob", name: "Bob", picture: null, canUpload: false }] }),
    );
    fetchAccountsMock.mockImplementation(async () => jsonResponse([])); // no candidates - isolates Bob's avatar
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    const img = container.querySelector('img[src*="google%3Abob"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    await act(async () => {
      img.dispatchEvent(new Event("error"));
      await flush();
    });
    expect(container.querySelector('img[src*="google%3Abob"]')).toBeNull();
    expect(container.textContent).toContain("B"); // the placeholder's initial
  });

  it("shareable: true shows the picker and excludes the caller's own sub and already-granted subs", async () => {
    fetchShareStateMock.mockImplementation(async () =>
      jsonResponse({ ...SHAREABLE_STATE, grants: [{ sub: "google:bob", name: "Bob", picture: null, canUpload: false }] }),
    );
    fetchAccountsMock.mockImplementation(async () =>
      jsonResponse([...ACCOUNTS, { sub: "google:viewer", name: "Me", picture: "https://x/avatar" }]),
    );
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Alice"); // candidate, not excluded
    expect(text).not.toContain("Me"); // the caller's own sub is excluded
    // Bob is already granted, so he must not appear a second time in the picker's candidate list -
    // only once, in the current-access list.
    expect(text.match(/Bob/g)?.length).toBe(1);
  });

  it("the picker filters by typed text", async () => {
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).toContain("Bob");

    const input = container.querySelector("#share-picker-filter-f1") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "ali");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).not.toContain("Bob");
  });

  it("grant/remove round trip against the stubbed API", async () => {
    grantShareMock.mockImplementation(async () =>
      jsonResponse({ ...SHAREABLE_STATE, grants: [{ sub: "google:alice", name: "Alice", picture: null, canUpload: false }] }),
    );
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();

    const addButtons = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent === "Add");
    await act(async () => {
      addButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect(grantShareMock).toHaveBeenCalledWith("file", "f1", "google:alice", undefined);
    expect(container.textContent).toContain("Alice");

    revokeShareMock.mockImplementation(async () => jsonResponse({ ...SHAREABLE_STATE, grants: [] }));
    const removeButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Remove")!;
    await act(async () => {
      removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect(revokeShareMock).toHaveBeenCalledWith("file", "f1", "google:alice");
  });

  it("collection grants pass the canUpload checkbox state", async () => {
    fetchShareStateMock.mockImplementation(async () => jsonResponse({ ...SHAREABLE_STATE, type: "collection", id: "c1" }));
    grantShareMock.mockImplementation(async () => jsonResponse({ ...SHAREABLE_STATE, type: "collection", id: "c1" }));
    act(() => {
      root.render(<ShareDialog type="collection" id="c1" objectLabel="Vacation" open onClose={vi.fn()} />);
    });
    await flush();

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      checkbox.click();
      await flush();
    });

    const addButtons = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent === "Add");
    await act(async () => {
      addButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect(grantShareMock).toHaveBeenCalledWith("collection", "c1", "google:alice", true);
  });

  it("a file grant never sends canUpload (file_acl has no such column)", async () => {
    grantShareMock.mockImplementation(async () => jsonResponse(SHAREABLE_STATE));
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    const addButtons = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent === "Add");
    await act(async () => {
      addButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect(grantShareMock).toHaveBeenCalledWith("file", "f1", "google:alice", undefined);
  });

  // F13/D-198: the upgradeable switch defaults on and its choice reaches the server.
  it("the upgradeable switch defaults ON and sends allowRegister: true", async () => {
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    const switchInput = Array.from(container.querySelectorAll('input[type="checkbox"]')).find((el) =>
      el.parentElement?.textContent?.includes("turn this into their own account"),
    ) as HTMLInputElement;
    expect(switchInput.checked).toBe(true);
    expect(container.textContent).not.toContain("Everyone who opens this link shares one identity");

    const inviteButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Invite someone without an account"),
    )!;
    await act(async () => {
      inviteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect(createInviteMock).toHaveBeenCalledWith("file", "f1", undefined, true);
  });

  it("turning the switch off shows D-23's consequence line and sends allowRegister: false", async () => {
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    const switchInput = Array.from(container.querySelectorAll('input[type="checkbox"]')).find((el) =>
      el.parentElement?.textContent?.includes("turn this into their own account"),
    ) as HTMLInputElement;
    await act(async () => {
      switchInput.click();
      await flush();
    });
    expect(container.textContent).toContain("Everyone who opens this link shares one identity");
    expect(container.textContent).toContain("The link dies after at most 24 hours");

    const inviteButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Invite someone without an account"),
    )!;
    await act(async () => {
      inviteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect(createInviteMock).toHaveBeenCalledWith("file", "f1", undefined, false);
  });

  it("the invite URL renders once with the consequence line", async () => {
    const minted: InviteMinted = { url: "https://auth.mosni.dev/i/secretTok", expiresAt: "2026-08-13T00:00:00.000Z", sub: "link:abc" };
    createInviteMock.mockImplementation(async () => jsonResponse(minted, 201));
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();

    const inviteButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Invite someone without an account"),
    )!;
    await act(async () => {
      inviteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });

    const urlInput = container.querySelector(".copy-field-primary input") as HTMLInputElement;
    expect(urlInput.value).toBe("https://auth.mosni.dev/i/secretTok");
    expect(container.textContent).toContain("Anyone who opens this link gets access. The first person to sign up keeps it.");
  });

  it("closing and reopening the dialog does not resurface a previous invite URL", async () => {
    createInviteMock.mockImplementation(async () =>
      jsonResponse({ url: "https://auth.mosni.dev/i/firstTok", expiresAt: "x", sub: "link:1" }, 201),
    );

    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    const inviteButton = () =>
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Invite someone"))!;
    await act(async () => {
      inviteButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect((container.querySelector(".copy-field-primary input") as HTMLInputElement).value).toContain("firstTok");

    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open={false} onClose={vi.fn()} />);
    });
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    expect(container.querySelector(".copy-field-primary input")).toBeNull();
  });

  // E7-QA1 §C2/F7: the same self-close hazard as FileBrowser's Delete/Move modals - a real mosni-modal can
  // close itself (backdrop/ESC/its own control), leaving React's `open` prop stuck true. React serialises
  // `open={true}` as an empty-string `open` attribute and `open={false}` as no attribute at all (verified
  // against this exact custom-element declaration), so `hasAttribute("open")` is the DOM-level ground
  // truth here, independent of jsdom's lack of a real MosniModal. Proven red-then-green: reverting
  // ShareDialog's `ref={modalRef}` wiring makes this fail, since nothing listens for the dispatched event.
  it("reopens after closing itself (dispatching `close` on the element, F7)", async () => {
    const onClose = vi.fn();
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={onClose} />);
    });
    await flush();
    const modal = container.querySelector("mosni-modal")!;
    expect(modal.hasAttribute("open")).toBe(true);

    await act(async () => {
      modal.dispatchEvent(new Event("close"));
      await flush();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The parent (FileBrowser/PreviewCard) reacts to onClose by setting its own `open` state false, then
    // true again on the next click - simulated here directly.
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open={false} onClose={onClose} />);
    });
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={onClose} />);
    });
    await flush();
    expect(container.querySelector("mosni-modal")!.hasAttribute("open")).toBe(true);
  });

  // H7 (working-conventions.md §8): a wrapper around a mosni-* element must force a re-render with
  // unchanged props and re-assert - the element still present, still populated, still sized.
  it("H7: a second render with unchanged props leaves the modal element present and populated", async () => {
    const props = { type: "file" as const, id: "f1", objectLabel: "photo.jpg", open: true, onClose: vi.fn() };
    act(() => {
      root.render(<ShareDialog {...props} />);
    });
    await flush();
    act(() => {
      root.render(<ShareDialog {...props} />);
    });
    await flush();
    const modal = container.querySelector("mosni-modal");
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute("heading")).toBe('Share "photo.jpg"');
    expect(container.textContent).toContain("Alice");
  });
});
