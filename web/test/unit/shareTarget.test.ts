// E6 Wave G6 (D-178), the auth-timing rewrite of 2026-08-06. Every case here failed against the original
// module-scope version, which acted on the auth SDK's first answer - `null` on a cold PWA start - and in
// doing so destroyed the shared payload three different ways before the session could arrive.
//
// This is the only automated coverage the share target has: an Android share sheet cannot be driven from
// any tier this project owns. The timing it encodes (SDK reports null, then the real user a beat later) is
// mosni/auth's real cold-start behaviour - `currentToken` comes from sessionStorage, which a freshly
// launched PWA does not have, so the SDK notifies "signed out" and only then runs its hidden same-site
// prompt=none check (auth's D-100).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startBatchMock } = vi.hoisted(() => ({ startBatchMock: vi.fn() }));
vi.mock("../../src/lib/uploads.ts", () => ({ startBatch: startBatchMock }));

import { initShareTarget } from "../../src/lib/shareTarget.ts";

type Listener = (user: unknown) => void;

function installSdk() {
  const listeners: Listener[] = [];
  let user: unknown = null;
  (window as unknown as { mosni: unknown }).mosni = {
    user: () => user,
    token: () => (user === null ? null : "tok"),
    onChange: (cb: Listener) => {
      listeners.push(cb);
      cb(user); // the real SDK notifies immediately with its CURRENT state, which starts as null
    },
    login: vi.fn(),
    logout: vi.fn(),
    toast: vi.fn(),
  };
  return {
    signIn(roles: string[] = ["files:write"]) {
      user = { sub: "user:1", roles };
      listeners.forEach((cb) => cb(user));
    },
  };
}

const postMessage = vi.fn();
let messageListeners: ((event: MessageEvent) => void)[] = [];

function installServiceWorker({ controlled = true }: { controlled?: boolean } = {}) {
  const worker = { postMessage };
  (navigator as unknown as { serviceWorker: unknown }).serviceWorker = {
    controller: controlled ? worker : null,
    ready: Promise.resolve({ active: worker }),
    addEventListener: (_t: string, cb: (event: MessageEvent) => void) => messageListeners.push(cb),
    removeEventListener: (_t: string, cb: (event: MessageEvent) => void) => {
      messageListeners = messageListeners.filter((l) => l !== cb);
    },
    register: vi.fn(),
  };
}

// Review 060/BUG-7: eligibility is the SERVER's answer now (GET /api/browse's `canUpload`), not a
// client-side role check - so every case here needs that call stubbed. Defaults to "yes", because the
// interesting timing this file exists to pin is the AUTH cold start, not the permission answer.
let canUploadResponse = true;

function installBrowseFetch() {
  canUploadResponse = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("/api/browse")) {
        return new Response(JSON.stringify({ canUpload: canUploadResponse }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function deliverFiles(id: string, files: File[]) {
  messageListeners.forEach((cb) => cb({ data: { type: "share-target-files", id, files } } as MessageEvent));
}

async function flush() {
  // Widened from 5 to 20 ticks: the eligibility fetch and its .json() add real microtask depth ahead of
  // the claim (review 060/BUG-7).
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("share-target handoff (E6 Wave G6)", () => {
  beforeEach(() => {
    startBatchMock.mockClear();
    postMessage.mockClear();
    messageListeners = [];
    installBrowseFetch();
    window.history.replaceState(null, "", "/?share-target=share-1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { mosni?: unknown }).mosni;
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    window.history.replaceState(null, "", "/");
  });

  it("does not claim, upload or strip the URL while the SDK still reports signed out", async () => {
    installSdk();
    installServiceWorker();

    initShareTarget();
    await flush();

    // All three of these were the original version's failure modes, in one assertion block.
    expect(postMessage).not.toHaveBeenCalled();
    expect(startBatchMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?share-target=share-1");
  });

  it("claims and uploads once the session resolves a beat later (the cold-start PWA case)", async () => {
    const sdk = installSdk();
    installServiceWorker();

    initShareTarget();
    await flush();
    sdk.signIn();
    await flush();

    expect(postMessage).toHaveBeenCalledWith({ type: "share-target-claim", id: "share-1" });
    const shared = new File(["x"], "shared.jpg", { type: "image/jpeg" });
    deliverFiles("share-1", [shared]);
    await flush();

    expect(startBatchMock).toHaveBeenCalledTimes(1);
    expect(startBatchMock.mock.calls[0][0]).toEqual([shared]);
    expect(startBatchMock.mock.calls[0][1]).toEqual({ destinationCollectionId: null, source: "share-target" });
    expect(window.location.search).toBe("");
  });

  // Review 060/BUG-7. This used to assert on `files:write` specifically, which is the pre-D-196 role
  // guess DropZone.tsx was rewritten to stop making - a can_upload-only invitee failed it and lost their
  // file. The gate is now the server's `canUpload`, and crucially the refusal is NON-DESTRUCTIVE: nothing
  // is claimed (a claim deletes the IndexedDB entry) and the parameter stays on the URL, so the share
  // survives a reload or a sign-in as an account that does have access.
  it("does not claim, and leaves the share recoverable, when the server says this viewer cannot upload", async () => {
    const sdk = installSdk();
    installServiceWorker();
    canUploadResponse = false;

    initShareTarget();
    sdk.signIn([]);
    await flush();

    expect(postMessage).not.toHaveBeenCalled();
    expect(startBatchMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?share-target=share-1");
  });

  it("uploads for a signed-in viewer with no files:write role when the server allows it (D-196/BUG-7)", async () => {
    const sdk = installSdk();
    installServiceWorker();

    initShareTarget();
    sdk.signIn([]); // no roles at all - an invite-bound account holding only a can_upload grant
    await flush();

    expect(postMessage).toHaveBeenCalledWith({ type: "share-target-claim", id: "share-1" });
    const shared = new File(["x"], "shared.jpg", { type: "image/jpeg" });
    deliverFiles("share-1", [shared]);
    await flush();

    expect(startBatchMock).toHaveBeenCalledTimes(1);
  });

  it("claims exactly once even though the SDK notifies repeatedly", async () => {
    const sdk = installSdk();
    installServiceWorker();

    initShareTarget();
    sdk.signIn();
    sdk.signIn();
    await flush();

    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("uses the active registration when no worker is controlling the page yet", async () => {
    const sdk = installSdk();
    installServiceWorker({ controlled: false });

    initShareTarget();
    sdk.signIn();
    await flush();

    expect(postMessage).toHaveBeenCalledWith({ type: "share-target-claim", id: "share-1" });
  });

  it("does nothing at all on an ordinary page load", async () => {
    window.history.replaceState(null, "", "/");
    installSdk();
    installServiceWorker();

    initShareTarget();
    await flush();

    expect(postMessage).not.toHaveBeenCalled();
    expect(startBatchMock).not.toHaveBeenCalled();
  });

  it("still clears the parameter when the worker hands back nothing", async () => {
    const sdk = installSdk();
    installServiceWorker();

    initShareTarget();
    sdk.signIn();
    await flush();
    deliverFiles("share-1", []);
    await flush();

    expect(startBatchMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });
});
