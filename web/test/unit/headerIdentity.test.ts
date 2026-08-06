// Live-testing addition (2026-08-06): <mosni-header>'s right-side tagline slot shows "Logged in as
// [avatar] [name]" once signed in. initHeaderIdentity() cannot rely on the normal slot mechanism (see the
// module's own comment - mosni-chrome renders a slot exactly once, before auth state is known), so this
// exercises the DOM it writes into directly, the same shape shareTarget.test.ts uses for window.mosni.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initHeaderIdentity } from "../../src/lib/headerIdentity.ts";

type Listener = (user: unknown) => void;

function installSdk() {
  const listeners: Listener[] = [];
  let user: unknown = null;
  (window as unknown as { mosni: unknown }).mosni = {
    user: () => user,
    token: () => (user === null ? null : "tok"),
    onChange: (cb: Listener) => {
      listeners.push(cb);
      cb(user);
    },
    login: () => {},
    logout: () => {},
    toast: () => {},
  };
  return {
    signIn(claims: Record<string, unknown> = {}) {
      user = { sub: "google:123", ...claims };
      listeners.forEach((cb) => cb(user));
    },
    signOut() {
      user = null;
      listeners.forEach((cb) => cb(null));
    },
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("initHeaderIdentity (live-testing addition, 2026-08-06)", () => {
  beforeEach(() => {
    document.body.innerHTML = '<mosni-header><div class="little-link"></div></mosni-header>';
    delete (window as unknown as { mosni?: unknown }).mosni;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does nothing until window.mosni exists, then reflects signed-out as empty", async () => {
    initHeaderIdentity();
    const target = document.querySelector(".little-link")!;
    expect(target.textContent).toBe("");

    installSdk();
    await flush();
    // Signed out (the SDK's initial `null` notification) - the slot stays exactly as empty as it started.
    expect(target.textContent).toBe("");
  });

  it("shows the avatar and the captured name once signed in", async () => {
    const sdk = installSdk();
    initHeaderIdentity();
    await flush();

    sdk.signIn({ name: "Hannah" });
    await flush();

    const target = document.querySelector(".little-link")!;
    expect(target.textContent).toBe("Logged in as Hannah");
    const img = target.querySelector("img")!;
    expect(img.src).toBe("https://auth.mosni.dev/avatar/google%3A123");
  });

  it("falls back to the sub when no name claim is present (D-168's rule)", async () => {
    const sdk = installSdk();
    initHeaderIdentity();
    await flush();

    sdk.signIn();
    await flush();

    const target = document.querySelector(".little-link")!;
    expect(target.textContent).toBe("Logged in as google:123");
  });

  it("clears back to empty on sign-out", async () => {
    const sdk = installSdk();
    initHeaderIdentity();
    await flush();

    sdk.signIn({ name: "Hannah" });
    await flush();
    sdk.signOut();
    await flush();

    const target = document.querySelector(".little-link")!;
    expect(target.textContent).toBe("");
  });

  it("removes the avatar image on a load failure instead of leaving a broken icon", async () => {
    const sdk = installSdk();
    initHeaderIdentity();
    await flush();
    sdk.signIn({ name: "Hannah" });
    await flush();

    const target = document.querySelector(".little-link")!;
    const img = target.querySelector("img")!;
    img.dispatchEvent(new Event("error"));

    expect(target.querySelector("img")).toBeNull();
    expect(target.textContent).toBe("Logged in as Hannah");
  });

  it("is a no-op when <mosni-header> has no .little-link (never throws into main.tsx's render path)", () => {
    document.body.innerHTML = "";
    expect(() => initHeaderIdentity()).not.toThrow();
  });
});
