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

function deliverFiles(id: string, files: File[]) {
  messageListeners.forEach((cb) => cb({ data: { type: "share-target-files", id, files } } as MessageEvent));
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("share-target handoff (E6 Wave G6)", () => {
  beforeEach(() => {
    startBatchMock.mockClear();
    postMessage.mockClear();
    messageListeners = [];
    window.history.replaceState(null, "", "/?share-target=share-1");
  });

  afterEach(() => {
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

  it("never uploads for a signed-in user without files:write", async () => {
    const sdk = installSdk();
    installServiceWorker();

    initShareTarget();
    sdk.signIn([]);
    await flush();

    expect(postMessage).not.toHaveBeenCalled();
    expect(startBatchMock).not.toHaveBeenCalled();
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
