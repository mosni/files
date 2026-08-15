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
import { INVITE_DURATION_STOPS } from "../../../app/src/lib/inviteDuration.ts";

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

// F4/F13: <mosni-switch> is an inert, unregistered custom element in jsdom - it never builds its own
// internal checkbox, so there is nothing to `.click()`. This reproduces exactly the contract
// lib/switchChange.ts's useSwitchChange hook relies on (see its own header comment): flip the host's OWN
// `checked` attribute, then dispatch a plain, bubbling `change` - the same order a real mosni-switch
// leaves things in by the time its bubble phase reaches an ancestor listener.
function toggleMosniSwitch(el: Element): void {
  el.toggleAttribute("checked", !el.hasAttribute("checked"));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// E7-QA2 §B5: mosni-slider mirrors mosni-switch's reflect-then-bubble contract (D-207 - see
// toggleMosniSwitch's comment above and sliderChange.ts's header). jsdom never registers the element so
// there is nothing real to drive; this fixture reproduces the contract by hand: set the host's own
// `value` attribute to the chosen stop INDEX, then dispatch a plain, bubbling `change`.
function setMosniSlider(el: Element, index: number): void {
  el.setAttribute("value", String(index));
  el.dispatchEvent(new Event("change", { bubbles: true }));
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
      .mockImplementation(async () =>
        // E7-QA2 §B5 warning: "x" is not a parseable date - B4 now RENDERS expiresAt, so a junk default
        // would make every test that doesn't override this mock assert against an "Invalid Date" rendering
        // bug rather than the feature. A real ISO timestamp keeps that surface honest by default.
        jsonResponse({ url: "https://auth.mosni.dev/i/default", expiresAt: "2026-08-13T00:00:00.000Z", sub: "link:x" }, 201),
      );
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

  // F5: mosni-chrome's `.field` class only supplies the label-to-input gap when the label itself carries
  // `.field-label` (confirmed by reading the served mosnicat.js CSS directly) - ProtectionControl.tsx
  // already gets this right, this label was just missing the class, and Hannah saw the two sit flush.
  it("the 'Add people' label carries mosni-chrome's field-label class for its own spacing", async () => {
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();

    const label = Array.from(container.querySelectorAll("label")).find((l) => l.textContent === "Add people");
    expect(label?.className).toBe("field-label");
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

  it("collection grants pass the canUpload switch state", async () => {
    fetchShareStateMock.mockImplementation(async () => jsonResponse({ ...SHAREABLE_STATE, type: "collection", id: "c1" }));
    grantShareMock.mockImplementation(async () => jsonResponse({ ...SHAREABLE_STATE, type: "collection", id: "c1" }));
    act(() => {
      root.render(<ShareDialog type="collection" id="c1" objectLabel="Vacation" open onClose={vi.fn()} />);
    });
    await flush();

    const canUploadSwitch = container.querySelector("mosni-switch")!;
    await act(async () => {
      toggleMosniSwitch(canUploadSwitch);
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
    const allowRegisterSwitch = container.querySelector("mosni-switch")!;
    expect(allowRegisterSwitch.hasAttribute("checked")).toBe(true);
    expect(container.textContent).not.toContain("Everyone who opens this link shares one identity");

    const inviteButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Invite someone without an account"),
    )!;
    await act(async () => {
      inviteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect(createInviteMock).toHaveBeenCalledWith("file", "f1", undefined, true, 3600);
  });

  it("turning the switch off shows D-23's consequence line and sends allowRegister: false", async () => {
    act(() => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
    });
    await flush();
    const allowRegisterSwitch = container.querySelector("mosni-switch")!;
    await act(async () => {
      toggleMosniSwitch(allowRegisterSwitch);
      await flush();
    });
    expect(container.textContent).toContain("Everyone who opens this link shares one identity");
    // D-208: the lifetime moved out of this sentence into the always-visible duration sentence below.
    expect(container.textContent).not.toContain("The link dies after at most 24 hours");
    expect(container.textContent).toContain("This link expires after 1 hour.");

    const inviteButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Invite someone without an account"),
    )!;
    await act(async () => {
      inviteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect(createInviteMock).toHaveBeenCalledWith("file", "f1", undefined, false, 3600);
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

  // E7-QA2 §B5 (D-203..D-208): the invite duration slider.
  describe("invite duration slider (E7-QA2)", () => {
    it("defaults to 1 hour and sends ttlSeconds 3600 without touching the slider", async () => {
      act(() => {
        root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
      });
      await flush();

      const slider = container.querySelector("mosni-slider")!;
      expect(slider.getAttribute("value")).toBe("1");

      const inviteButton = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Invite someone without an account"),
      )!;
      await act(async () => {
        inviteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();
      });
      expect(createInviteMock).toHaveBeenCalledWith("file", "f1", undefined, true, 3600);
    });

    it("moving the slider to the last stop sends 7776000", async () => {
      act(() => {
        root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
      });
      await flush();

      const slider = container.querySelector("mosni-slider")!;
      await act(async () => {
        setMosniSlider(slider, INVITE_DURATION_STOPS.length - 1);
        await flush();
      });

      const inviteButton = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Invite someone without an account"),
      )!;
      await act(async () => {
        inviteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();
      });
      expect(createInviteMock).toHaveBeenCalledWith("file", "f1", undefined, true, 7776000);
    });

    it("the duration sentence renders with the switch ON - the case that said nothing today", async () => {
      act(() => {
        root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
      });
      await flush();
      const allowRegisterSwitch = container.querySelector("mosni-switch")!;
      expect(allowRegisterSwitch.hasAttribute("checked")).toBe(true);
      expect(container.textContent).toContain("This link expires after 1 hour.");
    });

    it("the duration sentence names the SELECTED stop, not a hardcoded 24 hours", async () => {
      act(() => {
        root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
      });
      await flush();

      const slider = container.querySelector("mosni-slider")!;
      const sixHoursIndex = INVITE_DURATION_STOPS.findIndex((stop) => stop.label === "6 hours");
      await act(async () => {
        setMosniSlider(slider, sixHoursIndex);
        await flush();
      });

      expect(container.textContent).toContain("This link expires after 6 hours.");
      expect(container.textContent).not.toContain("24 hours");
    });

    it("the shared-identity sentence still appears only when the switch is off (D-23 unchanged)", async () => {
      act(() => {
        root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open onClose={vi.fn()} />);
      });
      await flush();
      expect(container.textContent).not.toContain("Everyone who opens this link shares one identity");

      const allowRegisterSwitch = container.querySelector("mosni-switch")!;
      await act(async () => {
        toggleMosniSwitch(allowRegisterSwitch);
        await flush();
      });
      expect(container.textContent).toContain("Everyone who opens this link shares one identity");
    });

    it("the minted panel shows the expiry the server returned", async () => {
      const minted: InviteMinted = {
        url: "https://auth.mosni.dev/i/expTok",
        expiresAt: "2026-09-01T12:00:00.000Z",
        sub: "link:exp",
      };
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

      expect(container.textContent).toContain(new Date(minted.expiresAt).toLocaleString());
    });
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
