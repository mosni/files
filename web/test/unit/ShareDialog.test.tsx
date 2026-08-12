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
  shareable: true,
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

  it("the refusal state names the current level and renders no picker", async () => {
    fetchShareStateMock.mockImplementation(async () =>
      jsonResponse({ ...SHAREABLE_STATE, effectiveProtection: "unlisted", shareable: false }),
    );
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    expect(container.textContent).toContain("unlisted");
    expect(container.textContent).toContain("Only private files can be shared");
    expect(container.querySelector("#share-picker-filter-f1")).toBeNull();
    expect(fetchAccountsMock).not.toHaveBeenCalled();
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
